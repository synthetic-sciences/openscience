import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SubtaskAttachments } from "../../src/session/subtask-attachments"
import { tmpdir, trustProject } from "../fixture/fixture"
import { STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

async function run(url: string, token: string | undefined, agent = "research", args: string[] = []) {
  await using tmp = await tmpdir()
  const child = Bun.spawn(
    [
      process.execPath,
      path.resolve(import.meta.dir, "../../src/index.ts"),
      "run",
      "--attach",
      url,
      "--agent",
      agent,
      ...args,
      "--format",
      "json",
      "Respond to this fixture",
    ],
    {
      cwd: tmp.path,
      env: {
        ...process.env,
        OPENSCIENCE_AUTH_TOKEN: token,
        OPENSCIENCE_TEST_HOME: tmp.path,
        OPENSCIENCE_CONFIG_DIR: path.join(tmp.path, "config"),
        OPENSCIENCE_DATA_DIR: path.join(tmp.path, "data"),
        XDG_CACHE_HOME: path.join(tmp.path, "cache"),
        XDG_STATE_HOME: path.join(tmp.path, "state"),
        OPENSCIENCE_DISABLE_MODELS_FETCH: "true",
        OPENSCIENCE_DISABLE_DEFAULT_PLUGINS: "true",
        OPENSCIENCE_DISABLE_BUNDLED_SKILLS: "true",
        OPENSCIENCE_DISABLE_CLAUDE_CODE: "true",
        OPENSCIENCE_API_BASE: "http://127.0.0.1:9",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  const watchdog = setTimeout(() => child.kill(), 10_000)
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    return { code, stdout, stderr }
  } finally {
    clearTimeout(watchdog)
    if (child.exitCode === null) child.kill()
    await child.exited
  }
}

test("attached CLI authenticates, resolves server agents, and uploads command files from the client", async () => {
  const previous = process.env.OPENSCIENCE_AUTH_TOKEN
  const token = "run-attach-dummy-token"
  process.env.OPENSCIENCE_AUTH_TOKEN = token
  const providerRequests: unknown[] = []
  using provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      providerRequests.push(await request.json())
      const events = [
        { choices: [{ index: 0, delta: { role: "assistant", content: "ATTACHED_RESPONSE" }, finish_reason: null }] },
        {
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 },
        },
      ]
        .map(
          (value) =>
            `data: ${JSON.stringify({ id: "chatcmpl-attach", object: "chat.completion.chunk", created: 1, model: STRESS_PROVIDER_MODEL, ...value })}\n\n`,
        )
        .join("")
      return new Response(events + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } })
    },
  })
  const config = stressProviderConfig(`${provider.url.origin}/v1`)
  await using project = await tmpdir({
    git: true,
    config: {
      ...config,
      command: { inspect: { template: "Inspect the supplied attachment", subtask: false } },
      agent: { title: { disable: true }, "server-only": { mode: "primary", prompt: "Reply to the attached client." } },
      provider: {
        ...config.provider,
        stress: {
          ...config.provider.stress,
          models: {
            ...config.provider.stress.models,
            [STRESS_PROVIDER_MODEL]: {
              ...config.provider.stress.models[STRESS_PROVIDER_MODEL],
              modalities: { input: ["text", "image"], output: ["text"] },
            },
          },
        },
      },
    },
  })
  try {
    await Instance.provide({
      directory: project.path,
      init: trustProject,
      fn: async () => {
        const requests: Array<{ path: string; authorization: string | null; status: number; body: unknown }> = []
        using server = Bun.serve({
          hostname: "127.0.0.1",
          port: 0,
          async fetch(request) {
            // This server hosts the fixture project; the child has no local project configuration.
            request.headers.set("x-openscience-directory", project.path)
            const body = request.method === "POST" ? await request.clone().json() : undefined
            const response = await Server.App().fetch(request)
            requests.push({
              path: new URL(request.url).pathname,
              authorization: request.headers.get("authorization"),
              status: response.status,
              body,
            })
            return response
          },
        })
        for (const agent of ["research", "server-only"]) {
          const result = await run(server.url.origin, token, agent)
          expect(result.code, result.stderr).toBe(0)
          expect(result.stdout).toContain("ATTACHED_RESPONSE")
          expect(result.stdout + result.stderr).not.toContain(token)
          const sessions = await Array.fromAsync(Session.list())
          const messages = await Session.messages({ sessionID: sessions[0]!.id })
          expect(messages.find((message) => message.info.role === "user")?.info.agent).toBe(agent)
        }
        expect(providerRequests).toHaveLength(2)
        expect(requests.some((request) => request.path === "/agent" && request.status === 200)).toBe(true)
        expect(requests.every((request) => request.authorization === `Bearer ${token}`)).toBe(true)

        await using client = await tmpdir()
        const name = "測定 #100%?.json"
        const text = '{"measurement":42,"unit":"µm"}'
        const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII="
        await Bun.write(path.join(client.path, name), text)
        // Magic bytes take precedence over the misleading filename extension.
        await Bun.write(path.join(client.path, "plot.jpg"), Buffer.from(image, "base64"))
        const uploaded = await run(server.url.origin, token, "research", [
          "--command",
          "inspect",
          "--file",
          path.join(client.path, name),
          path.join(client.path, "plot.jpg"),
          "--effort",
          "ultra",
        ])
        expect(uploaded.code, uploaded.stderr).toBe(0)
        expect(uploaded.stdout).toContain("ATTACHED_RESPONSE")
        expect(requests.find((request) => request.path.endsWith("/command"))?.body).toEqual(
          expect.objectContaining({
            effort: "ultra",
            parts: [
              {
                type: "file",
                filename: name,
                mime: "text/plain",
                url: `data:text/plain;base64,${Buffer.from(text).toString("base64")}`,
              },
              { type: "file", filename: "plot.jpg", mime: "image/png", url: `data:image/png;base64,${image}` },
            ],
          }),
        )
        const uploadedSession = (await Array.fromAsync(Session.list()))[0]!
        const messages = await Session.messages({ sessionID: uploadedSession.id })
        const user = messages.find((message) => message.info.role === "user")
        expect(user?.info.role === "user" && user.info.effort).toBe("ultra")
        expect(user?.parts.some((part) => part.type === "text" && part.text === text)).toBe(true)
        expect(JSON.stringify(providerRequests.at(-1))).toContain("measurement")
        expect(JSON.stringify(providerRequests.at(-1))).toContain(`data:image/png;base64,${image}`)
        expect(JSON.stringify(providerRequests.at(-1))).not.toContain(client.path)
        expect(providerRequests).toHaveLength(3)

        for (const supplied of [undefined, "wrong-dummy-token"]) {
          const result = await run(server.url.origin, supplied)
          expect(result.code).toBe(1)
          expect(result.stderr).toContain("The server rejected authentication")
          expect(result.stdout + result.stderr).not.toContain(token)
          expect(result.stdout + result.stderr).not.toContain("wrong-dummy-token")
          expect(requests.at(-1)?.status).toBe(401)
        }
        expect(providerRequests).toHaveLength(3)
      },
    })
  } finally {
    await Instance.disposeAll()
    if (previous === undefined) delete process.env.OPENSCIENCE_AUTH_TOKEN
    else process.env.OPENSCIENCE_AUTH_TOKEN = previous
  }
}, 30_000)

test("attached CLI rejects directories and byte-limit violations before contacting the server", async () => {
  const requests: string[] = []
  using server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      requests.push(request.url)
      return new Response("Unexpected dispatch", { status: 500 })
    },
  })
  await using client = await tmpdir()
  for (const [name, size] of [
    ["oversize.bin", SubtaskAttachments.LIMIT + 1],
    ["first.bin", SubtaskAttachments.LIMIT / 2 + 1],
    ["second.bin", SubtaskAttachments.LIMIT / 2],
  ] as const) {
    const file = await fs.open(path.join(client.path, name), "w")
    await file.truncate(size)
    await file.close()
  }
  for (const fixture of [
    { files: [client.path], error: "Upload individual files instead of a directory" },
    { files: [path.join(client.path, "oversize.bin")], error: "32 MiB byte limit" },
    { files: [path.join(client.path, "first.bin"), path.join(client.path, "second.bin")], error: "32 MiB byte limit" },
  ]) {
    const result = await run(server.url.origin, undefined, "research", [
      "--command",
      "inspect",
      "--file",
      ...fixture.files,
    ])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain(fixture.error)
    expect(requests).toEqual([])
  }
}, 30_000)

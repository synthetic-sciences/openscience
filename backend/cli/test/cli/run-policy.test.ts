import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { createOpenScienceClient } from "@synsci/sdk/v2"
import { Instance } from "../../src/project/instance"
import { PermissionNext } from "../../src/permission/next"
import { Provider } from "../../src/provider/provider"
import { Server } from "../../src/server/server"
import { execute, session, type RunInput } from "../../src/cli/cmd/run"
import { RunEvents } from "../../src/cli/run-events"
import { Log } from "../../src/util/log"
import { tmpdir, trustProject } from "../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

Log.init({ print: false })

const MODEL = `${STRESS_PROVIDER_ID}/${STRESS_PROVIDER_MODEL}`

type ChatRequest = { messages?: unknown; tools?: unknown }

function textFrom(value: unknown): string {
  if (typeof value === "string") return value
  if (Array.isArray(value)) return value.map(textFrom).join("\n")
  if (!value || typeof value !== "object") return ""
  return Object.values(value).map(textFrom).join("\n")
}

function hasToolResult(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasToolResult)
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  if (record.role === "tool" || record.type === "tool-result") return true
  return Object.values(record).some(hasToolResult)
}

function chunk(delta: Record<string, unknown>, finish: string | null) {
  return {
    id: "chatcmpl-run",
    object: "chat.completion.chunk",
    created: 1,
    model: STRESS_PROVIDER_MODEL,
    choices: [{ index: 0, delta: finish ? {} : delta, finish_reason: finish }],
    ...(finish ? { usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } } : {}),
  }
}

function sse(events: ReturnType<typeof chunk>[]) {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
  return new Response(`${body}data: [DONE]\n\n`, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  })
}

function text(reply: string, reasoning?: string) {
  return sse([
    ...(reasoning ? [chunk({ role: "assistant", reasoning_content: reasoning }, null)] : []),
    chunk({ role: "assistant", content: reply }, null),
    chunk({}, "stop"),
  ])
}

function call(name: string, args: Record<string, unknown>) {
  return sse([
    chunk(
      {
        role: "assistant",
        tool_calls: [
          { index: 0, id: `call_${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } },
        ],
      },
      null,
    ),
    chunk({}, "tool_calls"),
  ])
}

/**
 * A deterministic OpenAI-compatible provider. Requests carrying a tool
 * schema are the agent turn; everything else (titles, summaries) gets a
 * plain reply so background work never blocks the test.
 */
function provider(options: { secret: string; hold?: () => Promise<void> }) {
  const requests: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 })
      const body = (await request.json()) as ChatRequest
      const prompt = textFrom(body.messages)
      const main = Array.isArray(body.tools) && body.tools.length > 0
      if (!main) return text("Background reply")
      requests.push(prompt)
      const done = hasToolResult(body.messages)
      if (prompt.includes("RUN_READ")) {
        return done ? text("RUN_READ_DONE") : call("read", { filePath: options.secret })
      }
      if (prompt.includes("RUN_QUESTION")) {
        return done
          ? text("RUN_QUESTION_DONE")
          : call("question", {
              reason: "consequential",
              questions: [
                {
                  header: "Choice",
                  question: "Continue?",
                  options: [
                    { label: "Yes (Recommended)", description: "Go on" },
                    { label: "No", description: "Stop" },
                  ],
                },
              ],
            })
      }
      if (prompt.includes("RUN_HOLD")) await options.hold?.()
      return text("RUN_TEXT_DONE", "Thinking about the request.")
    },
  })
  return { server, requests, baseURL: `http://127.0.0.1:${server.port}/v1` }
}

function sink() {
  const lines: string[] = []
  return {
    write(text: string) {
      lines.push(...text.split("\n").filter(Boolean))
      return true
    },
    events() {
      return lines.map((line) => RunEvents.Event.parse(JSON.parse(line)))
    },
  }
}

// The server resolves the project from the request, so the client must name
// the fixture directory the same way `run` names its cwd.
const sdk = (directory: string) =>
  createOpenScienceClient({ baseUrl: "http://openscience.internal", fetch: Server.internalFetch(), directory })

function run(input: Partial<RunInput> & Pick<RunInput, "sdk" | "sessionID" | "message" | "policy">) {
  const out = sink()
  const code = execute({
    files: [],
    model: MODEL,
    effort: "normal",
    bare: false,
    format: "json",
    stdout: out,
    ...input,
  })
  return { out, code }
}

const servers: Bun.Server<unknown>[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop(true)))
})

describe("openscience run policy loop", () => {
  test("streams user, reasoning, text, step and done events and exits 0", async () => {
    const stub = provider({ secret: "" })
    servers.push(stub.server)
    await using tmp = await tmpdir({ git: true, config: stressProviderConfig(stub.baseURL) })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await trustProject()
        await Provider.invalidate()
      },
      fn: async () => {
        const client = sdk(tmp.path)
        const sessionID = await session(client, { message: "RUN_TEXT please" })
        expect(sessionID).toBeDefined()
        const created = await client.session.get({ sessionID: sessionID! })
        expect(created.data?.permission).toEqual([{ permission: "question", pattern: "*", action: "deny" }])

        const { out, code } = run({ sdk: client, sessionID: sessionID!, message: "RUN_TEXT please", policy: "allow" })
        expect(await code).toBe(0)

        const events = out.events()
        const types = events.map((event) => event.type)
        expect(types[0]).toBe("user")
        expect(types.at(-1)).toBe("done")
        expect(types).toContain("step_start")
        expect(types).toContain("reasoning")
        expect(types).toContain("text")
        expect(types).toContain("step_finish")
        expect(types).not.toContain("error")

        const user = events.find((event) => event.type === "user")
        expect(user?.type === "user" && user.parts).toEqual([{ type: "text", text: "RUN_TEXT please" }])
        const done = events.at(-1)
        expect(done?.type === "done" && done.status).toBe("completed")
        expect(done?.type === "done" && done.exitCode).toBe(0)
        expect(done?.type === "done" && done.tokens.input).toBe(10)
        expect(done?.type === "done" && done.tokens.output).toBe(4)
        for (const event of events) expect(event.sessionID).toBe(sessionID!)
        expect(stub.requests).toHaveLength(1)
      },
    })
  }, 20_000)

  test("auto-approve answers a permission request once and the tool completes", async () => {
    await using tmp = await tmpdir({ git: true })
    const secret = path.join(tmp.path, "secret.txt")
    await Bun.write(secret, "top secret\n")
    const stub = provider({ secret })
    servers.push(stub.server)
    await Bun.write(path.join(tmp.path, "openscience.json"), JSON.stringify(stressProviderConfig(stub.baseURL)))
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await trustProject()
        await Provider.invalidate()
      },
      fn: async () => {
        const client = sdk(tmp.path)
        const created = await client.session.create({
          permission: [{ permission: "read", pattern: "*secret.txt", action: "ask" }],
        })
        const sessionID = created.data!.id

        const { out, code } = run({ sdk: client, sessionID, message: "RUN_READ the secret", policy: "allow" })
        expect(await code).toBe(0)

        const events = out.events()
        const permission = events.find((event) => event.type === "permission")
        expect(permission?.type === "permission" && permission.reply).toBe("once")
        expect(permission?.type === "permission" && permission.request.permission).toBe("read")
        expect(permission?.type === "permission" && permission.request.sessionID).toBe(sessionID)
        const tool = events.find((event) => event.type === "tool_use")
        expect(tool?.type === "tool_use" && tool.part.state.status).toBe("completed")
        expect(events.at(-1)).toMatchObject({ type: "done", status: "completed", exitCode: 0 })
        expect(await PermissionNext.standing()).toEqual([])
        expect(stub.requests).toHaveLength(2)
      },
    })
  }, 20_000)

  test("deny-prompts rejects the request, reports the failed tool call, and exits 3", async () => {
    await using tmp = await tmpdir({ git: true })
    const secret = path.join(tmp.path, "secret.txt")
    await Bun.write(secret, "top secret\n")
    const stub = provider({ secret })
    servers.push(stub.server)
    await Bun.write(path.join(tmp.path, "openscience.json"), JSON.stringify(stressProviderConfig(stub.baseURL)))
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await trustProject()
        await Provider.invalidate()
      },
      fn: async () => {
        const client = sdk(tmp.path)
        const created = await client.session.create({
          permission: [{ permission: "read", pattern: "*secret.txt", action: "ask" }],
        })
        const sessionID = created.data!.id

        const { out, code } = run({ sdk: client, sessionID, message: "RUN_READ the secret", policy: "deny" })
        expect(await code).toBe(3)

        const events = out.events()
        const permission = events.find((event) => event.type === "permission")
        expect(permission?.type === "permission" && permission.reply).toBe("reject")
        const tool = events.find((event) => event.type === "tool_use")
        expect(tool?.type === "tool_use" && tool.part.state.status).toBe("error")
        expect(events.at(-1)).toMatchObject({ type: "done", status: "rejected", exitCode: 3 })
        expect(stub.requests).toHaveLength(1)
      },
    })
  }, 20_000)

  test("a stray question is rejected instead of hanging the run", async () => {
    const stub = provider({ secret: "" })
    servers.push(stub.server)
    await using tmp = await tmpdir({ git: true, config: stressProviderConfig(stub.baseURL) })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await trustProject()
        await Provider.invalidate()
      },
      fn: async () => {
        const client = sdk(tmp.path)
        // No question rule on purpose: the tool is offered and the model asks.
        const sessionID = (await client.session.create({})).data!.id
        const { out, code } = run({ sdk: client, sessionID, message: "RUN_QUESTION now", policy: "allow" })
        expect(await code).toBe(3)
        const tool = out.events().find((event) => event.type === "tool_use")
        expect(tool?.type === "tool_use" && tool.part.tool).toBe("question")
        expect(tool?.type === "tool_use" && tool.part.state.status).toBe("error")
        expect(out.events().at(-1)).toMatchObject({ type: "done", status: "rejected", exitCode: 3 })
      },
    })
  }, 20_000)

  test("answers permission requests from descendant sessions and ignores unrelated ones", async () => {
    const gate = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const stub = provider({
      secret: "",
      hold: async () => {
        gate.resolve()
        await release.promise
      },
    })
    servers.push(stub.server)
    await using tmp = await tmpdir({ git: true, config: stressProviderConfig(stub.baseURL) })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await trustProject()
        await Provider.invalidate()
      },
      fn: async () => {
        const client = sdk(tmp.path)
        const root = (await client.session.create({})).data!.id
        const child = (await client.session.create({ parentID: root })).data!.id
        const grandchild = (await client.session.create({ parentID: child })).data!.id
        const stranger = (await client.session.create({})).data!.id

        const { out, code } = run({ sdk: client, sessionID: root, message: "RUN_HOLD", policy: "allow" })
        await gate.promise

        const ask = (sessionID: string) =>
          PermissionNext.ask({
            sessionID,
            permission: "read",
            patterns: ["/tmp/x"],
            always: [],
            metadata: {},
            ruleset: [],
          })
        await expect(ask(grandchild)).resolves.toBeUndefined()
        const foreign = ask(stranger)
        await Bun.sleep(100)
        expect((await PermissionNext.list()).map((item) => item.sessionID)).toEqual([stranger])
        release.resolve()
        expect(await code).toBe(0)

        const permission = out.events().find((event) => event.type === "permission")
        expect(permission?.type === "permission" && permission.request.sessionID).toBe(grandchild)
        expect(permission?.type === "permission" && permission.reply).toBe("once")

        const pending = await PermissionNext.list()
        await PermissionNext.reply({ requestID: pending[0].id, reply: "reject" })
        await expect(foreign).rejects.toBeInstanceOf(PermissionNext.RejectedError)
      },
    })
  }, 20_000)

  test("an unknown model is a usage error before any request is made", async () => {
    const stub = provider({ secret: "" })
    servers.push(stub.server)
    await using tmp = await tmpdir({ git: true, config: stressProviderConfig(stub.baseURL) })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await trustProject()
        await Provider.invalidate()
      },
      fn: async () => {
        const client = sdk(tmp.path)
        const sessionID = (await client.session.create({})).data!.id
        const { out, code } = run({
          sdk: client,
          sessionID,
          message: "RUN_TEXT",
          policy: "allow",
          model: `${STRESS_PROVIDER_ID}/does-not-exist`,
        })
        expect(await code).toBe(2)
        const events = out.events()
        expect(events.map((event) => event.type)).toEqual(["error", "done"])
        expect(events[0].type === "error" && String(events[0].error.data.message)).toContain("does-not-exist")
        expect(events.at(-1)).toMatchObject({ type: "done", status: "error", exitCode: 2 })
        expect(stub.requests).toHaveLength(0)
      },
    })
  })

  test("a prompt that fails before the loop exits 2 instead of waiting for idle", async () => {
    await using tmp = await tmpdir({ git: true, config: { enabled_providers: ["no-such-provider"] } })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await trustProject()
        await Provider.invalidate()
      },
      fn: async () => {
        const client = sdk(tmp.path)
        const sessionID = (await client.session.create({})).data!.id
        const { out, code } = run({ sdk: client, sessionID, message: "hello", policy: "deny", model: undefined })
        expect(await code).toBe(2)
        const events = out.events()
        const error = events.find((event) => event.type === "error")
        expect(error?.type === "error" && String(error.error.data.message)).toContain("No model providers")
        expect(events.at(-1)).toMatchObject({ type: "done", status: "error", exitCode: 2 })
      },
    })
  }, 20_000)
})

import { describe, expect, test } from "bun:test"
import {
  createUpdateCache,
  createUpdateInstaller,
  desktopUpdateBlockers,
  desktopUpdateShutdownAuthorized,
  isNewerVersion,
  supportsAutomaticUpdate,
  UpdatesSettingsRoutes,
} from "../../src/server/routes/settings/updates"
import { AuthoritySignal } from "../../src/project/authority-signal"
import { UpdateQuiescence } from "../../src/process/update-quiescence"

describe("update version ordering", () => {
  test("only reports a genuinely newer release", () => {
    expect(isNewerVersion("2.0.1", "2.0.2")).toBe(true)
    expect(isNewerVersion("2.0.2", "2.0.2")).toBe(false)
    expect(isNewerVersion("2.0.2-test.58.1", "2.0.1")).toBe(false)
    expect(isNewerVersion("local", "2.0.2")).toBe(false)
  })
})

describe("automatic update support", () => {
  test("reports every active runtime instead of collapsing the first blocker", () => {
    expect(desktopUpdateBlockers({ sessions: 1, compute: 2, pty: 1, kernel: 3, mcp: 1, admitted: 5 })).toEqual([
      "1 agent run",
      "2 compute jobs",
      "1 interactive terminal",
      "3 kernel executions",
      "1 MCP request",
    ])
    expect(desktopUpdateBlockers({ sessions: 0, compute: 0, pty: 0, kernel: 0, mcp: 0, admitted: 1 })).toEqual([
      "1 runtime transition",
    ])
  })

  test("accepts only the exact desktop capability token", () => {
    const token = "a".repeat(64)
    expect(desktopUpdateShutdownAuthorized(`Bearer ${token}`, token)).toBe(true)
    expect(desktopUpdateShutdownAuthorized(`Bearer ${token}x`, token)).toBe(false)
    expect(desktopUpdateShutdownAuthorized(token, token)).toBe(false)
    expect(desktopUpdateShutdownAuthorized(undefined, token)).toBe(false)
    expect(desktopUpdateShutdownAuthorized(`Bearer ${token}`, undefined)).toBe(false)
  })

  test("apply endpoint reports admitted terminals, kernels, and MCP work", async () => {
    const release = await AuthoritySignal.exclusive(async () => [
      UpdateQuiescence.enter("pty"),
      UpdateQuiescence.enter("kernel"),
      UpdateQuiescence.enter("mcp"),
    ])
    try {
      const response = await UpdatesSettingsRoutes().request("http://openscience.internal/apply", { method: "POST" })
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({
        error:
          "Finish active work before restarting OpenScience: 1 interactive terminal, 1 kernel execution, 1 MCP request.",
      })
    } finally {
      for (const done of release) done()
    }
  })

  test("a blocked restart retries Electron without scheduling a second update", async () => {
    const previousURL = process.env.OPENSCIENCE_DESKTOP_UPDATE_URL
    const previousToken = process.env.OPENSCIENCE_DESKTOP_UPDATE_TOKEN
    const token = "c".repeat(64)
    const actions: unknown[] = []
    const server = Bun.serve({
      port: 0,
      routes: {
        "/update": {
          GET: () => Response.json({ phase: "restart_blocked", version: "2.0.54", error: "runtime still draining" }),
          POST: async (request) => {
            actions.push(await request.json())
            return Response.json({ phase: "restarting", version: "2.0.54" }, { status: 202 })
          },
        },
      },
      fetch: () => new Response("not found", { status: 404 }),
    })
    process.env.OPENSCIENCE_DESKTOP_UPDATE_URL = new URL("/update", server.url).toString()
    process.env.OPENSCIENCE_DESKTOP_UPDATE_TOKEN = token
    try {
      const response = await UpdatesSettingsRoutes().request("http://openscience.internal/apply", { method: "POST" })
      expect(response.status).toBe(202)
      expect(await response.json()).toEqual({ phase: "restarting", version: "2.0.54" })
      expect(actions).toEqual([{ action: "apply", version: "2.0.54" }])
    } finally {
      server.stop(true)
      if (previousURL === undefined) delete process.env.OPENSCIENCE_DESKTOP_UPDATE_URL
      else process.env.OPENSCIENCE_DESKTOP_UPDATE_URL = previousURL
      if (previousToken === undefined) delete process.env.OPENSCIENCE_DESKTOP_UPDATE_TOKEN
      else process.env.OPENSCIENCE_DESKTOP_UPDATE_TOKEN = previousToken
    }
  })

  test("desktop capability reaches bounded disposal even behind deployment auth", async () => {
    const token = "b".repeat(64)
    const server = new URL("../../src/server/server.ts", import.meta.url).href
    const child = Bun.spawn(
      [
        process.execPath,
        "-e",
        `
          import { Server } from ${JSON.stringify(server)}
          const request = (authorization) => Server.App().request("http://127.0.0.1/settings/updates/dispose", {
            method: "POST",
            headers: { authorization },
          })
          const wrong = await request("Bearer wrong")
          const right = await request(${JSON.stringify(`Bearer ${token}`)})
          console.log(JSON.stringify({ wrong: wrong.status, right: right.status }))
          process.exit(wrong.status === 401 && right.status === 204 ? 0 : 1)
        `,
      ],
      {
        env: {
          ...process.env,
          OPENSCIENCE_DESKTOP_UPDATE_TOKEN: token,
          OPENSCIENCE_AUTH_TOKEN: "a-different-deployment-token",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    )
    const [code, output, error] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    expect(code, error).toBe(0)
    expect(output).toContain('{"wrong":401,"right":204}')
  })

  test("supports every installer implemented by the upgrader", () => {
    expect(
      ["curl", "npm", "pnpm", "yarn", "bun", "brew", "choco", "scoop", "desktop"].every(supportsAutomaticUpdate),
    ).toBe(true)
    expect(supportsAutomaticUpdate("unknown")).toBe(false)
  })

  test("deduplicates concurrent install requests", async () => {
    const gate = Promise.withResolvers<void>()
    const calls: string[] = []
    const install = createUpdateInstaller({
      resolve: async () => ({
        current: "2.0.47",
        latest: "2.0.49",
        channel: "latest",
        method: "npm",
        updateAvailable: true,
        releaseNotes: "https://example.com/releases",
      }),
      upgrade: async (_method, version) => {
        calls.push(version)
        await gate.promise
      },
    })

    const first = install()
    const second = install()
    await Promise.resolve()
    expect(calls).toEqual(["2.0.49"])
    gate.resolve()
    expect(await Promise.all([first, second])).toEqual([
      expect.objectContaining({ installed: true, restartRequired: true }),
      expect.objectContaining({ installed: true, restartRequired: true }),
    ])
  })
})

describe("update snapshot cache", () => {
  test("deduplicates concurrent and warm background checks", async () => {
    let calls = 0
    let time = 1_000
    const cache = createUpdateCache({
      ttl: 500,
      now: () => time,
      load: async () => ++calls,
    })

    const [first, second] = await Promise.all([cache(), cache()])
    expect([first, second]).toEqual([1, 1])
    expect(await cache()).toBe(1)
    expect(calls).toBe(1)

    time += 501
    expect(await cache()).toBe(2)
    expect(calls).toBe(2)
  })

  test("refreshes explicitly and retries failures immediately", async () => {
    let calls = 0
    const cache = createUpdateCache({
      load: async () => {
        calls++
        if (calls === 1) throw new Error("registry unavailable")
        return calls
      },
    })

    await expect(cache()).rejects.toThrow("registry unavailable")
    expect(await cache()).toBe(2)
    expect(await cache(true)).toBe(3)
  })

  test("deduplicates overlapping explicit refreshes", async () => {
    let calls = 0
    const gate = Promise.withResolvers<number>()
    const cache = createUpdateCache({
      load: () => {
        calls++
        return gate.promise
      },
    })

    const first = cache(true)
    const second = cache(true)
    expect(calls).toBe(0)
    await Promise.resolve()
    expect(calls).toBe(1)
    gate.resolve(7)
    expect(await Promise.all([first, second])).toEqual([7, 7])
  })
})

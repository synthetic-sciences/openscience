import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../../src/global"
import { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir, trustProject } from "../fixture/fixture"
import { spawn } from "../fixture/spawn"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

const fixture = path.join(import.meta.dir, "../fixture/session-loop-lease-process.ts")

type ChildResult = {
  id: string
  role: string
  text: string
}

function response(text: string) {
  const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
    id: "chatcmpl-session-loop-lease",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1_000),
    model: STRESS_PROVIDER_MODEL,
    choices: [{ index: 0, delta: finish ? {} : delta, finish_reason: finish }],
    ...(finish
      ? {
          usage: {
            prompt_tokens: 12,
            completion_tokens: 3,
            total_tokens: 15,
          },
        }
      : {}),
  })
  const body = [
    `data: ${JSON.stringify(chunk({ role: "assistant", content: text }, null))}\n\n`,
    `data: ${JSON.stringify(chunk({}, "stop"))}\n\n`,
    "data: [DONE]\n\n",
  ].join("")
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    },
  })
}

function provider(blocked: boolean) {
  const requests: unknown[] = []
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  if (!blocked) release.resolve()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 })
      requests.push(await request.json())
      entered.resolve()
      await release.promise
      return response("SESSION_LOOP_LEASE_COMPLETED")
    },
  })
  return { server, requests, entered, release }
}

async function wait(filepath: string, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (!(await Bun.file(filepath).exists())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${filepath}`)
    await Bun.sleep(10)
  }
}

async function within<T>(promise: Promise<T>, timeout = 10_000) {
  const expired = Promise.withResolvers<never>()
  const timer = setTimeout(() => expired.reject(new Error(`Timed out after ${timeout}ms`)), timeout)
  return Promise.race([promise, expired.promise]).finally(() => clearTimeout(timer))
}

async function seed(directory: string) {
  return Instance.provide({
    directory,
    init: async () => {
      await trustProject()
      await Provider.invalidate()
    },
    fn: async () => {
      const session = await Session.create({ title: "Cross-process loop lease" })
      const user = await SessionPrompt.prompt({
        sessionID: session.id,
        model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
        agent: "research",
        delegation: false,
        noReply: true,
        parts: [{ type: "text", text: "Return the deterministic lease fixture response." }],
      })
      if (user.info.role !== "user") throw new Error("Expected seeded user message")
      await Session.updateMessage({
        ...user.info,
        summary: {
          ...user.info.summary,
          title: "Seeded lease prompt",
          diffs: user.info.summary?.diffs ?? [],
        },
      })
      return {
        sessionID: session.id,
        projectID: session.projectID,
        lock: SessionPrompt.loopLeasePath(session.projectID, session.id),
      }
    },
  })
}

function child(mode: "loop" | "hold", directory: string, sessionID: string, ready: string, start?: string) {
  return spawn([process.execPath, fixture, mode, directory, sessionID, ready, ...(start ? [start] : [])], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  })
}

async function result(proc: ReturnType<typeof child>) {
  const [code, stdout, stderr] = await within(
    Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]),
  )
  if (code !== 0) throw new Error(`Session-loop worker exited ${code}: ${stderr}`)
  const line = stdout
    .trim()
    .split("\n")
    .findLast((item) => item.trim().startsWith("{"))
  if (!line) throw new Error(`Session-loop worker returned no JSON: ${stdout}\n${stderr}`)
  return JSON.parse(line) as ChildResult
}

describe("cross-process SessionPrompt loop lease", () => {
  test("uses a safe project-and-session scoped data-root path", () => {
    const filepath = SessionPrompt.loopLeasePath("../../project", "../session/../../escape")
    expect(path.dirname(filepath)).toBe(path.join(Global.Path.data, "session-loop"))
    expect(path.basename(filepath)).toMatch(/^[a-f0-9]{64}\.lock$/)
  })

  test("preserves same-process callback fan-in", async () => {
    const local = provider(true)
    try {
      await using tmp = await tmpdir({
        git: true,
        config: stressProviderConfig(`http://127.0.0.1:${local.server.port}/v1`),
      })
      const seeded = await seed(tmp.path)
      const [a, b] = await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const first = SessionPrompt.loop(seeded.sessionID)
          await within(local.entered.promise)
          const second = SessionPrompt.loop(seeded.sessionID)
          await Bun.sleep(100)
          expect(local.requests).toHaveLength(1)
          local.release.resolve()
          return Promise.all([first, second])
        },
      })
      expect(a.info.id).toBe(b.info.id)
      expect(local.requests).toHaveLength(1)
    } finally {
      local.release.resolve()
      local.server.stop(true)
    }
  }, 20_000)

  test("two Bun processes share one healthy long-running provider turn", async () => {
    const local = provider(true)
    const processes = new Set<ReturnType<typeof child>>()
    try {
      await using tmp = await tmpdir({
        git: true,
        config: stressProviderConfig(`http://127.0.0.1:${local.server.port}/v1`),
      })
      const seeded = await seed(tmp.path)
      const readyA = path.join(tmp.path, "worker-a.ready")
      const readyB = path.join(tmp.path, "worker-b.ready")
      const start = path.join(tmp.path, "workers.start")
      const first = child("loop", tmp.path, seeded.sessionID, readyA, start)
      const second = child("loop", tmp.path, seeded.sessionID, readyB, start)
      processes.add(first)
      processes.add(second)

      await Promise.all([wait(readyA), wait(readyB)])
      await fs.writeFile(start, "start")
      await within(local.entered.promise)
      // Both runtimes are already inside SessionPrompt.loop. Holding the owner
      // proves the peer waits instead of timing out or issuing its own request.
      await Bun.sleep(500)
      expect(local.requests).toHaveLength(1)
      expect(first.exitCode).toBeNull()
      expect(second.exitCode).toBeNull()

      local.release.resolve()
      const [a, b] = await Promise.all([result(first), result(second)])
      expect(local.requests).toHaveLength(1)
      expect(a).toEqual(b)
      expect(a).toMatchObject({ role: "assistant", text: "SESSION_LOOP_LEASE_COMPLETED" })
      expect(await Bun.file(seeded.lock).exists()).toBe(false)
    } finally {
      local.release.resolve()
      for (const proc of processes) proc.kill()
      await Promise.all([...processes].map((proc) => proc.exited.catch(() => undefined)))
      local.server.stop(true)
    }
  }, 20_000)

  test("reclaims a dead process owner before running the pending turn", async () => {
    const local = provider(false)
    const processes = new Set<ReturnType<typeof child>>()
    try {
      await using tmp = await tmpdir({
        git: true,
        config: stressProviderConfig(`http://127.0.0.1:${local.server.port}/v1`),
      })
      const seeded = await seed(tmp.path)
      const held = path.join(tmp.path, "dead-owner.ready")
      const owner = child("hold", tmp.path, seeded.sessionID, held)
      processes.add(owner)
      await wait(held)
      expect(await Bun.file(seeded.lock).exists()).toBe(true)
      owner.kill("SIGKILL")
      await within(owner.exited)
      expect(await Bun.file(seeded.lock).exists()).toBe(true)

      const ready = path.join(tmp.path, "recovery.ready")
      const start = path.join(tmp.path, "recovery.start")
      const recovery = child("loop", tmp.path, seeded.sessionID, ready, start)
      processes.add(recovery)
      await wait(ready)
      await fs.writeFile(start, "start")
      const output = await result(recovery)

      expect(local.requests).toHaveLength(1)
      expect(output).toMatchObject({ role: "assistant", text: "SESSION_LOOP_LEASE_COMPLETED" })
      expect(await Bun.file(seeded.lock).exists()).toBe(false)
    } finally {
      local.release.resolve()
      for (const proc of processes) proc.kill()
      await Promise.all([...processes].map((proc) => proc.exited.catch(() => undefined)))
      local.server.stop(true)
    }
  }, 20_000)
})

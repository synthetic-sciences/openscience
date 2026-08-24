import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { TaskAttempt, TaskCapacity } from "../../src/tool/task-attempt"
import { LockCoordination } from "../../src/util/lock-coordination"
import { tmpdir, trustProject } from "../fixture/fixture"
import { spawn } from "../fixture/spawn"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

const fixture = path.join(import.meta.dir, "../fixture/task-attempt-process.ts")

type Seed = {
  parentID: string
  userID: string
  messageID: string
  callID: string
}

type Result = {
  title: string
  metadata: { sessionId: string; startedAt: number; [key: string]: unknown }
  output: string
}

function response(text: string) {
  const chunk = (delta: Record<string, unknown>, finish: string | null) => ({
    id: "chatcmpl-task-attempt",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1_000),
    model: STRESS_PROVIDER_MODEL,
    choices: [{ index: 0, delta: finish ? {} : delta, finish_reason: finish }],
    ...(finish ? { usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } } : {}),
  })
  return new Response(
    [
      `data: ${JSON.stringify(chunk({ role: "assistant", content: text }, null))}\n\n`,
      `data: ${JSON.stringify(chunk({}, "stop"))}\n\n`,
      "data: [DONE]\n\n",
    ].join(""),
    { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } },
  )
}

function provider(blockFirst = false, delay = 0) {
  const requests: unknown[] = []
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  if (!blockFirst) release.resolve()
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 })
      requests.push(await request.json())
      entered.resolve()
      if (blockFirst && requests.length === 1) await release.promise
      if (delay) await Bun.sleep(delay)
      return response("DURABLE_CHILD_RESULT")
    },
  })
  return { server, requests, entered, release }
}

async function waitFor(check: () => Promise<boolean>, label: string, timeout = 10_000) {
  const deadline = Date.now() + timeout
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await Bun.sleep(10)
  }
}

function wait(filepath: string, timeout = 10_000) {
  return waitFor(() => Bun.file(filepath).exists(), filepath, timeout)
}

async function within<T>(promise: Promise<T>, timeout = 15_000) {
  const expired = Promise.withResolvers<never>()
  const timer = setTimeout(() => expired.reject(new Error(`Timed out after ${timeout}ms`)), timeout)
  return Promise.race([promise, expired.promise]).finally(() => clearTimeout(timer))
}

function worker(mode: string, directory: string, seed: Seed, ready: string, budgetMs?: number, attemptAgeMs?: number) {
  return spawn([process.execPath, fixture, mode, directory, seed.parentID, seed.messageID, seed.callID, ready], {
    cwd: directory,
    env:
      budgetMs || attemptAgeMs
        ? {
            ...(budgetMs && { OPENSCIENCE_TEST_TASK_BUDGET_MS: String(budgetMs) }),
            ...(attemptAgeMs && { OPENSCIENCE_TEST_TASK_ATTEMPT_AGE_MS: String(attemptAgeMs) }),
          }
        : undefined,
    stdout: "pipe",
    stderr: "pipe",
  })
}

function capacity(mode: "hold-cap" | "take-cap" | "hold-cap-intent" | "replace-cap", ready: string) {
  return spawn([process.execPath, fixture, mode, "", "", "", "", ready], {
    cwd: import.meta.dir,
    stdout: "pipe",
    stderr: "pipe",
  })
}

function parent(directory: string, sessionID: string, ready: string, start: string) {
  return spawn([process.execPath, fixture, "loop-parent", directory, sessionID, start, "unused", ready], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  })
}

async function result(proc: ReturnType<typeof worker>) {
  const [code, stdout, stderr] = await within(
    Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]),
  )
  if (code !== 0) throw new Error(`Durable Task worker exited ${code}: ${stderr}`)
  const line = stdout
    .trim()
    .split("\n")
    .findLast((item) => item.trim().startsWith("{"))
  if (!line) throw new Error(`Durable Task worker returned no JSON: ${stdout}\n${stderr}`)
  return JSON.parse(line) as Result
}

async function seed(directory: string): Promise<Seed> {
  return Instance.provide({
    directory,
    init: async () => {
      await trustProject()
      await Provider.invalidate()
    },
    fn: async () => {
      const parent = await Session.create({ title: "Durable Task parent" })
      const user = await SessionPrompt.prompt({
        sessionID: parent.id,
        model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
        agent: "research",
        delegation: true,
        noReply: true,
        parts: [{ type: "text", text: "Delegate one deterministic child." }],
      })
      if (user.info.role !== "user") throw new Error("Expected a user message")
      const messageID = await MessageV2.nextMessageID(parent.id)
      const callID = `call_${crypto.randomUUID()}`
      await Session.updateMessage({
        id: messageID,
        sessionID: parent.id,
        parentID: user.info.id,
        role: "assistant",
        mode: "research",
        agent: "research",
        path: { cwd: directory, root: directory },
        modelID: STRESS_PROVIDER_MODEL,
        providerID: STRESS_PROVIDER_ID,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        time: { created: Date.now() },
      })
      await Session.updatePart({
        id: `prt_${crypto.randomUUID().replaceAll("-", "").slice(0, 26)}`,
        sessionID: parent.id,
        messageID,
        callID,
        tool: "task",
        type: "tool",
        state: {
          status: "running",
          input: {
            description: "Durable restart fixture",
            prompt: "Return the deterministic child result.",
            subagent_type: "execute",
          },
          time: { start: Date.now() },
        },
      })
      return { parentID: parent.id, userID: user.info.id, messageID, callID }
    },
  })
}

async function wrapped(directory: string, interrupted = false) {
  return Instance.provide({
    directory,
    init: async () => {
      await trustProject()
      await Provider.invalidate()
    },
    fn: async () => {
      const session = await Session.create({ title: "Recovered Task wrapper" })
      const user = await SessionPrompt.prompt({
        sessionID: session.id,
        model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
        agent: "research",
        effort: "normal",
        delegation: true,
        noReply: true,
        parts: [
          {
            type: "subtask",
            agent: "execute",
            description: "Durable wrapper fixture",
            prompt: "Return the deterministic parent continuation.",
            command: "fixture",
          },
        ],
      })
      if (user.info.role !== "user") throw new Error("Expected a user message")
      const source = user.parts.find((part): part is MessageV2.SubtaskPart => part.type === "subtask")
      if (!source) throw new Error("Expected a source subtask")
      const ids = TaskAttempt.wrapperIDs({ messageID: user.info.id, partID: source.id })
      await Session.updateMessage({
        id: ids.messageID,
        sessionID: session.id,
        parentID: user.info.id,
        role: "assistant",
        mode: "execute",
        agent: "execute",
        path: { cwd: directory, root: directory },
        modelID: STRESS_PROVIDER_MODEL,
        providerID: STRESS_PROVIDER_ID,
        cost: 0,
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        finish: "tool-calls",
        time: { created: Date.now(), completed: Date.now() },
      })
      const input = {
        description: source.description,
        prompt: source.prompt,
        subagent_type: "execute" as const,
        command: source.command,
      }
      await Session.updatePart(
        interrupted
          ? {
              id: ids.partID,
              sessionID: session.id,
              messageID: ids.messageID,
              callID: ids.callID,
              tool: "task",
              type: "tool",
              metadata: TaskAttempt.wrapper({ messageID: user.info.id, partID: source.id }),
              state: { status: "running", input, time: { start: Date.now() } },
            }
          : {
              id: ids.partID,
              sessionID: session.id,
              messageID: ids.messageID,
              callID: ids.callID,
              tool: "task",
              type: "tool",
              metadata: TaskAttempt.wrapper({ messageID: user.info.id, partID: source.id }),
              state: {
                status: "completed",
                input,
                title: source.description,
                metadata: { sessionId: "ses_completed_child" },
                output: "DURABLE_WRAPPER_CHILD_RESULT",
                time: { start: Date.now(), end: Date.now() },
              },
            },
      )
      if (interrupted) {
        const identity = {
          projectID: Instance.project.id,
          parentSessionID: session.id,
          parentMessageID: ids.messageID,
          parentUserMessageID: user.info.id,
          callID: ids.callID,
        }
        await TaskAttempt.reserve({ ...identity, fingerprint: TaskAttempt.fingerprint(input) })
        await TaskAttempt.complete({
          ...identity,
          result: {
            title: source.description,
            metadata: { sessionId: "ses_completed_child" },
            output: "DURABLE_WRAPPER_CHILD_RESULT",
          },
        })
      }
      return { sessionID: session.id, ids }
    },
  })
}

async function children(directory: string, parentID: string) {
  return Instance.provide({ directory, fn: () => Session.children(parentID) })
}

describe("durable Task attempts across Bun processes", () => {
  test("uses key-order-stable fingerprints and migrates an in-flight legacy fingerprint", async () => {
    const params = {
      description: "Stable fingerprint fixture",
      prompt: "Keep this semantic input stable.",
      subagent_type: "execute",
      specialist: "ml",
      session_id: "ses_stable_fingerprint_fixture",
    }
    const reordered = {
      session_id: "ses_stable_fingerprint_fixture",
      specialist: "ml",
      subagent_type: "execute",
      prompt: "Keep this semantic input stable.",
      description: "Stable fingerprint fixture",
    }
    expect(TaskAttempt.fingerprint(params)).toBe(TaskAttempt.fingerprint(reordered))
    expect(TaskAttempt.fingerprint({ values: [1, 2] })).not.toBe(TaskAttempt.fingerprint({ values: [2, 1] }))

    await using tmp = await tmpdir({
      git: true,
      config: stressProviderConfig("http://127.0.0.1:1/v1"),
    })
    const input = await seed(tmp.path)
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const identity = {
          projectID: Instance.project.id,
          parentSessionID: input.parentID,
          parentMessageID: input.messageID,
          parentUserMessageID: input.userID,
          callID: input.callID,
        }
        const legacy = TaskAttempt.legacyFingerprint(params)
        const stable = TaskAttempt.fingerprint(params)
        expect(legacy).not.toBe(stable)
        await TaskAttempt.reserve({ ...identity, fingerprint: legacy })
        const migrated = await TaskAttempt.reserve({ ...identity, fingerprint: stable, legacyFingerprint: legacy })
        expect(migrated.fingerprint).toBe(stable)
      },
    })
  })

  test("charges active execution but excludes process downtime after restart", async () => {
    const processes = new Set<ReturnType<typeof worker>>()
    await using tmp = await tmpdir({
      git: true,
      config: stressProviderConfig("http://127.0.0.1:1/v1"),
    })
    const input = await seed(tmp.path)
    const activeReady = path.join(tmp.path, "active-budget.ready")
    try {
      const active = worker("active-block", tmp.path, input, activeReady)
      processes.add(active)
      await wait(activeReady)
      await Bun.sleep(180)
      active.kill("SIGKILL")
      await within(active.exited)

      const stopped = Date.now()
      await Bun.sleep(500)
      const resume = worker("active-resume", tmp.path, input, path.join(tmp.path, "active-resume.ready"))
      processes.add(resume)
      const recovered = await result(resume)
      const activeMs = Number(recovered.metadata.activeMs)
      const remainingMs = Number(recovered.metadata.remainingMs)

      expect(Date.now() - stopped).toBeGreaterThanOrEqual(450)
      expect(activeMs).toBeGreaterThanOrEqual(50)
      expect(activeMs).toBeLessThan(300)
      expect(remainingMs).toBe(300 - activeMs)
      expect(remainingMs).toBeGreaterThan(0)
    } finally {
      for (const proc of processes) proc.kill()
      await Promise.all([...processes].map((proc) => proc.exited.catch(() => undefined)))
    }
  }, 10_000)

  test("resumed Task execution keeps unused active budget after longer process downtime", async () => {
    const local = provider(true, 40)
    const processes = new Set<ReturnType<typeof worker>>()
    // Attempt age and active execution are independent clocks. Backdate the
    // reservation in the fixture so its elapsed age exceeds the budget without
    // turning a 600 ms provider round trip into an accidental CI performance SLA.
    const budgetMs = 5_000
    const attemptAgeMs = budgetMs + 1_000
    try {
      await using tmp = await tmpdir({
        git: true,
        config: stressProviderConfig(`http://127.0.0.1:${local.server.port}/v1`),
      })
      const input = await seed(tmp.path)
      const first = worker("run", tmp.path, input, path.join(tmp.path, "budget-first.ready"), budgetMs, attemptAgeMs)
      processes.add(first)
      await within(local.entered.promise)
      first.kill("SIGKILL")
      await within(first.exited)

      local.release.resolve()
      const second = worker("run", tmp.path, input, path.join(tmp.path, "budget-second.ready"), budgetMs)
      processes.add(second)
      const output = await result(second)

      expect(output.output).toContain("DURABLE_CHILD_RESULT")
      expect(output.output).not.toContain("<task_metadata>")
      expect(output.metadata.timedOut).toBe(false)
      expect(Number(output.metadata.queuedMs)).toBeGreaterThan(budgetMs)
      expect(Number(output.metadata.activeMs)).toBeLessThan(budgetMs)
      expect(local.requests.length).toBeGreaterThan(1)
    } finally {
      local.release.resolve()
      for (const proc of processes) proc.kill()
      await Promise.all([...processes].map((proc) => proc.exited.catch(() => undefined)))
      local.server.stop(true)
    }
  }, 15_000)

  test("recovers one parent continuation for a completed synthetic wrapper", async () => {
    const local = provider(true)
    const processes = new Set<ReturnType<typeof parent>>()
    try {
      await using tmp = await tmpdir({
        git: true,
        config: stressProviderConfig(`http://127.0.0.1:${local.server.port}/v1`),
      })
      const sessionID = (await wrapped(tmp.path)).sessionID
      const readyA = path.join(tmp.path, "wrapper-a.ready")
      const readyB = path.join(tmp.path, "wrapper-b.ready")
      const start = path.join(tmp.path, "wrapper.start")
      const first = parent(tmp.path, sessionID, readyA, start)
      const second = parent(tmp.path, sessionID, readyB, start)
      processes.add(first)
      processes.add(second)
      await Promise.all([wait(readyA), wait(readyB)])
      await fs.writeFile(start, "start")
      const failed = (proc: ReturnType<typeof parent>, label: string) =>
        proc.exited.then((code) => ({ type: "exit" as const, code, label, proc }))
      const entered = await within(
        Promise.race([
          local.entered.promise.then(() => ({ type: "provider" as const })),
          failed(first, "first"),
          failed(second, "second"),
        ]),
      )
      if (entered.type === "exit") {
        const stderr = await new Response(entered.proc.stderr).text()
        throw new Error(`${entered.label} exited ${entered.code} before provider entry: ${stderr}`)
      }
      await Bun.sleep(200)
      expect(local.requests).toHaveLength(1)
      local.release.resolve()

      const [a, b] = await Promise.all([result(first), result(second)])
      expect(a.output).toContain("DURABLE_CHILD_RESULT")
      expect(b.output).toBe(a.output)
      expect(local.requests).toHaveLength(1)
      const messages = await Instance.provide({ directory: tmp.path, fn: () => Session.messages({ sessionID }) })
      expect(messages.filter((message) => TaskAttempt.syntheticWrapper(message))).toHaveLength(1)
      expect(
        messages.filter(
          (message) =>
            message.info.role === "user" &&
            message.info.internal?.type === "continuation" &&
            message.info.internal.kind === "task",
        ),
      ).toHaveLength(1)
    } finally {
      local.release.resolve()
      for (const proc of processes) proc.kill()
      await Promise.all([...processes].map((proc) => proc.exited.catch(() => undefined)))
      local.server.stop(true)
    }
  }, 30_000)

  test("restores a durable child result into a running command wrapper before parent continuation", async () => {
    const local = provider()
    const processes = new Set<ReturnType<typeof parent>>()
    try {
      await using tmp = await tmpdir({
        git: true,
        config: stressProviderConfig(`http://127.0.0.1:${local.server.port}/v1`),
      })
      const seeded = await wrapped(tmp.path, true)
      const ready = path.join(tmp.path, "wrapper-recovery.ready")
      const start = path.join(tmp.path, "wrapper-recovery.start")
      const process = parent(tmp.path, seeded.sessionID, ready, start)
      processes.add(process)
      await wait(ready)
      await fs.writeFile(start, "start")
      const output = await result(process)
      const messages = await Instance.provide({
        directory: tmp.path,
        fn: () => Session.messages({ sessionID: seeded.sessionID }),
      })
      const wrapper = messages
        .flatMap((message) => message.parts)
        .find((part): part is MessageV2.ToolPart => part.type === "tool" && part.id === seeded.ids.partID)

      expect(wrapper?.state.status).toBe("completed")
      if (wrapper?.state.status !== "completed") throw new Error("Expected recovered Task result")
      expect(wrapper.state.output).toBe("DURABLE_WRAPPER_CHILD_RESULT")
      expect(
        messages.filter(
          (message) =>
            message.info.role === "user" &&
            message.info.internal?.type === "continuation" &&
            message.info.internal.kind === "task",
        ),
      ).toHaveLength(1)
      expect(JSON.stringify(local.requests)).toContain("DURABLE_WRAPPER_CHILD_RESULT")
      expect(JSON.stringify(local.requests)).not.toContain("Tool execution was interrupted")
      expect(output.output).toContain("DURABLE_CHILD_RESULT")
    } finally {
      local.release.resolve()
      for (const process of processes) process.kill()
      await Promise.all([...processes].map((process) => process.exited.catch(() => undefined)))
      local.server.stop(true)
    }
  }, 30_000)

  test("restores a durable child result into an ordinary running Task call after restart", async () => {
    const local = provider()
    const processes = new Set<ReturnType<typeof parent>>()
    try {
      await using tmp = await tmpdir({
        git: true,
        config: stressProviderConfig(`http://127.0.0.1:${local.server.port}/v1`),
      })
      const input = await seed(tmp.path)
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const identity = {
            projectID: Instance.project.id,
            parentSessionID: input.parentID,
            parentMessageID: input.messageID,
            parentUserMessageID: input.userID,
            callID: input.callID,
          }
          const params = {
            description: "Durable restart fixture",
            prompt: "Return the deterministic child result.",
            subagent_type: "execute" as const,
          }
          await TaskAttempt.reserve({ ...identity, fingerprint: TaskAttempt.fingerprint(params) })
          await TaskAttempt.complete({
            ...identity,
            result: {
              title: params.description,
              metadata: { sessionId: "ses_completed_child" },
              output: "DURABLE_ORDINARY_CHILD_RESULT",
            },
          })
        },
      })
      const ready = path.join(tmp.path, "ordinary-recovery.ready")
      const start = path.join(tmp.path, "ordinary-recovery.start")
      const process = parent(tmp.path, input.parentID, ready, start)
      processes.add(process)
      await wait(ready)
      await fs.writeFile(start, "start")
      await result(process)
      const messages = await Instance.provide({
        directory: tmp.path,
        fn: () => Session.messages({ sessionID: input.parentID }),
      })
      const source = messages.find((message) => message.info.id === input.messageID)
      const task = source?.parts.find(
        (part): part is MessageV2.ToolPart => part.type === "tool" && part.callID === input.callID,
      )

      expect(source?.info.role === "assistant" ? source.info.finish : undefined).toBe("tool-calls")
      expect(task?.state.status).toBe("completed")
      if (task?.state.status !== "completed") throw new Error("Expected recovered Task result")
      expect(task.state.output).toBe("DURABLE_ORDINARY_CHILD_RESULT")
      expect(JSON.stringify(local.requests)).toContain("DURABLE_ORDINARY_CHILD_RESULT")
      expect(JSON.stringify(local.requests)).not.toContain("Tool execution was interrupted")
    } finally {
      local.release.resolve()
      for (const process of processes) process.kill()
      await Promise.all([...processes].map((process) => process.exited.catch(() => undefined)))
      local.server.stop(true)
    }
  }, 30_000)

  test("reuses its pre-reserved child after interruption during awaited parent binding", async () => {
    const local = provider()
    const processes = new Set<ReturnType<typeof worker>>()
    try {
      await using tmp = await tmpdir({
        git: true,
        config: stressProviderConfig(`http://127.0.0.1:${local.server.port}/v1`),
      })
      const input = await seed(tmp.path)
      const blockedReady = path.join(tmp.path, "binding-blocked.ready")
      const blocked = worker("bind-block", tmp.path, input, blockedReady)
      processes.add(blocked)
      await wait(blockedReady)
      const binding = JSON.parse(await Bun.file(blockedReady).text()) as { sessionId: string; startedAt: number }
      expect(local.requests).toHaveLength(0)

      blocked.kill("SIGKILL")
      await within(blocked.exited)
      const recoveryReady = path.join(tmp.path, "binding-recovery.ready")
      const recovery = worker("run", tmp.path, input, recoveryReady)
      processes.add(recovery)
      const output = await result(recovery)

      expect(output.metadata.sessionId).toBe(binding.sessionId)
      expect(output.metadata.startedAt).toBe(binding.startedAt)
      expect(output.output).toContain("DURABLE_CHILD_RESULT")
      expect(local.requests.length).toBeGreaterThan(0)
      expect(await children(tmp.path, input.parentID)).toHaveLength(1)
    } finally {
      local.release.resolve()
      for (const proc of processes) proc.kill()
      await Promise.all([...processes].map((proc) => proc.exited.catch(() => undefined)))
      local.server.stop(true)
    }
  }, 30_000)

  test("replays a completed child result when the parent tool write never happened", async () => {
    const local = provider()
    const processes = new Set<ReturnType<typeof worker>>()
    try {
      await using tmp = await tmpdir({
        git: true,
        config: stressProviderConfig(`http://127.0.0.1:${local.server.port}/v1`),
      })
      const input = await seed(tmp.path)
      const first = worker("run", tmp.path, input, path.join(tmp.path, "complete-first.ready"))
      processes.add(first)
      const original = await result(first)
      const calls = local.requests.length
      const second = worker("run", tmp.path, input, path.join(tmp.path, "complete-second.ready"))
      processes.add(second)
      const replay = await result(second)

      expect(replay).toEqual(original)
      expect(calls).toBeGreaterThan(0)
      expect(local.requests).toHaveLength(calls)
      expect(await children(tmp.path, input.parentID)).toHaveLength(1)
    } finally {
      local.release.resolve()
      for (const proc of processes) proc.kill()
      await Promise.all([...processes].map((proc) => proc.exited.catch(() => undefined)))
      local.server.stop(true)
    }
  }, 30_000)

  test("resumes one child turn after a provider-owning process is killed", async () => {
    const local = provider(true)
    const processes = new Set<ReturnType<typeof worker>>()
    try {
      await using tmp = await tmpdir({
        git: true,
        config: stressProviderConfig(`http://127.0.0.1:${local.server.port}/v1`),
      })
      const input = await seed(tmp.path)
      const first = worker("run", tmp.path, input, path.join(tmp.path, "provider-first.ready"))
      processes.add(first)
      await within(local.entered.promise)
      first.kill("SIGKILL")
      await within(first.exited)
      local.release.resolve()

      const second = worker("run", tmp.path, input, path.join(tmp.path, "provider-second.ready"))
      processes.add(second)
      const output = await result(second)
      const child = (await children(tmp.path, input.parentID))[0]
      const messages = await Instance.provide({
        directory: tmp.path,
        fn: () => Session.messages({ sessionID: child.id }),
      })

      expect(output.output).toContain("DURABLE_CHILD_RESULT")
      expect(local.requests.length).toBeGreaterThan(1)
      expect(await children(tmp.path, input.parentID)).toHaveLength(1)
      expect(messages.filter((message) => message.info.role === "user")).toHaveLength(1)
    } finally {
      local.release.resolve()
      for (const proc of processes) proc.kill()
      await Promise.all([...processes].map((proc) => proc.exited.catch(() => undefined)))
      local.server.stop(true)
    }
  }, 30_000)

  test("enforces a process-global slot and reclaims its dead owner", async () => {
    const processes = new Set<ReturnType<typeof worker>>()
    const firstReady = path.join(TaskCapacity.slotPath("child", 0), `../owner-${crypto.randomUUID()}.ready`)
    const secondReady = path.join(TaskCapacity.slotPath("child", 0), `../waiter-${crypto.randomUUID()}.ready`)
    await fs.mkdir(path.dirname(firstReady), { recursive: true })
    try {
      const first = capacity("hold-cap", firstReady)
      processes.add(first)
      await wait(firstReady)
      const second = capacity("take-cap", secondReady)
      processes.add(second)
      await Bun.sleep(150)
      expect(await Bun.file(secondReady).exists()).toBe(false)

      first.kill("SIGKILL")
      await within(first.exited)
      const output = await result(second)
      expect(output).toMatchObject({ acquired: true })
      expect(await Bun.file(secondReady).exists()).toBe(true)
    } finally {
      for (const proc of processes) proc.kill()
      await Promise.all([...processes].map((proc) => proc.exited.catch(() => undefined)))
      await fs.rm(firstReady, { force: true })
      await fs.rm(secondReady, { force: true })
    }
  }, 20_000)

  test("competing capacity reclaimers cannot remove a newly acquired slot", async () => {
    const processes = new Set<ReturnType<typeof worker>>()
    const slot = TaskCapacity.slotPath("child", 0)
    const root = path.dirname(slot)
    const deadReady = path.join(root, `aba-dead-${crypto.randomUUID()}.ready`)
    const intentReady = path.join(root, `aba-intent-${crypto.randomUUID()}.ready`)
    const firstReady = path.join(root, `aba-first-${crypto.randomUUID()}.ready`)
    const secondReady = path.join(root, `aba-second-${crypto.randomUUID()}.ready`)
    const thirdReady = path.join(root, `aba-third-${crypto.randomUUID()}.ready`)
    await fs.mkdir(root, { recursive: true })
    try {
      const dead = capacity("hold-cap", deadReady)
      processes.add(dead)
      await wait(deadReady)
      dead.kill("SIGKILL")
      await within(dead.exited)

      const intent = capacity("hold-cap-intent", intentReady)
      processes.add(intent)
      await wait(intentReady)

      const first = capacity("take-cap", firstReady)
      processes.add(first)
      const claims = LockCoordination.directory(slot, "claim")
      await waitFor(
        () =>
          fs
            .readdir(claims)
            .then((items) => items.length > 0)
            .catch(() => false),
        "the first capacity reclaimer claim",
      )
      process.kill(first.pid, "SIGSTOP")
      intent.kill("SIGKILL")
      await within(intent.exited)

      const second = capacity("take-cap", secondReady)
      processes.add(second)
      await waitFor(
        () =>
          Bun.file(slot)
            .exists()
            .then((exists) => !exists),
        "the dead capacity slot removal",
      )
      const third = capacity("take-cap", thirdReady)
      processes.add(third)
      await Bun.sleep(150)
      expect(await Promise.all([firstReady, secondReady, thirdReady].map((file) => Bun.file(file).exists()))).toEqual([
        false,
        false,
        false,
      ])
      expect(await Bun.file(slot).exists()).toBe(false)

      process.kill(first.pid, "SIGCONT")
      const results = await Promise.all([result(first), result(second), result(third)])
      expect(results).toEqual([
        expect.objectContaining({ acquired: true }),
        expect.objectContaining({ acquired: true }),
        expect.objectContaining({ acquired: true }),
      ])
      expect(await Bun.file(slot).exists()).toBe(false)
      const markers = (kind: LockCoordination.Kind) =>
        fs.readdir(LockCoordination.directory(slot, kind)).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return []
          throw error
        })
      expect(await markers("claim")).toEqual([])
      expect(await markers("intent")).toEqual([])
    } finally {
      for (const proc of processes) {
        try {
          process.kill(proc.pid, "SIGCONT")
        } catch {}
        proc.kill()
      }
      await Promise.all([...processes].map((proc) => proc.exited.catch(() => undefined)))
      await Promise.all(
        [deadReady, intentReady, firstReady, secondReady, thirdReady].map((file) => fs.rm(file, { force: true })),
      )
    }
  }, 20_000)

  test("a stale capacity observer revalidates before replacing a new live owner", async () => {
    const processes = new Set<ReturnType<typeof worker>>()
    const slot = TaskCapacity.slotPath("child", 0)
    const root = path.dirname(slot)
    const deadReady = path.join(root, `revalidate-dead-${crypto.randomUUID()}.ready`)
    const intentReady = path.join(root, `revalidate-intent-${crypto.randomUUID()}.ready`)
    const waiterReady = path.join(root, `revalidate-waiter-${crypto.randomUUID()}.ready`)
    const replacementReady = path.join(root, `revalidate-replacement-${crypto.randomUUID()}.ready`)
    await fs.mkdir(root, { recursive: true })
    try {
      const dead = capacity("hold-cap", deadReady)
      processes.add(dead)
      await wait(deadReady)
      dead.kill("SIGKILL")
      await within(dead.exited)

      const intent = capacity("hold-cap-intent", intentReady)
      processes.add(intent)
      await wait(intentReady)

      const waiter = capacity("take-cap", waiterReady)
      processes.add(waiter)
      const claims = LockCoordination.directory(slot, "claim")
      await waitFor(
        () =>
          fs
            .readdir(claims)
            .then((items) => items.length > 0)
            .catch(() => false),
        "the stale capacity observer claim",
      )
      process.kill(waiter.pid, "SIGSTOP")
      intent.kill("SIGKILL")
      await within(intent.exited)

      const replacement = capacity("replace-cap", replacementReady)
      processes.add(replacement)
      await wait(replacementReady)
      const replacementOwner = await Bun.file(slot).json()
      expect(replacementOwner).toMatchObject({ pid: replacement.pid })

      process.kill(waiter.pid, "SIGCONT")
      await Bun.sleep(150)
      expect(await Bun.file(waiterReady).exists()).toBe(false)
      expect(await Bun.file(slot).json()).toEqual(replacementOwner)

      replacement.kill("SIGKILL")
      await within(replacement.exited)
      expect(await result(waiter)).toMatchObject({ acquired: true })
      expect(await Bun.file(slot).exists()).toBe(false)
    } finally {
      for (const proc of processes) {
        try {
          process.kill(proc.pid, "SIGCONT")
        } catch {}
        proc.kill()
      }
      await Promise.all([...processes].map((proc) => proc.exited.catch(() => undefined)))
      await Promise.all(
        [deadReady, intentReady, waiterReady, replacementReady].map((file) => fs.rm(file, { force: true })),
      )
    }
  }, 20_000)
})

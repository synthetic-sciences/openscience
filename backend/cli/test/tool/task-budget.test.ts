import { expect, test } from "bun:test"
import { Config } from "../../src/config/config"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { Identifier } from "../../src/id/id"
import { TaskTool } from "../../src/tool/task"
import { SessionPrompt } from "../../src/session/prompt"
import { SubagentBudget } from "../../src/session/subagent-budget"
import { Storage } from "../../src/storage/storage"
import { TaskAttempt } from "../../src/tool/task-attempt"
import { Server } from "../../src/server/server"
import { tmpdir, trustProject } from "../fixture/fixture"
import { stressProviderConfig, STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL } from "../fixture/stress-provider"

const model = { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL }
async function fixture(
  fn: (input: {
    parent: Session.Info
    execute: (
      taskID?: string,
      background?: boolean,
      replay?: boolean,
    ) => Promise<Awaited<ReturnType<Awaited<ReturnType<typeof TaskTool.init>>["execute"]>>>
    requests: unknown[]
  }) => Promise<void>,
  deadlineMs = 600000,
  tokens = 200000,
  delay = 0,
  recovery = false,
  priced = false,
  premium = false,
) {
  const requests: unknown[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const body: unknown = await req.json()
      requests.push(body)
      const internal = JSON.stringify(body).includes("You are a title generator")
      const turn = requests.filter((request) => !JSON.stringify(request).includes("You are a title generator")).length
      if (recovery && !internal) await Bun.sleep(10)
      if (delay) await Bun.sleep(delay)
      const chunk = (content: string, finish: string | null) =>
        `data: ${JSON.stringify({ id: "task-budget", object: "chat.completion.chunk", created: 1, model: model.modelID, choices: [{ index: 0, delta: finish ? {} : { role: "assistant", content }, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: recovery && !internal && turn === 1 ? 79990 : 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`
      return new Response(
        chunk("Outcome: Complete\nFindings: fixture done.", null) +
          chunk("", recovery && !internal ? "length" : "stop") +
          "data: [DONE]\n\n",
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  const provider = stressProviderConfig(`http://127.0.0.1:${server.port}/v1`)
  const previous = await Config.getGlobalRaw()
  await Config.updateGlobal({ subagents: { enabled: true, tokens, deadlineMs } }, { preserveInstances: true })
  try {
    await using tmp = await tmpdir({
      git: true,
      config: {
        ...provider,
        provider: {
          [STRESS_PROVIDER_ID]: {
            ...provider.provider[STRESS_PROVIDER_ID],
            models: {
              ...provider.provider[STRESS_PROVIDER_ID].models,
              [STRESS_PROVIDER_MODEL]: {
                ...provider.provider[STRESS_PROVIDER_ID].models[STRESS_PROVIDER_MODEL],
                ...(premium
                  ? {
                      cost: { input: 10, output: 50, cache_read: 1, cache_write: 12.5 },
                      experimental: {
                        modes: { fast: { cost: { input: 40, output: 150, cache_read: 4, cache_write: 50 } } },
                      },
                    }
                  : priced
                    ? { cost: { input: 1, output: 2 } }
                    : {}),
              },
            },
          },
        },
        harness: { review: false, budget: false, unattended: false, deliverables: false, acceptance: false },
        agent: {
          probe: {
            mode: "subagent",
            prompt: "Return a concise report.",
            permission: premium ? { "*": "deny", read: "allow" } : { "*": "deny" },
            model: `${STRESS_PROVIDER_ID}/fixture-model-compact`,
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const parent = await Session.create({ title: "Budget fixture" })
        const userID = Identifier.ascending("message")
        await Session.updateMessage({
          id: userID,
          sessionID: parent.id,
          role: "user",
          agent: "research",
          model,
          effort: "normal",
          time: { created: Date.now() },
        })
        const identity = { messageID: "", callID: "" }
        const execute = async (taskID?: string, background = false, replay = false) => {
          const messageID = replay ? identity.messageID : Identifier.ascending("message")
          if (!replay) {
            identity.messageID = messageID
            identity.callID = `call_${crypto.randomUUID()}`
          }
          await Session.updateMessage({
            id: messageID,
            sessionID: parent.id,
            parentID: userID,
            role: "assistant",
            modelID: model.modelID,
            providerID: model.providerID,
            mode: "research",
            agent: "research",
            path: { cwd: tmp.path, root: tmp.path },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: Date.now() },
          })
          return (await TaskTool.init()).execute(
            {
              description: "Bounded probe",
              prompt: premium
                ? "Review the worker contract, record supported findings and identify unfinished tests. ".repeat(30)
                : "Return your findings.",
              subagent_type: "probe",
              background,
              ...(taskID ? { task_id: taskID } : {}),
            },
            {
              sessionID: parent.id,
              messageID,
              callID: identity.callID,
              agent: "research",
              abort: new AbortController().signal,
              messages: [],
              ask: async () => {},
              metadata: async () => {},
              extra: { bypassAgentCheck: true },
            },
          )
        }
        await fn({ parent, execute, requests })
      },
    })
  } finally {
    await Config.replaceGlobal(previous.content)
    server.stop(true)
  }
}

test("Task persists a bounded contract, uses caller model and returns allocation metadata", async () => {
  await fixture(async ({ parent, execute }) => {
    const result = await execute()
    const childID = result.metadata.sessionId as string
    const state = (await SubagentBudget.read(childID))!
    expect(state).toBeDefined()
    expect(state.worker.parentSessionID).toBe(parent.id)
    expect(state.worker.model).toEqual(model)
    expect(state.worker.expectedOutput).toContain("findings")
    expect(state.worker.active).toBe(false)
    expect(state.worker.spent).toBeGreaterThan(0)
    expect(state.worker.handoff).toContain("fixture done")
    expect(state.worker.outcome).toBe("completed")
    expect(result.metadata.budget).toMatchObject({ unit: "tokens" })
  })
})

test("actual Task refuses provider dispatch when the token allowance cannot fit its input", async () => {
  await fixture(
    async ({ execute, requests }) => {
      const result = await execute()
      expect(result.metadata.outcome).toBe("partial")
      expect(result.metadata.stopReason).toBe("token_limit")
      expect(requests).toHaveLength(0)
    },
    600000,
    100,
  )
})

test("Task continuation uses the same child and keeps its cumulative ledger", async () => {
  await fixture(async ({ execute }) => {
    const first = await execute()
    const childID = first.metadata.sessionId as string
    const before = (await SubagentBudget.read(childID))!
    const ids = (await Session.messages({ sessionID: childID })).map((m) => m.info.id)
    const resumed = await execute(childID)
    const after = (await SubagentBudget.read(childID))!
    expect(resumed.metadata.sessionId).toBe(childID)
    expect(after.worker.spent).toBeGreaterThanOrEqual(before.worker.spent)
    expect((await Session.messages({ sessionID: childID })).filter((m) => ids.includes(m.info.id))).toHaveLength(
      ids.length,
    )
  })
})

test("Task deadline stops work with a typed reason and no false completion", async () => {
  await fixture(async ({ execute }) => {
    const result = await execute()
    expect(result.metadata.outcome).toBe("partial")
    expect(result.metadata.stopReason).toBe("deadline")
  }, 1)
})

test("user increase and continue resumes the same real Task child once", async () => {
  await fixture(
    async ({ parent, execute, requests }) => {
      const first = await execute()
      expect(first.metadata.stopReason).toBe("token_limit")
      const childID = first.metadata.sessionId as string
      const internal = Server.internalFetch()
      const fetch = (url: string, options?: RequestInit) => {
        const headers = new Headers(options?.headers)
        headers.set("x-openscience-project", parent.projectID)
        headers.set("x-openscience-directory", parent.directory)
        return internal(url, { ...options, headers })
      }
      const pool = (await SubagentBudget.snapshot(parent.id))!
      const increased = await fetch(`http://openscience.internal/session/${parent.id}/subagents/budget/increase`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ unit: "tokens", amount: 200000, revision: pool.revision, key: crypto.randomUUID() }),
      })
      expect(increased.status).toBe(200)
      const endpoint = `http://openscience.internal/session/${parent.id}/subagents/${childID}/continue`
      const options = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: crypto.randomUUID() }),
      }
      const response = await fetch(endpoint, options)
      expect({ status: response.status, body: response.status === 202 ? undefined : await response.text() }).toEqual({
        status: 202,
        body: undefined,
      })
      const until = Date.now() + 5000
      while (Date.now() < until) {
        const current = await SubagentBudget.read(childID)
        if (current?.worker.outcome === "completed" && !current.worker.active) break
        await Bun.sleep(10)
      }
      const current = (await SubagentBudget.read(childID))!
      expect(current.worker.outcome).toBe("completed")
      expect(current.worker.handoff).toContain("fixture done")
      expect(await Session.children(parent.id)).toHaveLength(1)
      const calls = requests.length
      expect(calls).toBeGreaterThan(0)
      expect((await fetch(endpoint, options)).status).toBe(202)
      await Bun.sleep(10)
      expect(requests).toHaveLength(calls)
    },
    600000,
    100,
  )
})

test("enabling bounded runs with omitted amounts uses the suggested allowances", async () => {
  await fixture(async ({ parent, execute }) => {
    await Config.updateGlobal({ subagents: { enabled: true, deadlineMs: 600000 } }, { preserveInstances: true })
    const result = await execute()
    expect(result.metadata.outcome).toBe("completed")
    expect((await SubagentBudget.inspect(parent.id))?.limits).toEqual({
      usd: SubagentBudget.dollars(5),
      tokens: 1000000,
    })
  })
})
test("default-off Task dispatch stays unbounded even with tiny suggested limits", async () => {
  await fixture(async ({ parent, execute, requests }) => {
    await Config.updateGlobal({ subagents: { enabled: false, tokens: 1, deadlineMs: 1 } }, { preserveInstances: true })
    const result = await execute()
    expect(result.metadata.outcome).toBe("completed")
    expect(requests.length).toBeGreaterThan(0)
    expect(await SubagentBudget.read(result.metadata.sessionId as string)).toBeUndefined()
    const pool = (await SubagentBudget.inspect(parent.id))!
    expect(pool.enabled).toBe(false)
    expect(pool.limits.tokens).toBe(0)
    expect(result.metadata.budget).toBeUndefined()
  })
})
test("explicit user model overrides both caller and specialist profile", async () => {
  await fixture(async ({ execute }) => {
    await Config.updateGlobal(
      {
        subagents: {
          enabled: true,
          deadlineMs: 600000,
          tokens: 200000,
          model: `${STRESS_PROVIDER_ID}/fixture-model-compact`,
        },
      },
      { preserveInstances: true },
    )
    const result = await execute()
    expect((await SubagentBudget.read(result.metadata.sessionId as string))?.worker.model.modelID).toBe(
      "fixture-model-compact",
    )
  })
})
test("normal parent completion keeps a background child; explicit idle-parent stop cancels it", async () => {
  await fixture(
    async ({ parent, execute, requests }) => {
      const result = await SessionPrompt.withCancellation(parent.id, () => execute(undefined, true))
      const childID = result.metadata.sessionId as string
      const until = Date.now() + 5000
      while (!requests.length && Date.now() < until) await Bun.sleep(10)
      expect(requests.length).toBeGreaterThan(0)
      expect((await SubagentBudget.read(childID))?.worker.active).toBe(true)
      SessionPrompt.cancel(parent.id)
      while ((await SubagentBudget.read(childID))?.worker.active && Date.now() < until) await Bun.sleep(10)
      expect((await SubagentBudget.read(childID))?.worker.stopReason).toBe("cancelled")
      expect((await SubagentBudget.read(childID))?.worker.active).toBe(false)
    },
    600000,
    200000,
    2000,
  )
})

test("a real child that ignores handoff cannot extend output-length recovery past its final call", async () => {
  await fixture(
    async ({ execute, requests }) => {
      const result = await execute()
      const visible = requests.filter((request) => !JSON.stringify(request).includes("You are a title generator"))
      expect({
        calls: visible.length,
        stopReason: result.metadata.stopReason,
        budget: result.metadata.budget,
      }).toMatchObject({ calls: 2 })
      expect(JSON.stringify(visible[1])).toContain("Runtime allowance notice")
      expect(result.metadata.outcome).toBe("partial")
      expect(result.metadata.stopReason).toBe("budget_wrapup")
    },
    600000,
    400000,
    0,
    true,
  )
})

test("explicit stop also cancels background admission before its allowance watch starts", async () => {
  await fixture(async ({ parent, execute, requests }) => {
    await execute(undefined, true)
    SessionPrompt.cancel(parent.id)
    await Bun.sleep(400)
    expect(requests).toHaveLength(0)
  })
})

test("terminal Task recovery releases its matching stale assignment and keeps unknown call holds", async () => {
  await fixture(async ({ parent, execute, requests }) => {
    const first = await execute()
    const childID = first.metadata.sessionId as string
    const state = (await SubagentBudget.read(childID))!
    state.worker.active = true
    state.worker.calls.uncertain = { amount: 100, state: "pending" }
    await Storage.write(["subagent_budget", parent.projectID, parent.id], state.pool)
    const keys = await Storage.list(["task_attempt", parent.projectID])
    const attempt = TaskAttempt.Info.parse(await Storage.read(keys[0]!))
    await Storage.write(keys[0]!, { ...attempt, status: "bound", result: undefined })
    const calls = requests.length
    const replay = await execute(undefined, false, true)
    expect(replay.metadata.sessionId).toBe(childID)
    const after = (await SubagentBudget.read(childID))!
    expect(after.worker.active).toBe(false)
    expect(after.worker.calls.uncertain.state).toBe("pending")
    expect(requests.length).toBe(calls)
  })
})

test("a second foreground Task cannot change a live child's assignment or release its allowance", async () => {
  await fixture(
    async ({ parent, execute, requests }) => {
      const first = execute()
      while (!requests.length) await Bun.sleep(5)
      const child = (await Session.children(parent.id))[0]!
      const before = (await SubagentBudget.read(child.id))!
      const second = await execute(child.id)
      expect(second.metadata.outcome).not.toBe("completed")
      const during = (await SubagentBudget.read(child.id))!
      expect(during.worker.active).toBe(true)
      expect(during.worker.assignmentID).toBe(before.worker.assignmentID)
      expect(during.worker.outcome).toBeUndefined()
      await first
      expect((await SubagentBudget.read(child.id))?.worker.active).toBe(false)
    },
    600000,
    200000,
    1500,
  )
})

test("global changes do not remove existing bounded conversation limits", async () => {
  await fixture(async ({ parent, execute }) => {
    await execute()
    const before = (await SubagentBudget.inspect(parent.id))!
    await Config.updateGlobal(
      { subagents: { enabled: false, tokens: 1000000, deadlineMs: 600000 } },
      { preserveInstances: true },
    )
    const next = await execute()
    expect(next.metadata.budget).toBeDefined()
    expect((await SubagentBudget.inspect(parent.id))?.limits).toEqual(before.limits)
  })
})
test("enabling defaults later does not retroactively bind an unbounded conversation", async () => {
  await fixture(async ({ parent, execute }) => {
    await Config.updateGlobal({ subagents: { enabled: false, deadlineMs: 600000 } }, { preserveInstances: true })
    await execute()
    await Config.updateGlobal({ subagents: { enabled: true, deadlineMs: 1 } }, { preserveInstances: true })
    const next = await execute()
    expect(next.metadata.outcome).toBe("completed")
    expect(next.metadata.budget).toBeUndefined()
    expect((await SubagentBudget.inspect(parent.id))?.enabled).toBe(false)
  })
})

test("off-mode active time includes a slow child's full execution", async () => {
  await fixture(
    async ({ execute }) => {
      await Config.updateGlobal({ subagents: { enabled: false, deadlineMs: 600000 } }, { preserveInstances: true })
      const result = await execute()
      expect(result.metadata.outcome).toBe("completed")
      expect(result.metadata.activeMs).toBeGreaterThanOrEqual(250)
    },
    600000,
    200000,
    350,
  )
})

test("a priced model behind a local proxy consumes the paid USD pool", async () => {
  await fixture(
    async ({ parent, execute }) => {
      const result = await execute()
      const state = (await SubagentBudget.read(result.metadata.sessionId as string))!
      expect(state.worker.route).toBe("local")
      expect(state.worker.unit).toBe("usd")
      expect(state.worker.spent).toBeGreaterThan(0)
      expect(state.worker.limit).toBe(SubagentBudget.dollars(1.25))
      expect((await SubagentBudget.snapshot(parent.id))?.available.tokens).toBe(200000)
    },
    600000,
    200000,
    0,
    false,
    true,
  )
})

test("the calling model receives runtime accounting before and after Task compaction", async () => {
  await fixture(async ({ execute }) => {
    const result = await execute()
    expect(result.output).toContain("Runtime accounting:")
    expect(result.output).toContain("model=stress/fixture-model")
    expect(result.output).toContain("route=local")
    expect(result.output).toContain("tokens used")
    expect(result.output).toContain("grant=50000 tokens")
    expect(result.output).toContain("assignment remaining")
    expect(result.output).toContain("shared pool available")
    const compacted = MessageV2.toolSummary("task", {
      status: "completed",
      title: result.title,
      input: {},
      output: result.output,
      metadata: result.metadata,
      time: { start: 0, end: 1 },
    })
    expect(compacted).toContain("Runtime accounting:")
    expect(compacted).toContain("shared pool available")
    expect(compacted).toContain("model=stress/fixture-model")
  })
})

test("a Standard priced Task can start within its default USD 1.25 grant while Fast is available", async () => {
  await fixture(
    async ({ execute, requests }) => {
      const result = await execute()
      expect(result.metadata.outcome).toBe("completed")
      const state = (await SubagentBudget.read(result.metadata.sessionId as string))!
      expect(state.worker.limit).toBe(SubagentBudget.dollars(1.25))
      expect(state.worker.spent).toBeGreaterThan(0)
      expect(requests.length).toBeGreaterThan(0)
      const first = JSON.stringify(requests[0])
      expect(first).toContain('"name":"read"')
      expect(first).not.toContain("Runtime allowance notice")
    },
    600000,
    200000,
    0,
    false,
    false,
    true,
  )
})

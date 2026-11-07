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
      abort?: AbortSignal,
    ) => Promise<Awaited<ReturnType<Awaited<ReturnType<typeof TaskTool.init>>["execute"]>>>
    requests: unknown[]
    selection: {
      variant?: string
      permission?: () => Promise<void>
      queuedAt?: number
      workerModel?: typeof model
      workerModelOverride?: boolean
    }
  }) => Promise<void>,
  deadlineMs = 600000,
  tokens = 200000,
  delay = 0,
  recovery: boolean | "cooperative" | "deadline" | "deadline-ignored" = false,
  priced = false,
  premium = false,
) {
  const selection: {
    variant?: string
    permission?: () => Promise<void>
    queuedAt?: number
    workerModel?: typeof model
    workerModelOverride?: boolean
  } = {}
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
        `data: ${JSON.stringify({ id: "task-budget", object: "chat.completion.chunk", created: 1, model: model.modelID, choices: [{ index: 0, delta: finish ? {} : { role: "assistant", content }, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: (recovery === true || recovery === "cooperative") && !internal && turn === 1 ? 79990 : recovery === true && !internal && turn === 2 ? 19990 : 50, completion_tokens: 10, total_tokens: 60 } } : {}) })}\n\n`
      const handoff = (recovery === "cooperative" || recovery === "deadline") && !internal && turn === 2
      return new Response(
        chunk(
          handoff ? "Outcome: Incomplete\nFindings: fixture partial." : "Outcome: Complete\nFindings: fixture done.",
          null,
        ) +
          chunk(
            "",
            !internal &&
              (recovery === true ||
                recovery === "deadline-ignored" ||
                ((recovery === "cooperative" || recovery === "deadline") && turn === 1))
              ? "length"
              : "stop",
          ) +
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
                variants: { low: { reasoningEffort: "low" }, high: { reasoningEffort: "high" } },
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
        const execute = async (taskID?: string, background = false, replay = false, abort?: AbortSignal) => {
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
          if (!replay && (selection.permission || selection.queuedAt !== undefined))
            await Session.updatePart({
              id: Identifier.ascending("part"),
              sessionID: parent.id,
              messageID,
              type: "tool",
              tool: "task",
              callID: identity.callID,
              state: { status: "running", input: {}, time: { start: selection.queuedAt ?? Date.now() } },
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
              abort: abort ?? new AbortController().signal,
              messages: [],
              ask: selection.permission ?? (async () => {}),
              metadata: async () => {},
              extra: {
                bypassAgentCheck: !selection.permission,
                variant: selection.variant,
                delegationSettings: {
                  workerModel: selection.workerModel,
                  workerModelOverride: selection.workerModelOverride,
                },
              },
            },
          )
        }
        await fn({ parent, execute, requests, selection })
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
      expect(result.metadata.budget).toMatchObject({ spent: 0, pending: 0, remaining: 25 })
      expect(result.output).toContain("not proof that the grant was spent")
      expect(result.output).toContain("requests refused before dispatch add no model usage")
      const compacted = MessageV2.toolSummary("task", {
        status: "completed",
        title: result.title,
        input: {},
        output: result.output,
        metadata: result.metadata,
        time: { start: 0, end: 1 },
      })
      expect(compacted).toContain("not proof that the grant was spent")
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

test("a refused paid request reports unused allowance rather than a spent grant", async () => {
  await fixture(
    async ({ execute, requests }) => {
      await Config.updateGlobal(
        { subagents: { enabled: true, usd: 0.000004, tokens: 200000, deadlineMs: 600000 } },
        { preserveInstances: true },
      )
      const result = await execute()
      expect(requests).toHaveLength(0)
      expect(result.metadata.stopReason).toBe("budget_limit")
      expect(result.metadata.budget).toMatchObject({ unit: "usd", spent: 0, pending: 0, remaining: 1000 })
      expect(result.output).toContain("not proof that the grant was spent")
      expect(result.output).toContain("requests refused before dispatch add no model usage")
    },
    600000,
    200000,
    0,
    false,
    true,
  )
})

test("Task deadline stops work with a typed reason and no false completion", async () => {
  await fixture(async ({ execute }) => {
    const result = await execute()
    expect(result.metadata.outcome).toBe("partial")
    expect(result.metadata.stopReason).toBe("deadline")
  }, 1)
})

test("a saved legacy allowance handoff keeps its model when the global policy changes", async () => {
  await fixture(
    async ({ parent, execute, requests }) => {
      const pending = execute()
      while (!requests.length) await Bun.sleep(2)
      const child = (await Session.children(parent.id))[0]!
      await SubagentBudget.wrapup(child.id)
      const first = await pending
      const childID = first.metadata.sessionId as string
      const before = (await SubagentBudget.read(childID))!
      expect(first.metadata.stopReason).toBe("budget_wrapup")
      expect(before.worker.stopReason).toBeUndefined()
      expect(before.worker.reportReason).toBe("budget_wrapup")
      const messages = await Session.messages({ sessionID: childID })
      const calls = Object.keys(before.worker.calls)
      await Config.updateGlobal(
        { subagents: { enabled: true, deadlineMs: 600000, model: `${STRESS_PROVIDER_ID}/fixture-model-compact` } },
        { preserveInstances: true },
      )
      const resumed = await execute(childID)
      const after = (await SubagentBudget.read(childID))!
      expect(resumed.metadata.outcome).toBe("completed")
      expect(after.worker.model).toEqual(model)
      expect(after.worker.spent).toBeGreaterThan(before.worker.spent)
      expect(Object.keys(after.worker.calls)).toEqual(expect.arrayContaining(calls))
      expect((await Session.messages({ sessionID: childID })).map((message) => message.info.id)).toEqual(
        expect.arrayContaining(messages.map((message) => message.info.id)),
      )
      const visible = requests.filter((request) => !JSON.stringify(request).includes("You are a title generator"))
      expect(visible.at(-1)).toMatchObject({ model: STRESS_PROVIDER_MODEL })
      expect(JSON.stringify(visible.at(-1))).toContain("fixture partial")
    },
    600000,
    400000,
    0,
    "cooperative",
  )
})

for (const legacy of [false, true]) {
  test(`a limited continuation keeps its reasoning variant${legacy ? " from a legacy contract" : ""}`, async () => {
    await fixture(
      async ({ parent, execute, requests, selection }) => {
        selection.variant = "low"
        const first = await execute()
        const childID = first.metadata.sessionId as string
        expect(first.metadata.stopReason).toBe("token_limit")
        const before = (await SubagentBudget.read(childID))!
        expect(before.worker).toMatchObject({ variant: "low" })
        if (legacy) {
          Reflect.deleteProperty(before.worker, "variant")
          await Storage.write(["subagent_budget", parent.projectID, parent.id], before.pool)
        }
        await SubagentBudget.increase(parent.id, {
          unit: "tokens",
          amount: 200000,
          revision: before.pool.revision,
          key: crypto.randomUUID(),
        })
        selection.variant = "high"
        await Config.updateGlobal(
          { subagents: { enabled: true, deadlineMs: 600000, model: `${STRESS_PROVIDER_ID}/fixture-model-compact` } },
          { preserveInstances: true },
        )
        const resumed = await execute(childID)
        expect(resumed.metadata.outcome).toBe("completed")
        const visible = requests.filter((request) => !JSON.stringify(request).includes("You are a title generator"))
        expect(visible.at(-1)).toMatchObject({ model: STRESS_PROVIDER_MODEL, reasoning_effort: "low" })
        const messages = await Session.messages({ sessionID: childID })
        const user = messages.findLast((message) => message.info.role === "user")!.info
        expect(user.role === "user" && user.variant).toBe("low")
      },
      600000,
      100,
    )
  })
}

test("a limited continuation keeps an unset reasoning variant", async () => {
  await fixture(
    async ({ parent, execute, requests, selection }) => {
      const first = await execute()
      expect(first.metadata.stopReason).toBe("token_limit")
      const pool = (await SubagentBudget.snapshot(parent.id))!
      await SubagentBudget.increase(parent.id, {
        unit: "tokens",
        amount: 200000,
        revision: pool.revision,
        key: crypto.randomUUID(),
      })
      selection.variant = "high"
      const resumed = await execute(first.metadata.sessionId as string)
      expect(resumed.metadata.outcome).toBe("completed")
      const visible = requests.filter((request) => !JSON.stringify(request).includes("You are a title generator"))
      expect(visible.at(-1)).not.toHaveProperty("reasoning_effort")
    },
    600000,
    100,
  )
})

test("a deadline continuation keeps its model when the global policy changes", async () => {
  await fixture(async ({ execute, requests }) => {
    const first = await execute()
    expect(first.metadata.stopReason).toBe("deadline")
    await Config.updateGlobal(
      { subagents: { enabled: true, deadlineMs: 600000, model: `${STRESS_PROVIDER_ID}/fixture-model-compact` } },
      { preserveInstances: true },
    )
    const resumed = await execute(first.metadata.sessionId as string)
    expect(resumed.metadata.outcome).toBe("completed")
    const visible = requests.filter((request) => !JSON.stringify(request).includes("You are a title generator"))
    expect(visible.at(-1)).toMatchObject({ model: STRESS_PROVIDER_MODEL })
  }, 1)
})

test("a deliberate completed follow-up can select a new model on the same route and unit", async () => {
  await fixture(async ({ execute, requests }) => {
    const first = await execute()
    expect(first.metadata.outcome).toBe("completed")
    const childID = first.metadata.sessionId as string
    const before = (await SubagentBudget.read(childID))!
    await Config.updateGlobal(
      { subagents: { enabled: true, deadlineMs: 600000, model: `${STRESS_PROVIDER_ID}/fixture-model-compact` } },
      { preserveInstances: true },
    )
    const resumed = await execute(childID)
    const after = (await SubagentBudget.read(childID))!
    expect(resumed.metadata.outcome).toBe("completed")
    expect(after.worker).toMatchObject({
      model: { providerID: STRESS_PROVIDER_ID, modelID: "fixture-model-compact" },
      route: "local",
      unit: "tokens",
    })
    expect(after.worker.spent).toBeGreaterThan(before.worker.spent)
    const visible = requests.filter((request) => !JSON.stringify(request).includes("You are a title generator"))
    expect(visible.at(-1)).toMatchObject({ model: "fixture-model-compact" })
  })
})

test("a pinned continuation cannot dispatch a revoked provider", async () => {
  await fixture(
    async ({ parent, execute, requests }) => {
      const first = await execute()
      expect(first.metadata.stopReason).toBe("token_limit")
      const pool = (await SubagentBudget.snapshot(parent.id))!
      await SubagentBudget.increase(parent.id, {
        unit: "tokens",
        amount: 200000,
        revision: pool.revision,
        key: crypto.randomUUID(),
      })
      await Config.updateGlobal({ disabled_providers: [STRESS_PROVIDER_ID] }, { preserveInstances: true })
      const resumed = await execute(first.metadata.sessionId as string)
      expect(resumed.metadata.outcome).toBe("error")
      expect(resumed.metadata.stopReason).toBe("provider_error")
      expect(requests).toHaveLength(0)
    },
    600000,
    100,
  )
})

test("a pinned continuation refuses a changed access route before provider dispatch", async () => {
  await fixture(
    async ({ parent, execute, requests }) => {
      const first = await execute()
      const childID = first.metadata.sessionId as string
      expect(first.metadata.stopReason).toBe("token_limit")
      const before = (await SubagentBudget.read(childID))!
      await SubagentBudget.increase(parent.id, {
        unit: "tokens",
        amount: 200000,
        revision: before.pool.revision,
        key: crypto.randomUUID(),
      })
      await Config.updateGlobal(
        {
          provider: {
            [STRESS_PROVIDER_ID]: {
              models: { [STRESS_PROVIDER_MODEL]: { options: { baseURL: "https://route-change.invalid/v1" } } },
            },
          },
        },
        { preserveInstances: true },
      )
      const resumed = await execute(childID)
      expect(resumed.metadata.outcome).toBe("partial")
      expect(resumed.metadata.stopReason).toBe("route_changed")
      const after = (await SubagentBudget.read(childID))!
      expect(after.worker.route).toBe("local")
      expect(after.worker.unit).toBe("tokens")
      expect(after.worker.calls).toEqual(before.worker.calls)
      expect(requests).toHaveLength(0)
    },
    600000,
    100,
  )
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

test("replaying a continuation key while it runs returns the same call instead of a conflict", async () => {
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
      await fetch(`http://openscience.internal/session/${parent.id}/subagents/budget/increase`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ unit: "tokens", amount: 200000, revision: pool.revision, key: crypto.randomUUID() }),
      })
      const endpoint = `http://openscience.internal/session/${parent.id}/subagents/${childID}/continue`
      const options = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key: crypto.randomUUID() }),
      }
      const before = requests.length
      const [a, b] = await Promise.all([fetch(endpoint, options), fetch(endpoint, options)])
      const replay = await fetch(endpoint, options)
      const bodies = await Promise.all([a, b, replay].map((r) => r.text()))
      expect([a.status, b.status, replay.status], bodies.join(" | ")).toEqual([202, 202, 202])
      const ids = new Set(bodies.map((body) => JSON.parse(body).callID))
      expect(ids.size).toBe(1)
      const other = await fetch(endpoint, { ...options, body: JSON.stringify({ key: crypto.randomUUID() }) })
      expect(other.status).toBe(409)
      const until = Date.now() + 10000
      while (Date.now() < until && !(await SubagentBudget.read(childID))?.pool.continuations) await Bun.sleep(10)
      while (Date.now() < until) {
        const current = await SubagentBudget.read(childID)
        if (Object.values(current?.pool.continuations ?? {}).every((c) => c.completed)) break
        await Bun.sleep(20)
      }
      const turns = requests.slice(before).filter((r) => !JSON.stringify(r).includes("You are a title generator"))
      expect(turns).toHaveLength(1)
    },
    600000,
    100,
    600,
  )
}, 30000)

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
test("Same as calling agent overrides an older worker-model preference", async () => {
  await fixture(async ({ execute, selection }) => {
    selection.workerModel = { providerID: STRESS_PROVIDER_ID, modelID: "fixture-model-compact" }
    const result = await execute()
    expect((await SubagentBudget.read(result.metadata.sessionId as string))?.worker.model).toEqual(model)
  })
})

test("an explicit run worker-model override selects the requested model", async () => {
  await fixture(async ({ execute, selection }) => {
    selection.workerModel = { providerID: STRESS_PROVIDER_ID, modelID: "fixture-model-compact" }
    selection.workerModelOverride = true
    const result = await execute()
    expect((await SubagentBudget.read(result.metadata.sessionId as string))?.worker.model).toEqual(
      selection.workerModel,
    )
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
      await Bun.sleep(50)
      const reports = (await Session.messages({ sessionID: parent.id }))
        .flatMap((message) => message.parts)
        .filter((part) => part.type === "text" && part.synthetic && part.text.includes(`task_id: ${childID}`))
      expect(reports).toHaveLength(0)
    },
    600000,
    200000,
    2000,
  )
})

test("stopping only a background child delivers its cancellation report to the parent", async () => {
  await fixture(
    async ({ parent, execute, requests }) => {
      const first = await execute(undefined, true)
      const childID = first.metadata.sessionId as string
      const until = Date.now() + 5000
      while (!requests.length && Date.now() < until) await Bun.sleep(10)
      expect(requests.length).toBeGreaterThan(0)
      SessionPrompt.cancel(childID)
      const reports = async () =>
        (await Session.messages({ sessionID: parent.id }))
          .flatMap((message) => message.parts)
          .filter((part) => part.type === "text" && part.synthetic && part.text.includes(`task_id: ${childID}`))
      while (!(await reports()).length && Date.now() < until) await Bun.sleep(10)
      expect(await reports()).toMatchObject([{ text: expect.stringContaining("cancelled") }])
      expect((await SubagentBudget.read(childID))?.worker.stopReason).toBe("cancelled")
      while (
        (await Session.messages({ sessionID: parent.id })).every(
          (message) => message.info.role !== "assistant" || !message.info.time.completed,
        ) &&
        Date.now() < until
      )
        await Bun.sleep(10)
    },
    600000,
    200000,
    400,
  )
})

test("a non-cooperative child stops on runtime exhaustion without a final-report exemption", async () => {
  await fixture(
    async ({ execute, requests }) => {
      const result = await execute()
      const visible = requests.filter((request) => !JSON.stringify(request).includes("You are a title generator"))
      expect({
        calls: visible.length,
        stopReason: result.metadata.stopReason,
        budget: result.metadata.budget,
      }).toMatchObject({ calls: 2 })
      expect(JSON.stringify(visible)).not.toContain("Runtime allowance notice")
      expect(result.metadata.outcome).toBe("partial")
      expect(result.metadata.stopReason).toBe("token_limit")
      expect(result.output).toContain("Task completion: unverified.")
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
      // A refusal names the real cause instead of reporting a provider error.
      await expect(execute(child.id)).rejects.toThrow(/still running/)
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
    expect(result.output).toContain("Task completion: unverified.")
    expect(compacted).toContain("Task completion: unverified.")
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

for (const mode of ["preaborted", "cancelled", "all-cancelled", "mixed", "joined"] as const) {
  test(`background completion delivery survives ${mode} waiters`, async () => {
    await fixture(
      async ({ parent, execute, requests }) => {
        const first = await execute(undefined, true)
        const childID = first.metadata.sessionId as string
        while (!requests.length) await Bun.sleep(5)
        const controller = new AbortController()
        if (mode === "preaborted") controller.abort()
        const waiting = execute(childID, false, false, controller.signal)
        const cancelled = mode !== "joined"
        const failure = waiting.catch((error: unknown) => error)
        const second =
          mode === "mixed" || mode === "joined" || mode === "all-cancelled"
            ? execute(childID, false, false, mode === "all-cancelled" ? controller.signal : undefined)
            : undefined
        const secondResult = second?.catch((error: unknown) => error)
        if (cancelled && mode !== "preaborted") {
          await Bun.sleep(50)
          controller.abort()
        }
        const result = await failure
        if (cancelled) expect(result).toMatchObject({ message: expect.stringContaining("cancelled") })
        else
          expect(result).toMatchObject({
            metadata: { sessionId: childID, outcome: "completed" },
            output: expect.stringContaining("Waited for this background worker"),
          })
        if (secondResult) {
          const result = await secondResult
          if (mode === "all-cancelled") expect(result).toMatchObject({ message: expect.stringContaining("cancelled") })
          else
            expect(result).toMatchObject({
              metadata: { sessionId: childID, outcome: "completed" },
              output: expect.stringContaining("Waited for this background worker"),
            })
        }
        const until = Date.now() + 5000
        while ((await SubagentBudget.read(childID))?.worker.active && Date.now() < until) await Bun.sleep(10)
        const shouldWake = mode === "preaborted" || mode === "cancelled" || mode === "all-cancelled"
        const reports = async () =>
          (await Session.messages({ sessionID: parent.id }))
            .flatMap((message) => message.parts)
            .filter((part) => part.type === "text" && part.synthetic && part.text.includes(`task_id: ${childID}`))
        while (shouldWake && !(await reports()).length && Date.now() < until) await Bun.sleep(10)
        expect((await SubagentBudget.read(childID))?.worker.stopReason).not.toBe("cancelled")
        expect(await reports()).toHaveLength(shouldWake ? 1 : 0)
        if (shouldWake) {
          while (
            (await Session.messages({ sessionID: parent.id })).every(
              (message) => message.info.role !== "assistant" || !message.info.time.completed,
            ) &&
            Date.now() < until
          )
            await Bun.sleep(10)
        }
        expect(
          requests.filter((request) => !JSON.stringify(request).includes("You are a title generator")).length,
        ).toBe(shouldWake ? 2 : 1)
      },
      600000,
      200000,
      400,
    )
  })
}

test("actual Task preserves available tools after 75 percent elapsed and requires result assessment", async () => {
  await fixture(
    async ({ parent, execute, requests }) => {
      const pending = execute()
      while (!requests.length) await Bun.sleep(5)
      const child = (await Session.children(parent.id))[0]!
      const state = (await SubagentBudget.read(child.id))!
      const now = Date.now()
      state.worker.acceptedAt = now - 8000
      state.worker.deadline = now + 2000
      await Storage.write(["subagent_budget", parent.projectID, parent.id], state.pool)
      const result = await pending
      expect(result.metadata).toMatchObject({ outcome: "partial", stopReason: "reported_incomplete" })
      expect(result.output).toContain("Task completion: unverified.")
      const after = (await SubagentBudget.read(child.id))!
      expect(after.worker).toMatchObject({ acceptedAt: now - 8000, deadline: now + 2000 })
      expect(after.worker.wrapupReason).toBeUndefined()
      const visible = requests.filter((request) => !JSON.stringify(request).includes("You are a title generator"))
      expect(visible).toHaveLength(2)
      expect(JSON.stringify(visible[0])).toContain('"name":"read"')
      expect(JSON.stringify(visible[1])).toContain('"name":"read"')
      expect(JSON.stringify(visible)).not.toContain("Runtime deadline notice")
    },
    600000,
    400000,
    200,
    "deadline",
    false,
    true,
  )
})

for (const failure of ["rejected", "timed out"] as const) {
  test(`Task permission ${failure} leaves no attempt or grant and a later approved call succeeds`, async () => {
    await fixture(async ({ parent, execute, selection, requests }) => {
      selection.permission = async () => {
        expect(await Session.children(parent.id)).toHaveLength(0)
        if (failure === "timed out") await Bun.sleep(30)
        throw new Error(`Permission ${failure}`)
      }
      await expect(execute()).rejects.toThrow(`Permission ${failure}`)
      expect(await Storage.list(["task_attempt", parent.projectID])).toHaveLength(0)
      expect(await SubagentBudget.inspect(parent.id)).toBeUndefined()
      expect(requests).toHaveLength(0)
      selection.permission = async () => {
        expect(await Session.children(parent.id)).toHaveLength(0)
      }
      expect((await execute()).metadata.outcome).toBe("completed")
    })
  })
}

test("permission and queue elapsed time can expire Task before any provider call", async () => {
  await fixture(async ({ parent, execute, selection, requests }) => {
    const acceptedAt = Date.now() - 11000
    selection.queuedAt = acceptedAt
    selection.permission = async () => {
      expect(await Session.children(parent.id)).toHaveLength(0)
      await Bun.sleep(30)
    }
    const result = await execute()
    expect(result.metadata).toMatchObject({ outcome: "partial", stopReason: "deadline" })
    expect(requests).toHaveLength(0)
    const childID = result.metadata.sessionId as string
    const state = (await SubagentBudget.read(childID))!
    expect(state.worker).toMatchObject({ acceptedAt, deadline: acceptedAt + 10000, active: false })
    expect(Object.keys(state.worker.calls)).toHaveLength(0)
    expect(result.output).toContain("new assignment deadline")
    selection.permission = undefined
    selection.queuedAt = undefined
    expect((await execute(childID)).metadata.outcome).toBe("completed")
    expect((await SubagentBudget.read(childID))!.worker.acceptedAt).toBeGreaterThan(acceptedAt)
  }, 10000)
})

test("the hard deadline cancels work without an extra report call", async () => {
  await fixture(
    async ({ execute, selection, requests }) => {
      selection.queuedAt = Date.now() - 8000
      const result = await execute()
      expect(result.metadata).toMatchObject({ outcome: "partial", stopReason: "deadline" })
      const visible = requests.filter((request) => !JSON.stringify(request).includes("You are a title generator"))
      expect(visible).toHaveLength(1)
      expect(JSON.stringify(visible[0])).not.toContain("Runtime deadline notice")
      expect(JSON.stringify(visible[0])).toContain('"name":"read"')
      const state = (await SubagentBudget.read(result.metadata.sessionId as string))!
      expect(state.worker.active).toBe(false)
      expect(state.worker.wrapupReason).toBeUndefined()
      expect(Object.values(state.worker.calls).length).toBeGreaterThan(0)
      expect(Object.values(state.worker.calls).every((call) => call.state === "pending")).toBe(true)
      expect(result.output).toContain("Task completion: unverified.")
    },
    10000,
    200000,
    3000,
    false,
    false,
    true,
  )
})

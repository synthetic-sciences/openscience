import { expect, test } from "bun:test"
import { Config } from "../../src/config/config"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { SubagentBudget } from "../../src/session/subagent-budget"
import { SubagentDispatch } from "../../src/session/subagent-dispatch"
import { TraceQueue } from "../../src/session/trace-queue"
import { TaskTool } from "../../src/tool/task"
import { tmpdir, trustProject } from "../fixture/fixture"
import { stressProviderConfig, STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL } from "../fixture/stress-provider"

const model = { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL }
const input = (sessionID: string, parentSessionID: string, unit: "usd" | "tokens", allocation: number) => ({
  rootSessionID: "root",
  parentSessionID,
  sessionID,
  assignmentID: `assignment-${sessionID}`,
  objective: "Compare evidence",
  expectedOutput: "Findings and checks",
  model,
  route: unit === "usd" ? "byok" : "chatgpt",
  unit,
  allocation,
  settings: { enabled: true, usd: 0.000001, tokens: 1000 },
})

test("alternating paid and subscription ancestors constrain their own units exactly once", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await SubagentBudget.open(input("paid", "root", "usd", 600))
      await SubagentBudget.open(input("subscription", "paid", "tokens", 500))
      await SubagentBudget.open(input("paid-leaf", "subscription", "usd", 400))
      await SubagentBudget.open(input("token-leaf", "paid-leaf", "tokens", 300))
      const admitted = (await SubagentBudget.inspect("root"))!
      expect(SubagentBudget.available(admitted, "usd")).toBe(400)
      expect(SubagentBudget.available(admitted, "tokens")).toBe(500)
      expect(SubagentBudget.spendable(admitted, "paid")).toBe(200)
      expect(SubagentBudget.spendable(admitted, "subscription")).toBe(200)
      await expect(SubagentBudget.reserve("paid", "too-large", 201)).rejects.toThrow(/limit/)
      await expect(SubagentBudget.reserve("subscription", "too-large", 201)).rejects.toThrow(/limit/)
      await SubagentBudget.reserve("paid-leaf", "paid-call", 300)
      await SubagentBudget.settle("paid-leaf", "paid-call", 250)
      await SubagentBudget.reserve("token-leaf", "token-call", 200)
      await SubagentBudget.settle("token-leaf", "token-call", 150)
      await SubagentBudget.release("paid-leaf")
      await SubagentBudget.release("token-leaf")
      const before = (await SubagentBudget.inspect("root"))!
      expect(SubagentBudget.consumed(before, "paid")).toBe(250)
      expect(SubagentBudget.consumed(before, "subscription")).toBe(150)
      expect(SubagentBudget.spendable(before, "paid")).toBe(350)
      expect(SubagentBudget.spendable(before, "subscription")).toBe(350)
      await SubagentBudget.reserve("paid", "parent-paid", 100)
      await SubagentBudget.settle("paid", "parent-paid", 100)
      await SubagentBudget.reserve("subscription", "parent-token", 100)
      await SubagentBudget.settle("subscription", "parent-token", 100)
      await SubagentBudget.release("paid")
      await SubagentBudget.release("subscription")
      const after = (await SubagentBudget.snapshot("root"))!
      expect(after.available).toEqual({ usd: 650, tokens: 750 })
      expect(after.workers["paid-leaf"].spent).toBe(250)
      expect(after.workers["token-leaf"].spent).toBe(150)
      expect(after.workers.paid.spent).toBe(100)
      expect(after.workers.subscription.spent).toBe(100)
    },
  })
})

for (const unit of ["usd", "tokens"] as const) {
  test(`concurrent ${unit} grandchildren cannot bypass an ancestor through a different-unit parent`, async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const other = unit === "usd" ? "tokens" : "usd"
        await SubagentBudget.open(input("ancestor", "root", unit, 300))
        await SubagentBudget.open(input("bridge", "ancestor", other, 500))
        const results = await Promise.allSettled([
          SubagentBudget.open(input("left", "bridge", unit, 200)),
          SubagentBudget.open(input("right", "bridge", unit, 200)),
        ])
        expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
        expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
        const state = (await SubagentBudget.inspect("root"))!
        const child = state.workers.left ?? state.workers.right
        expect(Object.keys(state.workers)).toHaveLength(3)
        expect(SubagentBudget.available(state, unit)).toBe(700)
        expect(SubagentBudget.available(state, other)).toBe(500)
        expect(SubagentBudget.spendable(state, "ancestor")).toBe(100)
        await SubagentBudget.reserve(child.sessionID, "unknown", 150)
        await SubagentBudget.settle(child.sessionID, "unknown")
        await SubagentBudget.release(child.sessionID)
        await SubagentBudget.release("ancestor")
        const released = (await SubagentBudget.snapshot("root"))!
        expect(released.available[unit]).toBe(850)
        expect(released.available[other]).toBe(500)
        await expect(SubagentBudget.open(input("sibling", "root", unit, 851))).rejects.toThrow(/limit/)
        await SubagentBudget.open(input("sibling", "root", unit, 850))
        await expect(
          SubagentBudget.open({ ...input(child.sessionID, "bridge", unit, 1), assignmentID: "resume" }),
        ).rejects.toThrow(/limit/)
        expect((await SubagentBudget.read(child.sessionID))?.worker.calls.unknown).toEqual({
          amount: 150,
          state: "pending",
        })
      },
    })
  })
}

for (const route of ["chatgpt", "subscription"] as const) {
  test(`${route} dispatch counts repeated cache input once per call and reasoning once per output`, async () => {
    await using tmp = await tmpdir({ git: true, config: stressProviderConfig("http://127.0.0.1:9/v1") })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const effective = await Provider.getModel(model.providerID, model.modelID)
        await SubagentBudget.open({
          ...input("child", "root", "tokens", 10000),
          route,
          settings: { usd: 0.000001, tokens: 20000 },
        })
        const body = JSON.stringify({ messages: [{ role: "user", content: "Repeated context" }], max_tokens: 100 })
        for (const callID of ["first", "repeat"]) {
          await SubagentDispatch.begin({ sessionID: "child", callID, model: effective, route, body })
          await SubagentDispatch.complete({
            sessionID: "child",
            callID,
            model: effective,
            route,
            usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150, cachedInputTokens: 40, reasoningTokens: 20 },
          })
        }
        expect((await SubagentBudget.read("child"))?.worker.spent).toBe(300)
        await SubagentDispatch.begin({ sessionID: "child", callID: "zero", model: effective, route, body })
        await SubagentDispatch.complete({
          sessionID: "child",
          callID: "zero",
          model: effective,
          route,
          usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
        })
        expect((await SubagentBudget.read("child"))?.worker.calls.zero).toMatchObject({ state: "settled", consumed: 0 })
        await SubagentDispatch.begin({ sessionID: "child", callID: "omitted", model: effective, route, body })
        await SubagentDispatch.complete({
          sessionID: "child",
          callID: "omitted",
          model: effective,
          route,
          usage: { inputTokens: undefined, outputTokens: 12, totalTokens: undefined },
        })
        const state = (await SubagentBudget.read("child"))!
        expect(state.worker.spent).toBe(300)
        expect(state.worker.calls.omitted.state).toBe("pending")
        expect(state.worker.calls.omitted.amount).toBeGreaterThan(100)
        expect(state.pool.limits.usd).toBe(1000)
        await expect(
          SubagentDispatch.begin({ sessionID: "child", callID: "paid-switch", model: effective, route: "byok", body }),
        ).rejects.toThrow(/route/)
        const stopped = (await SubagentBudget.read("child"))!
        expect(stopped.worker.stopReason).toBe("route_changed")
        expect(stopped.worker.route).toBe(route)
        expect(stopped.worker.calls["paid-switch"]).toBeUndefined()
        expect(stopped.worker.spent).toBe(300)
        await SubagentBudget.release("child")
        await expect(
          SubagentBudget.open({
            ...input("child", "root", "usd", 1),
            assignmentID: "paid-followup",
            route: "byok",
          }),
        ).rejects.toThrow(/route/)
        expect((await SubagentBudget.read("child"))?.worker.unit).toBe("tokens")
        await SubagentBudget.open(input("new-paid", "root", "usd", 1))
        const mixed = (await SubagentBudget.snapshot("root"))!
        expect(mixed.available.usd).toBe(999)
        expect(mixed.workers.child.spent).toBe(300)
        expect(mixed.workers["new-paid"].spent).toBe(0)
      },
    })
  })
}

test("actual Task retains local allowance enforcement and accounting while trace sharing is off", async () => {
  const requests: unknown[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(await request.json())
      const chunk = (finish: boolean) =>
        `data: ${JSON.stringify({
          id: "matrix-privacy",
          object: "chat.completion.chunk",
          created: 1,
          model: model.modelID,
          choices: [
            {
              index: 0,
              delta: finish ? {} : { role: "assistant", content: "Outcome: Complete\nFindings: local evidence." },
              finish_reason: finish ? "stop" : null,
            },
          ],
          ...(finish
            ? {
                usage: {
                  prompt_tokens: 100,
                  completion_tokens: 50,
                  total_tokens: 150,
                  prompt_tokens_details: { cached_tokens: 40 },
                  completion_tokens_details: { reasoning_tokens: 20 },
                },
              }
            : {}),
        })}\n\n`
      return new Response(chunk(false) + chunk(true) + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  const previous = await Config.getGlobalRaw()
  const sharing = (await TraceQueue.read()).enabled
  await TraceQueue.setEnabled(false)
  await Config.updateGlobal(
    { subagents: { enabled: true, tokens: 200000, deadlineMs: 600000 } },
    { preserveInstances: true },
  )
  try {
    await using tmp = await tmpdir({
      git: true,
      config: {
        ...stressProviderConfig(`http://127.0.0.1:${server.port}/v1`),
        harness: { review: false, budget: false, unattended: false, deliverables: false, acceptance: false },
        agent: { probe: { mode: "subagent", prompt: "Return findings.", permission: { "*": "deny" } } },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const parent = await Session.create({ title: "Private matrix" })
        const userID = Identifier.ascending("message")
        await Session.updateMessage({
          id: userID,
          sessionID: parent.id,
          role: "user",
          effort: "normal",
          agent: "research",
          model,
          time: { created: Date.now() },
        })
        const execute = async (allocation?: number) => {
          const messageID = Identifier.ascending("message")
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
              description: "Private probe",
              prompt: "Return supported findings.",
              subagent_type: "probe",
              ...(allocation === undefined ? {} : { allocation: { tokens: allocation } }),
            },
            {
              sessionID: parent.id,
              messageID,
              callID: `call_${crypto.randomUUID()}`,
              agent: "research",
              abort: new AbortController().signal,
              messages: [],
              ask: async () => {},
              metadata: async () => {},
              extra: { bypassAgentCheck: true },
            },
          )
        }
        const first = await execute()
        expect(first.metadata.outcome).toBe("completed")
        const child = (await SubagentBudget.read(first.metadata.sessionId as string))!
        expect(child.worker.spent).toBe(300)
        expect(Object.values(child.worker.calls)).toHaveLength(2)
        expect(Object.values(child.worker.calls).map((call) => call.consumed)).toEqual([150, 150])
        expect(child.worker.active).toBe(false)
        expect(first.metadata.budget).toMatchObject({ unit: "tokens", spent: 300 })
        const count = requests.length
        expect(count).toBe(2)
        const limited = await execute(100)
        expect(limited.metadata.outcome).toBe("partial")
        expect(limited.metadata.stopReason).toBe("token_limit")
        expect(requests).toHaveLength(count)
        expect((await TraceQueue.status()).enabled).toBe(false)
        expect((await TraceQueue.status()).queued).toBe(0)
        expect((await SubagentBudget.snapshot(parent.id))?.available.tokens).toBe(199700)
      },
    })
  } finally {
    await Config.replaceGlobal(previous.content)
    await TraceQueue.setEnabled(sharing)
    server.stop(true)
  }
})

test("real recursive Task calls share one pool across paid, token, and paid worker models", async () => {
  const priced = "fixture-model-priced"
  const requests: { model: string; stage: string }[] = []
  const roots: { id?: string; directory?: string; admission?: Awaited<ReturnType<typeof SubagentBudget.snapshot>> } = {}
  const previous = await Config.getGlobalRaw()
  const settings = { enabled: true, usd: 1, tokens: 200000, deadlineMs: 600000 }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { model: string; messages: { role: string; content: unknown }[] }
      const text = JSON.stringify(body.messages)
      const title = text.includes("You are a title generator")
      const replay = body.messages.some((message) => message.role === "tool")
      const stage = title
        ? "title"
        : text.includes("MATRIX_TOKEN_BRIDGE")
          ? "bridge"
          : text.includes("MATRIX_PAID_LEAF")
            ? "leaf"
            : "outer"
      requests.push({ model: body.model, stage })
      const target = !title && !replay && stage !== "leaf" ? (stage === "outer" ? "bridge" : "leaf") : undefined
      if (target)
        await Config.updateGlobal(
          { subagents: { ...settings, model: `${model.providerID}/${target === "bridge" ? model.modelID : priced}` } },
          { preserveInstances: true },
        )
      if (stage === "leaf" && roots.id && roots.directory)
        roots.admission = await Instance.provide({
          directory: roots.directory,
          fn: () => SubagentBudget.snapshot(roots.id!),
        })
      const call = target
        ? {
            index: 0,
            id: `call_nested_${target}`,
            type: "function",
            function: {
              name: "task",
              arguments: JSON.stringify({
                description: target === "bridge" ? "Token bridge" : "Paid leaf",
                prompt:
                  target === "bridge"
                    ? "MATRIX_TOKEN_BRIDGE: delegate the final check to a worker, then return findings."
                    : "MATRIX_PAID_LEAF: return supported findings.",
                subagent_type: "probe",
                allocation: target === "bridge" ? { tokens: 50000 } : { usd: 0.05 },
              }),
            },
          }
        : undefined
      const chunk = (finish: boolean) =>
        `data: ${JSON.stringify({
          id: `matrix-${stage}`,
          object: "chat.completion.chunk",
          created: 1,
          model: body.model,
          choices: [
            {
              index: 0,
              delta: finish
                ? {}
                : call
                  ? { role: "assistant", tool_calls: [call] }
                  : {
                      role: "assistant",
                      content: title ? "Nested fixture" : "Outcome: Complete\nFindings: nested evidence.",
                    },
              finish_reason: finish ? (call ? "tool_calls" : "stop") : null,
            },
          ],
          ...(finish ? { usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } } : {}),
        })}\n\n`
      return new Response(chunk(false) + chunk(true) + "data: [DONE]\n\n", {
        headers: { "content-type": "text/event-stream" },
      })
    },
  })
  await Config.updateGlobal(
    { subagents: { ...settings, model: `${model.providerID}/${priced}` } },
    { preserveInstances: true },
  )
  try {
    const provider = stressProviderConfig(`http://127.0.0.1:${server.port}/v1`)
    await using tmp = await tmpdir({
      git: true,
      config: {
        ...provider,
        provider: {
          [model.providerID]: {
            ...provider.provider[STRESS_PROVIDER_ID],
            models: {
              ...provider.provider[STRESS_PROVIDER_ID].models,
              [priced]: {
                name: "Priced recursive fixture",
                tool_call: true,
                limit: { context: 128000, output: 4096 },
                cost: { input: 1, output: 2 },
              },
            },
          },
        },
        subagent_depth: 3,
        harness: { review: false, budget: false, unattended: false, deliverables: false, acceptance: false },
        agent: {
          probe: {
            mode: "subagent",
            prompt: "Use a worker when instructed, then return findings.",
            permission: { "*": "deny", task: "allow" },
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const parent = await Session.create({ title: "Recursive matrix" })
        roots.id = parent.id
        roots.directory = tmp.path
        const userID = Identifier.ascending("message")
        const messageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: userID,
          sessionID: parent.id,
          role: "user",
          effort: "normal",
          agent: "research",
          model,
          time: { created: Date.now() },
        })
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
        const result = await (
          await TaskTool.init()
        ).execute(
          {
            description: "Paid outer",
            prompt: "MATRIX_PAID_OUTER: delegate to a worker, then return findings.",
            subagent_type: "probe",
            allocation: { usd: 0.2 },
          },
          {
            sessionID: parent.id,
            messageID,
            callID: `call_${crypto.randomUUID()}`,
            agent: "research",
            abort: new AbortController().signal,
            messages: [],
            ask: async () => {},
            metadata: async () => {},
            extra: { bypassAgentCheck: true },
          },
        )
        expect(result.metadata.outcome).toBe("completed")
        const pool = (await SubagentBudget.snapshot(parent.id))!
        const outer = pool.workers[result.metadata.sessionId as string]
        const bridge = Object.values(pool.workers).find((worker) => worker.parentSessionID === outer.sessionID)!
        const leaf = Object.values(pool.workers).find((worker) => worker.parentSessionID === bridge?.sessionID)!
        expect(Object.values(pool.workers)).toHaveLength(3)
        expect(outer).toMatchObject({ unit: "usd", route: "local", limit: 200000000, model: { modelID: priced } })
        expect(bridge).toMatchObject({
          unit: "tokens",
          route: "local",
          limit: 50000,
          model: { modelID: model.modelID },
        })
        expect(leaf).toMatchObject({ unit: "usd", route: "local", limit: 50000000, model: { modelID: priced } })
        expect(roots.admission?.available).toEqual({ usd: 800000000, tokens: 150000 })
        expect(requests.filter((request) => request.model === priced)).toHaveLength(5)
        expect(requests.filter((request) => request.model === model.modelID)).toHaveLength(3)
        expect(outer.spent).toBe(600000)
        expect(bridge.spent).toBe(450)
        expect(leaf.spent).toBe(400000)
        expect(pool.available).toEqual({ usd: 999000000, tokens: 199550 })
        expect(Object.values(pool.workers).every((worker) => !worker.active && worker.outcome === "completed")).toBe(
          true,
        )
      },
    })
  } finally {
    await Config.replaceGlobal(previous.content)
    server.stop(true)
  }
})

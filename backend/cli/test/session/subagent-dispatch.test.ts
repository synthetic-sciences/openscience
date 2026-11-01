import { expect, test } from "bun:test"
import { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { SubagentBudget } from "../../src/session/subagent-budget"
import { SubagentDispatch } from "../../src/session/subagent-dispatch"
import { Tool } from "../../src/tool/tool"
import z from "zod"
import { tmpdir } from "../fixture/fixture"
import { stressProviderConfig, STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL } from "../fixture/stress-provider"

async function fixture(fn: (model: Provider.Model) => Promise<void>, unit: "tokens" | "usd" = "tokens") {
  const config = stressProviderConfig("http://127.0.0.1:9/v1")
  await using tmp = await tmpdir({
    git: true,
    config: {
      ...config,
      provider: {
        stress: {
          ...config.provider.stress,
          models: {
            ...config.provider.stress.models,
            [STRESS_PROVIDER_MODEL]: {
              ...config.provider.stress.models[STRESS_PROVIDER_MODEL],
              cost: { input: 1, output: 2 },
            },
          },
        },
      },
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const model = await Provider.getModel(STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL)
      await SubagentBudget.open({
        rootSessionID: "root",
        parentSessionID: "root",
        sessionID: "child",
        assignmentID: "task",
        objective: "test",
        expectedOutput: "report",
        model: { providerID: model.providerID, modelID: model.id },
        route: unit === "usd" ? "byok" : "local",
        unit,
        allocation: unit === "usd" ? SubagentBudget.dollars(0.2) : 10000,
        settings: { tokens: 20000, usd: 1 },
      })
      await fn(model)
    },
  })
}

test("dispatch preserves unbounded main calls but rejects child calls outside allowance", async () => {
  await fixture(async (model) => {
    expect(
      await SubagentDispatch.prepare({
        sessionID: "root",
        model,
        route: "local",
        inputTokens: 100000,
        maxOutputTokens: 1000,
      }),
    ).toBeUndefined()
    await expect(
      SubagentDispatch.prepare({
        sessionID: "child",
        model,
        route: "local",
        inputTokens: 11000,
        maxOutputTokens: 1000,
      }),
    ).rejects.toThrow(/limit/)
    expect((await SubagentBudget.read("child"))?.worker.stopReason).toBe("token_limit")
  })
})
test("measured75percent enters a bounded text handoff rather than trusting a prompt", async () => {
  await fixture(async (model) => {
    await SubagentBudget.reserve("child", "earlier", 7500)
    await SubagentBudget.settle("child", "earlier", 7500)
    const plan = await SubagentDispatch.prepare({
      sessionID: "child",
      model,
      route: "local",
      inputTokens: 1000,
      maxOutputTokens: 4000,
    })
    expect(plan?.wrapup).toBe(true)
    expect(plan?.maxOutputTokens).toBeLessThanOrEqual(1500)
    expect(plan?.notice).toContain("75%")
  })
})
test("actual wire dispatch reservation counts internal calls and retains unknown outcomes", async () => {
  await fixture(async (model) => {
    await SubagentDispatch.begin({
      sessionID: "child",
      callID: "summary",
      model,
      route: "local",
      body: JSON.stringify({ messages: [{ role: "user", content: "summary" }], max_tokens: 200 }),
      outputBound: 200,
    })
    expect((await SubagentBudget.read("child"))?.worker.calls.summary.state).toBe("pending")
    await SubagentDispatch.complete({
      sessionID: "child",
      callID: "summary",
      model,
      route: "local",
      usage: { inputTokens: 60, outputTokens: 20, totalTokens: 80 },
    })
    expect((await SubagentBudget.read("child"))?.worker.spent).toBe(80)
    await SubagentDispatch.complete({
      sessionID: "child",
      callID: "summary",
      model,
      route: "local",
      usage: { inputTokens: 60, outputTokens: 20, totalTokens: 80 },
    })
    expect((await SubagentBudget.read("child"))?.worker.spent).toBe(80)
  })
})
test("effective route changes stop a pinned worker before transport", async () => {
  await fixture(async (model) => {
    await expect(
      SubagentDispatch.prepare({ sessionID: "child", model, route: "byok", inputTokens: 10, maxOutputTokens: 100 }),
    ).rejects.toThrow(/route/)
    expect((await SubagentBudget.read("child"))?.worker.stopReason).toBe("route_changed")
  })
})
test("a non-cooperative worker cannot execute tools after entering wrap-up", async () => {
  await fixture(async () => {
    await SubagentBudget.wrapup("child")
    const actions: string[] = []
    const tool = await Tool.define("probe", {
      description: "fixture",
      parameters: z.object({}),
      execute: async () => {
        actions.push("executed")
        return { title: "fixture", metadata: {}, output: "done" }
      },
    }).init()
    await expect(
      tool.execute(
        {},
        {
          sessionID: "child",
          messageID: "msg_fixture",
          agent: "research",
          abort: new AbortController().signal,
          messages: [],
          metadata: async () => {},
          ask: async () => {},
        },
      ),
    ).rejects.toThrow(/handoff|wrap/i)
    expect(actions).toHaveLength(0)
  })
})
test("wrap-up cannot auto-continue after its final handoff call", async () => {
  await fixture(async (model) => {
    await SubagentBudget.wrapup("child")
    const body = JSON.stringify({ messages: [{ role: "user", content: "handoff" }], max_tokens: 100 })
    await SubagentDispatch.begin({
      sessionID: "child",
      callID: "handoff",
      model,
      route: "local",
      body,
      outputBound: 100,
    })
    await SubagentDispatch.complete({
      sessionID: "child",
      callID: "handoff",
      model,
      route: "local",
      usage: { inputTokens: 50, outputTokens: 50, totalTokens: 100 },
    })
    await expect(
      SubagentDispatch.begin({ sessionID: "child", callID: "extra", model, route: "local", body, outputBound: 100 }),
    ).rejects.toThrow(/wrap/)
  })
})
test("USD admission reconciles normal weighted prices without turning missing usage into zero", async () => {
  await fixture(async (model) => {
    const body = JSON.stringify({ messages: [{ role: "user", content: "priced" }], max_tokens: 100 })
    await SubagentDispatch.begin({ sessionID: "child", callID: "priced", model, route: "byok", body })
    await SubagentDispatch.complete({
      sessionID: "child",
      callID: "priced",
      model,
      route: "byok",
      usage: { inputTokens: 50, outputTokens: 20, totalTokens: 70 },
    })
    expect((await SubagentBudget.read("child"))?.worker.spent).toBe(90000)
    await SubagentDispatch.begin({ sessionID: "child", callID: "unknown", model, route: "byok", body })
    await SubagentDispatch.complete({
      sessionID: "child",
      callID: "unknown",
      model,
      route: "byok",
      usage: { inputTokens: undefined, outputTokens: undefined, totalTokens: undefined },
    })
    expect((await SubagentBudget.read("child"))?.worker.calls.unknown.state).toBe("pending")
  }, "usd")
})
test("an in-flight overrun is retained exactly and stops future calls", async () => {
  await fixture(async (model) => {
    await SubagentDispatch.begin({
      sessionID: "child",
      callID: "overrun",
      model,
      route: "byok",
      body: JSON.stringify({ max_tokens: 100 }),
    })
    await SubagentDispatch.complete({
      sessionID: "child",
      callID: "overrun",
      model,
      route: "byok",
      usage: { inputTokens: 1000000, outputTokens: 0, totalTokens: 1000000 },
    })
    expect((await SubagentBudget.read("child"))?.worker.spent).toBe(SubagentBudget.dollars(1))
    await expect(
      SubagentDispatch.prepare({ sessionID: "child", model, route: "byok", inputTokens: 10, maxOutputTokens: 10 }),
    ).rejects.toThrow(/budget/)
  }, "usd")
})

test("runtime tools reject cancelled assignments even without a wrap-up prompt", async () => {
  await fixture(async () => {
    const actions: string[] = []
    const tool = await Tool.define("probe", {
      description: "fixture",
      parameters: z.object({}),
      execute: async () => {
        actions.push("executed")
        return { title: "fixture", metadata: {}, output: "done" }
      },
    }).init()
    const context = {
      sessionID: "child",
      messageID: "msg_fixture",
      agent: "research",
      abort: new AbortController().signal,
      messages: [],
      metadata: async () => {},
      ask: async () => {},
    }
    await SubagentBudget.stop("child", "cancelled")
    await expect(tool.execute({}, context)).rejects.toThrow(/cancel/)
    expect(actions).toHaveLength(0)
  })
})

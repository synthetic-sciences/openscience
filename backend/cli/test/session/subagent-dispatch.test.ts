import { expect, spyOn, test } from "bun:test"
import { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { SubagentBudget } from "../../src/session/subagent-budget"
import { SubagentDispatch } from "../../src/session/subagent-dispatch"
import { Storage } from "../../src/storage/storage"
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

for (const format of ["openai", "anthropic", "responses", "google", "bedrock"] as const) {
  test(`${format} image requests fit the default token grant without charging base64 as text`, async () => {
    await fixture(async (model) => {
      await SubagentBudget.open({
        rootSessionID: "image-root",
        parentSessionID: "image-root",
        sessionID: "image-child",
        assignmentID: "image",
        objective: "Read a figure",
        expectedOutput: "Figure description",
        model: { providerID: model.providerID, modelID: model.id },
        route: "local",
        unit: "tokens",
        settings: { tokens: 1000000 },
      })
      const data = Buffer.alloc(1024 * 1024).toString("base64")
      const image =
        format === "google"
          ? { inlineData: { mimeType: "image/png", data } }
          : format === "bedrock"
            ? { image: { format: "png", source: { bytes: data } } }
            : format === "anthropic"
              ? { type: "image", source: { type: "base64", media_type: "image/png", data } }
              : format === "responses"
                ? { type: "input_image", image_url: `data:image/png;base64,${data}` }
                : { type: "image_url", image_url: { url: `data:image/png;base64,${data}` } }
      await SubagentDispatch.begin({
        sessionID: "image-child",
        callID: "image-call",
        model,
        route: "local",
        body: {
          messages: [{ role: "user", content: [{ type: "text", text: "Read the figure. ".repeat(2000) }, image] }],
          max_tokens: 32000,
        },
      })
      const state = (await SubagentBudget.read("image-child"))!
      expect(state.worker.limit).toBe(250000)
      expect(state.worker.calls["image-call"].state).toBe("pending")
      expect(state.worker.calls["image-call"].amount).toBeGreaterThan(35000)
      expect(state.worker.calls["image-call"].amount).toBeLessThan(70000)
    })
  })
}

for (const format of ["sdk", "anthropic", "responses", "google", "bedrock"] as const) {
  test(`${format} PDF requests reserve pages rather than encoded file bytes`, async () => {
    await fixture(async (model) => {
      const data = Buffer.from(
        `%PDF-1.4\n1 0 obj << /Type /Page >> endobj\n2 0 obj << /Type /Page >> endobj\n%${" ".repeat(1024 * 1024)}\n%%EOF`,
      ).toString("base64")
      const file =
        format === "google"
          ? { inlineData: { mimeType: "application/pdf", data } }
          : format === "bedrock"
            ? { document: { format: "pdf", name: "paper", source: { bytes: data } } }
            : format === "anthropic"
              ? { type: "document", source: { type: "base64", media_type: "application/pdf", data } }
              : format === "responses"
                ? { type: "input_file", filename: "paper.pdf", file_data: `data:application/pdf;base64,${data}` }
                : { type: "file", mediaType: "application/pdf", data }
      await SubagentBudget.open({
        rootSessionID: "pdf-root",
        parentSessionID: "pdf-root",
        sessionID: "pdf-child",
        assignmentID: "pdf",
        objective: "Read a paper",
        expectedOutput: "Summary",
        model: { providerID: model.providerID, modelID: model.id },
        route: "local",
        unit: "tokens",
        settings: { tokens: 1000000 },
      })
      await SubagentDispatch.begin({
        sessionID: "pdf-child",
        callID: "paper",
        model,
        route: "local",
        body: { messages: [{ role: "user", content: [file] }], max_tokens: 1000 },
      })
      const state = (await SubagentBudget.read("pdf-child"))!
      expect(state.worker.calls.paper.amount).toBeGreaterThan(7000)
      expect(state.worker.calls.paper.amount).toBeLessThan(12000)
    })
  })
}

test("base64 written as user text still consumes the text input allowance", async () => {
  await fixture(async (model) => {
    await expect(
      SubagentDispatch.begin({
        sessionID: "child",
        callID: "literal",
        model,
        route: "local",
        body: {
          messages: [
            { role: "user", content: [{ type: "text", text: `data:image/png;base64,${"A".repeat(100000)}` }] },
          ],
          max_tokens: 100,
        },
      }),
    ).rejects.toMatchObject({ reason: "token_limit" })
  })
})

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
test("measured75percent preserves work and uses the remaining allowance", async () => {
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
    expect(plan?.wrapup).toBe(false)
    expect(plan?.maxOutputTokens).toBe(1500)
    expect(plan?.notice).toBeUndefined()
    expect((await SubagentBudget.read("child"))!.worker.wrapup).toBeUndefined()
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

test("admission uses the current input and output without reserving another report call", async () => {
  await fixture(async (model) => {
    await SubagentBudget.open({
      rootSessionID: "larger",
      parentSessionID: "larger",
      sessionID: "large-child",
      assignmentID: "large",
      objective: "test",
      expectedOutput: "report",
      model: { providerID: model.providerID, modelID: model.id },
      route: "local",
      unit: "tokens",
      allocation: 100000,
      settings: { tokens: 100000 },
    })
    await SubagentBudget.reserve("large-child", "earlier", 60000)
    await SubagentBudget.settle("large-child", "earlier", 60000)
    const plan = await SubagentDispatch.prepare({
      sessionID: "large-child",
      model,
      route: "local",
      inputTokens: 30000,
      maxOutputTokens: 4000,
    })
    expect(plan?.wrapup).toBe(false)
    expect(plan?.maxOutputTokens).toBe(4000)
    expect(plan?.notice).toBeUndefined()
  })
})

test("Standard admission prices input separately and does not reserve unused Fast mode", async () => {
  await fixture(async (base) => {
    const model: Provider.Model = {
      ...base,
      cost: {
        input: 10,
        output: 50,
        cache: { read: 1, write: 12.5 },
        tiers: [{ input: 20, output: 75, cache: { read: 2, write: 25 }, threshold: 272000 }],
      },
      pricing: { upstream_provider: "openrouter", hosting_provider: "azure", funding_fee_bps: 0 },
      modes: {
        fast: {
          cost: {
            input: 20,
            output: 100,
            cache: { read: 2, write: 25 },
            tiers: [{ input: 40, output: 150, cache: { read: 4, write: 50 }, threshold: 272000 }],
          },
        },
      },
    }
    await SubagentBudget.open({
      rootSessionID: "standard-root",
      parentSessionID: "standard-root",
      sessionID: "standard-child",
      assignmentID: "standard-task",
      objective: "Read and review",
      expectedOutput: "Findings",
      model: { providerID: model.providerID, modelID: model.id },
      route: "managed",
      unit: "usd",
      allocation: SubagentBudget.dollars(1.25),
      settings: { usd: 5 },
    })
    const prepared = await SubagentDispatch.prepare({
      sessionID: "standard-child",
      model,
      route: "managed",
      inputTokens: 11000,
      maxOutputTokens: 32000,
    })
    expect(prepared?.maxOutputTokens).toBeGreaterThanOrEqual(512)
    expect(prepared?.wrapup).toBe(false)
    await SubagentDispatch.begin({
      sessionID: "standard-child",
      model,
      route: "managed",
      callID: "standard-request",
      body: { messages: [{ role: "user", content: "x".repeat(10000) }], max_tokens: prepared!.maxOutputTokens },
    })
    expect((await SubagentBudget.read("standard-child"))?.worker.calls["standard-request"].amount).toBeLessThan(
      SubagentBudget.dollars(1.25),
    )
  })
})

test("Fast admission keeps its own output price within the remaining allowance", async () => {
  await fixture(async (base) => {
    const model: Provider.Model = {
      ...base,
      modes: { fast: { cost: { input: 8, output: 16, cache: { read: 0, write: 0 } } } },
    }
    const standard = await SubagentDispatch.prepare({
      sessionID: "child",
      model,
      route: "byok",
      inputTokens: 1000,
      maxOutputTokens: 32000,
    })
    const fast = await SubagentDispatch.prepare({
      sessionID: "child",
      model,
      route: "byok",
      tier: "fast",
      inputTokens: 1000,
      maxOutputTokens: 32000,
    })
    expect(fast?.maxOutputTokens).toBeLessThan(standard!.maxOutputTokens)
    expect(fast?.wrapup).toBe(false)
    const body = JSON.stringify({ messages: [{ role: "user", content: "fast" }], max_tokens: 100 })
    await SubagentDispatch.begin({ sessionID: "child", model, route: "byok", callID: "standard", body })
    await SubagentDispatch.begin({ sessionID: "child", model, route: "byok", tier: "fast", callID: "fast", body })
    const state = (await SubagentBudget.read("child"))!
    expect(state.worker.calls.fast.amount).toBe(state.worker.calls.standard.amount * 8)
  }, "usd")
})

test("a thinking budget the provider adds to max_tokens is fitted inside the allowance", async () => {
  await fixture(async (model) => {
    const plan = await SubagentDispatch.prepare({
      sessionID: "child",
      model,
      route: "local",
      inputTokens: 1000,
      maxOutputTokens: 32000,
      thinkingTokens: 4000,
    })
    expect(plan).toMatchObject({ maxOutputTokens: 5000 })
    // Anthropic sends max_tokens = maxOutputTokens + thinking budget; that wire request must still be admitted.
    await SubagentDispatch.begin({
      sessionID: "child",
      model,
      route: "local",
      callID: "thinking",
      body: { messages: [{ role: "user", content: "x".repeat(10) }], max_tokens: plan!.maxOutputTokens + 4000 },
    })
    expect((await SubagentBudget.read("child"))?.worker.stopReason).toBeUndefined()
    await SubagentBudget.settle("child", "thinking", 0)
    await expect(
      SubagentDispatch.prepare({
        sessionID: "child",
        model,
        route: "local",
        inputTokens: 1000,
        maxOutputTokens: 32000,
        thinkingTokens: 9000,
      }),
    ).rejects.toMatchObject({ reason: "token_limit" })
  })
})

test("a call can use all remaining output capacity without a report reserve", async () => {
  await fixture(async (model) => {
    const plan = await SubagentDispatch.prepare({
      sessionID: "child",
      model,
      route: "local",
      inputTokens: 1000,
      maxOutputTokens: 32000,
    })
    expect(plan).toMatchObject({ maxOutputTokens: 9000, wrapup: false })
    expect(plan?.notice).toBeUndefined()
    await SubagentBudget.reserve("child", "work", 10000)
    await SubagentBudget.settle("child", "work", 10000)
    await expect(
      SubagentDispatch.prepare({ sessionID: "child", model, route: "local", inputTokens: 1, maxOutputTokens: 1 }),
    ).rejects.toMatchObject({ reason: "token_limit" })
  })
})

for (const elapsed of [7499, 7500, 9999]) {
  test(`assignment time at ${elapsed}/10000 ms keeps work enabled until the hard deadline`, async () => {
    await fixture(async (model) => {
      const now = Date.now()
      await SubagentBudget.open({
        rootSessionID: "time-root",
        parentSessionID: "time-root",
        sessionID: "time-child",
        assignmentID: "time",
        objective: "test",
        expectedOutput: "report",
        model: { providerID: model.providerID, modelID: model.id },
        route: "local",
        unit: "tokens",
        allocation: 100000,
        settings: { tokens: 100000 },
        acceptedAt: now - elapsed,
        deadline: now + (10000 - elapsed),
      })
      const clock = spyOn(Date, "now").mockReturnValue(now)
      try {
        const plan = await SubagentDispatch.prepare({
          sessionID: "time-child",
          model,
          route: "local",
          inputTokens: 10,
          maxOutputTokens: 100,
        })
        expect(plan).toMatchObject({ maxOutputTokens: 100, wrapup: false })
        expect(plan?.notice).toBeUndefined()
        expect((await SubagentBudget.read("time-child"))!.worker.wrapupReason).toBeUndefined()
      } finally {
        clock.mockRestore()
      }
    })
  })
}

test("runtime tools reject an inactive assignment without a model instruction", async () => {
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
    await SubagentBudget.release("child")
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
    ).rejects.toThrow(/active|cancel/)
    expect(actions).toHaveLength(0)
  })
})

test("elapsed time never grants a handoff beyond an exhausted allowance or expired deadline", async () => {
  await fixture(async (model) => {
    for (const [sessionID, acceptedAt, deadline, allocation, reason] of [
      ["expired", Date.now() - 10000, Date.now() - 1, 100000, "deadline"],
      ["unfunded", Date.now() - 8000, Date.now() + 2000, 1, "token_limit"],
    ] as const) {
      await SubagentBudget.open({
        rootSessionID: `${sessionID}-root`,
        parentSessionID: `${sessionID}-root`,
        sessionID,
        assignmentID: sessionID,
        objective: "test",
        expectedOutput: "report",
        model: { providerID: model.providerID, modelID: model.id },
        route: "local",
        unit: "tokens",
        acceptedAt,
        deadline,
        allocation,
        settings: { tokens: 100000 },
      })
      await expect(
        SubagentDispatch.prepare({ sessionID, model, route: "local", inputTokens: 10, maxOutputTokens: 100 }),
      ).rejects.toMatchObject({ reason })
      expect((await SubagentBudget.read(sessionID))!.worker.calls).toEqual({})
    }
  })
})

test("legacy contracts retain their hard deadline without inventing an earlier acceptance time", async () => {
  await fixture(async (model) => {
    const state = (await SubagentBudget.read("child"))!
    Reflect.deleteProperty(state.worker, "acceptedAt")
    state.worker.deadline = Date.now() + 2000
    await Storage.write(["subagent_budget", state.pool.projectID, state.pool.rootSessionID], state.pool)
    const plan = await SubagentDispatch.prepare({
      sessionID: "child",
      model,
      route: "local",
      inputTokens: 10,
      maxOutputTokens: 100,
    })
    expect(plan?.wrapup).toBe(false)
    expect((await SubagentBudget.read("child"))!.worker.acceptedAt).toBeUndefined()
  })
})

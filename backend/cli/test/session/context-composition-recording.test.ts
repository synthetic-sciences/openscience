import { expect, test } from "bun:test"
import { jsonSchema, tool } from "ai"
import type { StressScenario } from "../../../../evals/cadence-harness/stress-matrix"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { Storage } from "../../src/storage/storage"
import { tmpdir, trustProject } from "../fixture/fixture"
import {
  STRESS_PROVIDER_ID,
  STRESS_PROVIDER_MODEL,
  STRESS_SCENARIO_MARKER,
  startStressProvider,
  stressProviderConfig,
} from "../fixture/stress-provider"

const scenario: StressScenario = {
  id: "context-composition-recording",
  category: "chat",
  title: "Saved context composition",
  prompt: "Reply OK.",
  stimulus: { kind: "reply", text: "OK" },
  expect: { terminal: "completed", tools: 0, contains: ["OK"] },
}

test("preflight accounts for system, tool schemas and extra text exactly once", async () => {
  await using tmp = await tmpdir({ config: stressProviderConfig("http://127.0.0.1:1/v1") })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ title: "Composition counts" })
      const queued = await SessionPrompt.prompt({
        sessionID: session.id,
        noReply: true,
        model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
        parts: [{ type: "text", text: "USER" }],
      })
      if (queued.info.role !== "user") throw new Error("Expected queued user")
      const model = await Provider.getModel(STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL)
      const result = await SessionPrompt.contextPreflight({
        current: queued.info,
        messages: [queued],
        model,
        system: ["SYS!"],
        extra: "TAIL",
        tools: { lookup: tool({ description: "Find", inputSchema: jsonSchema({ type: "object", properties: {} }) }) },
      })
      expect(result.total).toBe(25)
      expect(result.newest).toBe(25)
      expect(result.history).toBe(0)
      expect(result.composition).toMatchObject({ system: 1, text: 2, definitions: 22, total: 25 })
    },
  })
})

test("a completed local provider call retains numeric context counts in message storage", async () => {
  const provider = startStressProvider([scenario])
  try {
    await using tmp = await tmpdir({
      git: true,
      config: stressProviderConfig(`http://127.0.0.1:${provider.server.port}/v1`),
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await trustProject()
        await Provider.invalidate()
      },
      fn: async () => {
        const session = await Session.create({ title: "Saved composition" })
        const response = await SessionPrompt.prompt({
          sessionID: session.id,
          model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
          agent: "research",
          system: `${STRESS_SCENARIO_MARKER}${scenario.id}`,
          parts: [{ type: "text", text: scenario.prompt }],
        })
        await provider.quiet()
        const saved = await Storage.read<Record<string, unknown>>(["message", session.id, response.info.id])
        expect(saved.contextComposition).toBeDefined()
        const context = MessageV2.ContextComposition.parse(saved.contextComposition)
        expect(context.source).toBe("estimate")
        const tokens = context.tokens
        expect(tokens.system).toBeGreaterThan(0)
        expect(tokens.definitions).toBeGreaterThan(0)
        expect(Object.values(tokens).reduce((sum, value) => sum + (value ?? 0), 0)).toBe(context.total)
        expect(JSON.stringify(context)).not.toContain(scenario.prompt)
        expect(JSON.stringify(context)).not.toContain(STRESS_SCENARIO_MARKER)
        expect(provider.main(scenario.id)).toHaveLength(1)
      },
    })
  } finally {
    provider.stop()
  }
}, 30000)

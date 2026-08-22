import { describe, expect, test } from "bun:test"
import type { StressScenario } from "../../../../evals/cadence-harness/stress-matrix"
import { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionResearch } from "../../src/session/research"
import { tmpdir, trustProject } from "../fixture/fixture"
import {
  STRESS_PROVIDER_ID,
  STRESS_PROVIDER_COMPACT_MODEL,
  STRESS_PROVIDER_MODEL,
  STRESS_SCENARIO_MARKER,
  startStressProvider,
  stressProviderConfig,
} from "../fixture/stress-provider"

const scenario: StressScenario = {
  id: "context-preflight",
  category: "chat",
  title: "Current-turn context preflight",
  prompt: "Acknowledge the context preflight fixture.",
  stimulus: { kind: "reply", text: "CONTEXT_PREFLIGHT_BASELINE" },
  expect: { terminal: "completed", tools: 0, contains: ["CONTEXT_PREFLIGHT_BASELINE"] },
}

describe("current-turn context preflight", () => {
  test("rejects a deterministically oversized newest turn without another provider dispatch", async () => {
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
          const session = await Session.create({ title: "Current-turn context preflight" })
          const model = { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL }
          const baseline = await SessionPrompt.prompt({
            sessionID: session.id,
            model,
            agent: "research",
            tools: { "*": false },
            system: `${STRESS_SCENARIO_MARKER}${scenario.id}`,
            parts: [{ type: "text", text: scenario.prompt }],
          })
          expect(baseline.info.role).toBe("assistant")
          if (baseline.info.role !== "assistant") throw new Error("Expected baseline assistant response")
          expect(baseline.info.tokens.input).toBe(12)
          await provider.quiet()
          const before = provider.requests.length
          await SessionResearch.define(session.id, {
            objective: "Verify zero-cost current-turn rejection",
            domain: "general",
            template: "minimal",
            limits: { modelCalls: 100 },
          })
          expect((await SessionResearch.read(session.id))?.budget.runtimeModelCalls).toBe(0)

          const oversized = await SessionPrompt.prompt({
            sessionID: session.id,
            model,
            agent: "research",
            tools: { "*": false },
            system: `${STRESS_SCENARIO_MARKER}${scenario.id}`,
            parts: [{ type: "text", text: `Oversized current request:\n${"x".repeat(600_000)}` }],
          })
          await provider.quiet()

          expect(provider.requests).toHaveLength(before)
          expect(oversized.info.role).toBe("assistant")
          if (oversized.info.role !== "assistant") throw new Error("Expected local terminal response")
          expect(oversized.info.tokens.input).toBe(0)
          expect(oversized.info.cost).toBe(0)
          expect(oversized.info.error?.data.message).toContain("cannot fit")
          expect(oversized.info.error?.data.message).toContain("No provider request was sent")
          expect((await SessionResearch.read(session.id))?.budget.runtimeModelCalls).toBe(0)
          await SessionResearch.remove(session.id)
        },
      })
    } finally {
      provider.stop()
    }
  }, 30_000)

  test("compacts reducible history before dispatching the current provider request", async () => {
    const provider = startStressProvider([scenario])
    try {
      const base = stressProviderConfig(`http://127.0.0.1:${provider.server.port}/v1`)
      base.provider[STRESS_PROVIDER_ID].models[STRESS_PROVIDER_COMPACT_MODEL].limit.context = 80_000
      await using tmp = await tmpdir({
        git: true,
        config: { ...base, compaction: { tailTurns: 1, tailTokens: 8_000 } },
      })
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          await trustProject()
          await Provider.invalidate()
        },
        fn: async () => {
          const session = await Session.create({ title: "Reducible current context" })
          const first = await SessionPrompt.prompt({
            sessionID: session.id,
            model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
            agent: "research",
            tools: { "*": false },
            system: `${STRESS_SCENARIO_MARKER}${scenario.id}`,
            parts: [{ type: "text", text: `Retain this bounded history:\n${"h".repeat(280_000)}` }],
          })
          expect(first.info.role).toBe("assistant")
          if (first.info.role !== "assistant") throw new Error("Expected first assistant response")
          expect(first.info.tokens.input).toBe(12)
          await provider.quiet()
          const before = provider.requests.length

          const result = await SessionPrompt.prompt({
            sessionID: session.id,
            model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_COMPACT_MODEL },
            agent: "research",
            tools: { "*": false },
            system: `${STRESS_SCENARIO_MARKER}${scenario.id}`,
            parts: [{ type: "text", text: "Answer the current request after reducing only the older history." }],
          })
          await provider.quiet()

          expect(result.info.role).toBe("assistant")
          if (result.info.role !== "assistant") throw new Error("Expected compacted assistant response")
          expect(result.info.error).toBeUndefined()
          const requests = provider.requests.slice(before)
          const summary = requests.findIndex((request) => request.kind === "summary")
          const main = requests.findIndex((request) => request.kind === "main" && request.scenario === scenario.id)
          expect(summary).toBeGreaterThanOrEqual(0)
          expect(main).toBeGreaterThan(summary)
        },
      })
    } finally {
      provider.stop()
    }
  }, 30_000)
})

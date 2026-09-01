import { describe, expect, test } from "bun:test"
import type { StressScenario } from "../../../../evals/cadence-harness/stress-matrix"
import { Provider } from "../../src/provider/provider"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionLoopState } from "../../src/session/loop-state"
import { MessageV2 } from "../../src/session/message-v2"
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
  test("automatically compacts and resumes a rejected newest turn exactly once", async () => {
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
            system: `${STRESS_SCENARIO_MARKER}${scenario.id}`,
            parts: [
              {
                type: "text",
                text: `MATRIX_OBJECTIVE: Download the SRA runs, build the genome index, align the reads, and run the quantification pipeline.\n${"x".repeat(600_000)}`,
              },
            ],
          })
          await provider.quiet()

          const requests = provider.requests.slice(before)
          const summary = requests.findIndex((request) => request.kind === "summary")
          const main = requests.findIndex((request) => request.kind === "main" && request.scenario === scenario.id)
          expect(summary).toBeGreaterThanOrEqual(0)
          expect(main).toBeGreaterThan(summary)
          expect(oversized.info.role).toBe("assistant")
          if (oversized.info.role !== "assistant") throw new Error("Expected recovered assistant response")
          expect(oversized.info.error).toBeUndefined()

          const history = await Session.messages({ sessionID: session.id })
          const recoveries = history.filter(
            (message) => message.info.role === "user" && SessionLoopState.messageKind(message.info) === "context",
          )
          const carriers = history.filter(
            (message) =>
              message.info.role === "user" &&
              message.info.internal?.type === "compaction" &&
              message.info.internal.recovery?.type === "preflight",
          )
          const rejections = history.filter(
            (message) =>
              message.info.role === "assistant" &&
              message.info.error?.data.message.includes("cannot fit") &&
              message.info.error.data.message.includes("No provider request was sent"),
          )
          expect(recoveries).toHaveLength(1)
          expect(carriers).toHaveLength(1)
          expect(rejections).toHaveLength(1)
          expect(SessionLoopState.routing(history)).toContain("genome index")
          expect(requests[main]?.text).toContain("MATRIX_OBJECTIVE")
          expect(requests[main]?.tools).toContain("compute_job")
          expect(requests[main]?.tools).not.toContain("modal")
          await SessionResearch.remove(session.id)
        },
      })
    } finally {
      provider.stop()
    }
  }, 30_000)

  test("leaves an oversized newest turn terminal when automatic compaction is disabled", async () => {
    const provider = startStressProvider([scenario])
    try {
      const base = stressProviderConfig(`http://127.0.0.1:${provider.server.port}/v1`)
      await using tmp = await tmpdir({
        git: true,
        config: { ...base, compaction: { auto: false } },
      })
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          await trustProject()
          await Provider.invalidate()
        },
        fn: async () => {
          const session = await Session.create({ title: "Disabled context preflight recovery" })
          const model = { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL }
          const result = await SessionPrompt.prompt({
            sessionID: session.id,
            model,
            agent: "research",
            tools: { "*": false },
            system: `${STRESS_SCENARIO_MARKER}${scenario.id}`,
            parts: [{ type: "text", text: `Oversized request with recovery disabled:\n${"x".repeat(600_000)}` }],
          })
          await provider.quiet()

          expect(result.info.role).toBe("assistant")
          if (result.info.role !== "assistant") throw new Error("Expected terminal assistant response")
          expect(result.info.error?.name).toBe("UnknownError")
          expect(provider.requests).toHaveLength(0)
          const before = await Session.messages({ sessionID: session.id })
          expect(SessionLoopState.pendingPreflight(before)).toBeUndefined()
          expect(
            before.filter(
              (message) => message.info.role === "user" && SessionLoopState.messageKind(message.info) === "context",
            ),
          ).toHaveLength(0)

          const restarted = await SessionPrompt.loop(session.id)
          await provider.quiet()
          expect(restarted.info.id).toBe(result.info.id)
          expect(provider.requests).toHaveLength(0)
          const after = await Session.messages({ sessionID: session.id })
          expect(SessionLoopState.pendingPreflight(after)).toBeUndefined()
          expect(
            after.filter(
              (message) => message.info.role === "user" && SessionLoopState.messageKind(message.info) === "context",
            ),
          ).toHaveLength(0)
        },
      })
    } finally {
      provider.stop()
    }
  }, 30_000)

  test("repairs a crash after the preflight error but before its continuation", async () => {
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
          const session = await Session.create({ title: "Interrupted context preflight" })
          const model = { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL }
          const source = await SessionPrompt.prompt({
            sessionID: session.id,
            model,
            agent: "research",
            noReply: true,
            tools: { "*": false },
            system: `${STRESS_SCENARIO_MARKER}${scenario.id}`,
            parts: [{ type: "text", text: `Interrupted oversized request:\n${"x".repeat(600_000)}` }],
          })
          if (source.info.role !== "user") throw new Error("Expected queued user message")
          await Session.updateMessage({
            id: await MessageV2.nextMessageID(session.id),
            sessionID: session.id,
            parentID: source.info.id,
            role: "assistant",
            mode: "research",
            agent: "research",
            path: { cwd: tmp.path, root: tmp.path },
            modelID: model.modelID,
            providerID: model.providerID,
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            error: new MessageV2.ContextWindowError({ message: "No provider request was sent." }).toObject(),
            time: { created: Date.now(), completed: Date.now() },
          })

          const before = provider.requests.length
          const result = await SessionPrompt.loop(session.id)
          await provider.quiet()

          expect(result.info.role).toBe("assistant")
          if (result.info.role !== "assistant") throw new Error("Expected recovered assistant response")
          expect(result.info.error).toBeUndefined()
          const requests = provider.requests.slice(before)
          const summary = requests.findIndex((request) => request.kind === "summary")
          const main = requests.findIndex((request) => request.kind === "main" && request.scenario === scenario.id)
          expect(summary).toBeGreaterThanOrEqual(0)
          expect(main).toBeGreaterThan(summary)
          const history = await Session.messages({ sessionID: session.id })
          expect(
            history.filter(
              (message) => message.info.role === "user" && SessionLoopState.messageKind(message.info) === "context",
            ),
          ).toHaveLength(1)
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

  test("does not mistake a delayed prior-turn assistant for an answer to a queued prompt", async () => {
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
          const session = await Session.create({ title: "Queued prompt ownership" })
          const model = { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL }
          const first = await SessionPrompt.prompt({
            sessionID: session.id,
            model,
            agent: "research",
            noReply: true,
            tools: { "*": false },
            parts: [{ type: "text", text: "Earlier request captured by the first provider snapshot." }],
          })
          const queued = await SessionPrompt.prompt({
            sessionID: session.id,
            model,
            agent: "research",
            noReply: true,
            tools: { "*": false },
            system: `${STRESS_SCENARIO_MARKER}${scenario.id}`,
            parts: [{ type: "text", text: scenario.prompt }],
          })
          if (first.info.role !== "user" || queued.info.role !== "user")
            throw new Error("Expected queued user messages")
          const delayed = await MessageV2.nextMessageID(session.id)
          await Session.updateMessage({
            id: delayed,
            sessionID: session.id,
            parentID: first.info.id,
            role: "assistant",
            mode: "research",
            agent: "research",
            path: { cwd: tmp.path, root: tmp.path },
            modelID: model.modelID,
            providerID: model.providerID,
            cost: 0,
            tokens: { input: 12, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "stop",
            time: { created: Date.now(), completed: Date.now() },
          })
          await Session.updatePart({
            id: `prt_${crypto.randomUUID().replaceAll("-", "").slice(0, 26)}`,
            sessionID: session.id,
            messageID: delayed,
            type: "text",
            text: "Answer to only the earlier request.",
            time: { start: Date.now(), end: Date.now() },
          })

          const result = await SessionPrompt.loop(session.id)
          await provider.quiet()

          expect(result.info.role).toBe("assistant")
          if (result.info.role !== "assistant") throw new Error("Expected queued prompt response")
          expect(result.info.parentID).toBe(queued.info.id)
          expect(provider.main(scenario.id)).toHaveLength(1)
          expect(provider.main(scenario.id)[0]?.text).toContain(scenario.prompt)
          expect(provider.main(scenario.id)[0]?.text).toContain("remains unanswered")
        },
      })
    } finally {
      provider.stop()
    }
  }, 30_000)

  test("keeps every queued unanswered prompt verbatim through automatic compaction", async () => {
    const provider = startStressProvider([scenario])
    try {
      const base = stressProviderConfig(`http://127.0.0.1:${provider.server.port}/v1`)
      base.provider[STRESS_PROVIDER_ID].models[STRESS_PROVIDER_COMPACT_MODEL].limit.context = 80_000
      await using tmp = await tmpdir({
        git: true,
        config: { ...base, compaction: { tailTurns: 1, tailTokens: 1 } },
      })
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          await trustProject()
          await Provider.invalidate()
        },
        fn: async () => {
          const session = await Session.create({ title: "Queued prompt compaction" })
          await SessionPrompt.prompt({
            sessionID: session.id,
            model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
            agent: "research",
            tools: { "*": false },
            system: `${STRESS_SCENARIO_MARKER}${scenario.id}`,
            parts: [{ type: "text", text: `${scenario.prompt}\n${"h".repeat(280_000)}` }],
          })
          await provider.quiet()
          const before = provider.requests.length
          const first = "FIRST_QUEUED_PROMPT_MUST_REMAIN_VERBATIM"
          const second = "SECOND_QUEUED_PROMPT_MUST_REMAIN_VERBATIM"
          await SessionPrompt.prompt({
            sessionID: session.id,
            model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_COMPACT_MODEL },
            agent: "research",
            tools: { "*": false },
            noReply: true,
            parts: [{ type: "text", text: `${first}\n${"q".repeat(8_000)}` }],
          })
          await SessionPrompt.prompt({
            sessionID: session.id,
            model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_COMPACT_MODEL },
            agent: "research",
            tools: { "*": false },
            noReply: true,
            system: `${STRESS_SCENARIO_MARKER}${scenario.id}`,
            parts: [{ type: "text", text: `${second}\n${"r".repeat(8_000)}` }],
          })

          const result = await SessionPrompt.loop(session.id)
          await provider.quiet()

          expect(result.info.role).toBe("assistant")
          const requests = provider.requests.slice(before)
          const summary = requests.find((request) => request.kind === "summary")
          const main = requests.find((request) => request.kind === "main" && request.scenario === scenario.id)
          if (!summary || !main) throw new Error("Expected summary and resumed provider requests")
          expect(summary.text).not.toContain(first)
          expect(summary.text).not.toContain(second)
          expect(main.text).toContain(first)
          expect(main.text).toContain(second)
        },
      })
    } finally {
      provider.stop()
    }
  }, 30_000)
})

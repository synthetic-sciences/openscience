import { afterEach, beforeEach, expect, test } from "bun:test"
import { ArtifactStore } from "../../src/artifact/store"
import { Instance } from "../../src/project/instance"
import type { MessageV2 } from "../../src/session/message-v2"
import { SessionResearch } from "../../src/session/research"
import { SessionProcessor } from "../../src/session/processor"
import { ResearchContractTool } from "../../src/tool/research-contract"
import { executionSession, tmpdir } from "../fixture/fixture"

beforeEach(() => ArtifactStore.reset())
afterEach(() => ArtifactStore.reset())

const context = (sessionID: string, messages: MessageV2.WithParts[] = []) => ({
  sessionID,
  messageID: "msg_research_contract",
  callID: "call_research_contract",
  agent: "research",
  abort: new AbortController().signal,
  messages,
  metadata() {},
  async ask() {},
})

function request(sessionID: string, text: string): MessageV2.WithParts {
  const id = "msg_research_request"
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "research",
      model: { providerID: "test", modelID: "test" },
      effort: "normal",
    },
    parts: [{ id: "part_research_request", sessionID, messageID: id, type: "text", text }],
  }
}

test("hard runtime ceilings use only exact authority from the current user request", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await executionSession()
      const tool = await ResearchContractTool.init()
      try {
        await tool.execute(
          {
            action: "define",
            objective: "Run an extensive study",
            max_tokens: 500_000,
          },
          context(session.id, [request(session.id, "Keep going for hours; do not set a token budget.")]),
        )
        expect((await SessionResearch.read(session.id))?.budget).toMatchObject({
          reserveUsd: 1,
          limits: { modelCalls: 128, toolCalls: 1_024, tokens: 20_000_000, wallClockMs: 86_400_000, costUsd: 200 },
        })
        await SessionResearch.remove(session.id)

        await tool.execute(
          {
            action: "define",
            objective: "Run a bounded study",
            max_model_calls: 12,
            max_tool_calls: 200,
            max_tokens: 500_000,
            max_minutes: 90,
            max_cost_usd: 25,
          },
          context(session.id, [
            request(
              session.id,
              "Use a hard maximum of 12 model calls, a 200 tool-call cap, a 500,000 token limit, at most 90 minutes, and a $25 cost ceiling.",
            ),
          ]),
        )
        expect((await SessionResearch.read(session.id))?.budget.limits).toMatchObject({
          modelCalls: 12,
          toolCalls: 200,
          tokens: 500_000,
          wallClockMs: 90 * 60_000,
          costUsd: 25,
        })

        await SessionResearch.remove(session.id)
        await tool.execute(
          { action: "define", objective: "Honor a negative-form ceiling", max_tokens: 500_000 },
          context(session.id, [request(session.id, "Do not exceed 500,000 tokens.")]),
        )
        expect((await SessionResearch.read(session.id))?.budget.limits.tokens).toBe(500_000)
      } finally {
        await SessionResearch.remove(session.id)
      }
    },
  })
})

test("define ignores unrelated autofilled action fields and unrequested sentinel limits", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await executionSession()
      const tool = await ResearchContractTool.init()
      try {
        await tool.execute(
          {
            action: "define",
            objective: "Run the approved empirical workflow",
            domain: "ml",
            template: "empirical",
            deliverables: [{ path: "paper/main.pdf", label: "Paper", required: true }],
            reserve_usd: 0,
            max_model_calls: 1,
            max_tool_calls: 1,
            max_tokens: 1,
            max_minutes: 1,
            max_cost_usd: 1,
            stage: "setup",
            check: "initialized",
            label: "Initialize workflow",
            status: "running",
            evidence: "Implementation has not begun.",
            evidence_refs: ["tool:compute_job"],
            detail: "Start locally before paid dispatch.",
            candidate: "benchmark",
            message: "Begin.",
            disposition: "none",
            branch: "main",
            outcome: "neutral",
            summary: "Initialized.",
            metric: { name: "placeholder", value: 0, direction: "maximize", baseline: 0, target: 0, unit: "none" },
            source_trial: "none",
            situation: "setup",
            guidance: "Proceed.",
            lesson: "lesson-00000000000000000000",
            reason: "Authorized.",
          },
          context(session.id, [request(session.id, "Start the workflow. Modal is enabled.")]),
        )
        expect(await SessionResearch.read(session.id)).toMatchObject({
          objective: "Run the approved empirical workflow",
          domain: "ml",
          budget: {
            reserveUsd: 1,
            limits: { modelCalls: 128, toolCalls: 1_024, tokens: 20_000_000, wallClockMs: 86_400_000, costUsd: 200 },
          },
        })
      } finally {
        await SessionResearch.remove(session.id)
      }
    },
  })
})

test("tool evidence errors explain that references point to prior calls", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await executionSession()
      const tool = await ResearchContractTool.init()
      try {
        await tool.execute({ action: "define", objective: "Verify a compute result" }, context(session.id))
        await expect(
          tool.execute(
            {
              action: "check",
              check: "compute",
              status: "passed",
              evidence_refs: ["tool:compute_job"],
            },
            context(session.id),
          ),
        ).rejects.toThrow("looks backward for an earlier completed compute_job call; it does not run that tool")
      } finally {
        await SessionResearch.remove(session.id)
      }
    },
  })
})

test("semantic tool-error loops normalize dynamic evidence selectors", () => {
  const failure = (id: string, error: string): MessageV2.ToolPart => ({
    id: `prt_${id}`,
    sessionID: "ses_loop",
    messageID: "msg_loop",
    type: "tool",
    callID: `call_${id}`,
    tool: "research_contract",
    state: { status: "error", input: {}, error, time: { start: 1, end: 2 } },
  })
  const parts = [
    failure("one", "Evidence reference tool:compute_job looks backward for an earlier completed call"),
    failure("two", "Evidence reference tool:research_search looks backward for an earlier completed call"),
  ]

  expect(SessionProcessor.isToolErrorLoop(parts, "research_contract")).toBe(true)
  expect(
    SessionProcessor.isToolErrorLoop(
      [...parts.slice(0, 1), failure("three", "max_model_calls=1 is not an exact hard ceiling")],
      "research_contract",
    ),
  ).toBe(false)
})

test("research checks settle only from a runtime-verified immutable Result", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await executionSession()
      const tool = await ResearchContractTool.init()
      try {
        await tool.execute(
          { action: "define", objective: "Verify the report", domain: "general", template: "minimal" },
          context(session.id),
        )
        await expect(
          tool.execute(
            {
              action: "check",
              check: "artifact-inspection",
              status: "passed",
              evidence: "report.md looks correct",
            },
            context(session.id),
          ),
        ).rejects.toThrow("runtime-verified evidence references")

        const saved = await ArtifactStore.save({
          projectID: Instance.project.id,
          sessionID: session.id,
          sourcePath: "report.md",
          filename: "report.md",
          kind: "report",
          content: new Blob(["# Verified report\n"]),
        })
        const checked = await tool.execute(
          {
            action: "check",
            check: "artifact-inspection",
            status: "passed",
            evidence: "Inspected the immutable report",
            evidence_refs: [`artifact:${saved.id}`],
          },
          context(session.id),
        )
        expect(checked.metadata.researchContract).toMatchObject({ passedChecks: 1 })
        expect((await SessionResearch.read(session.id))?.checks[0]).toMatchObject({
          status: "passed",
          evidenceRefs: [
            {
              kind: "artifact",
              artifactID: saved.id,
              versionID: saved.current.id,
              path: "report.md",
              sha256: saved.current.sha256,
            },
          ],
        })
      } finally {
        await SessionResearch.remove(session.id)
      }
    },
  })
})

test("quantitative trials reject outcome labels that contradict a directed metric", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await executionSession()
      const tool = await ResearchContractTool.init()
      try {
        await tool.execute(
          { action: "define", objective: "Improve validation accuracy", domain: "ml", template: "minimal" },
          context(session.id),
        )
        const saved = await ArtifactStore.save({
          projectID: Instance.project.id,
          sessionID: session.id,
          sourcePath: "metrics.json",
          filename: "metrics.json",
          kind: "dataset",
          content: new Blob(['{"accuracy":0.81}\n']),
        })
        await expect(
          tool.execute(
            {
              action: "trial",
              stage: "select",
              branch: "candidate",
              candidate: "new classifier",
              outcome: "advanced",
              summary: "Candidate evaluation",
              evidence_refs: [`artifact:${saved.id}`],
              metric: { name: "accuracy", value: 0.81, baseline: 0.84, direction: "maximize" },
            },
            context(session.id),
          ),
        ).rejects.toThrow("Advanced outcome contradicts the metric")
      } finally {
        await SessionResearch.remove(session.id)
      }
    },
  })
})

test("preregister freezes the exact immutable plan Result and cannot be replaced", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await executionSession()
      const tool = await ResearchContractTool.init()
      try {
        await tool.execute(
          { action: "define", objective: "Preregister an analysis", domain: "statistics", template: "empirical" },
          context(session.id),
        )
        const first = await ArtifactStore.save({
          projectID: Instance.project.id,
          sessionID: session.id,
          sourcePath: "analysis-plan.md",
          filename: "analysis-plan.md",
          kind: "report",
          content: new Blob(["# Frozen analysis plan\n"]),
        })
        const frozen = await tool.execute(
          { action: "preregister", evidence_refs: [`artifact:${first.id}`] },
          context(session.id),
        )
        expect(frozen.title).toBe("Research plan preregistered")
        expect(frozen.metadata.researchContract).toMatchObject({
          preregistrationVersionID: first.currentVersionID,
        })
        expect((await SessionResearch.read(session.id))?.preregistration).toMatchObject({
          artifact: {
            artifactID: first.id,
            versionID: first.currentVersionID,
            sha256: first.current.sha256,
          },
          frozenAt: expect.any(Number),
        })

        const changed = await ArtifactStore.save({
          projectID: Instance.project.id,
          sessionID: session.id,
          sourcePath: "analysis-plan.md",
          filename: "analysis-plan.md",
          kind: "report",
          content: new Blob(["# Changed analysis plan\n"]),
        })
        expect(changed.currentVersionID).not.toBe(first.currentVersionID)
        await expect(
          tool.execute({ action: "preregister", evidence_refs: [`artifact:${first.id}`] }, context(session.id)),
        ).rejects.toThrow(`already frozen at ${first.currentVersionID}`)
      } finally {
        await SessionResearch.remove(session.id)
      }
    },
  })
})

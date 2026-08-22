import { afterEach, beforeEach, expect, test } from "bun:test"
import { ArtifactStore } from "../../src/artifact/store"
import { Instance } from "../../src/project/instance"
import type { MessageV2 } from "../../src/session/message-v2"
import { SessionResearch } from "../../src/session/research"
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

test("hard runtime ceilings require exact authority from the current user request", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await executionSession()
      const tool = await ResearchContractTool.init()
      try {
        await expect(
          tool.execute(
            {
              action: "define",
              objective: "Run an extensive study",
              max_tokens: 500_000,
            },
            context(session.id, [request(session.id, "Keep going for hours; do not set a token budget.")]),
          ),
        ).rejects.toThrow("max_tokens=500000 is not an exact hard ceiling authorized by the current user request")
        expect(await SessionResearch.read(session.id)).toBeUndefined()

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

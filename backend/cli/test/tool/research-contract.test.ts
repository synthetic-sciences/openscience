import { afterEach, beforeEach, expect, test } from "bun:test"
import { ArtifactStore } from "../../src/artifact/store"
import { Instance } from "../../src/project/instance"
import { SessionResearch } from "../../src/session/research"
import { ResearchContractTool } from "../../src/tool/research-contract"
import { executionSession, tmpdir } from "../fixture/fixture"

beforeEach(() => ArtifactStore.reset())
afterEach(() => ArtifactStore.reset())

const context = (sessionID: string) => ({
  sessionID,
  messageID: "msg_research_contract",
  callID: "call_research_contract",
  agent: "research",
  abort: new AbortController().signal,
  messages: [],
  metadata() {},
  async ask() {},
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

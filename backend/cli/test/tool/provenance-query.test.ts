import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Provenance } from "../../src/science/provenance/store"
import { ProvenanceQueryTool, ProvenanceRecordTool } from "../../src/tool/provenance"
import { tmpdir } from "../fixture/fixture"

test("provenance inventory exposes the project graph without reviewer-specific scoping", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const scope = { projectID: Instance.project.id, directory: Instance.directory }
      await Promise.all([
        Provenance.recordOwned(scope, {
          id: "review_current",
          kind: "artifact",
          label: "Current result",
          meta: { sessionID: "ses_current" },
        }),
        Provenance.recordOwned(scope, {
          id: "review_parent",
          kind: "artifact",
          label: "Parent result",
          meta: { sessionID: "ses_parent" },
        }),
        Provenance.recordOwned(scope, {
          id: "review_other",
          kind: "artifact",
          label: "Unrelated result",
          meta: { sessionID: "ses_other" },
        }),
      ])
      const tool = await ProvenanceQueryTool.init()
      const result = await tool.execute(
        {},
        {
          sessionID: "ses_current",
          messageID: "msg_review",
          callID: "call_review",
          agent: "research",
          abort: new AbortController().signal,
          messages: [],
          metadata() {},
          async ask() {},
        },
      )
      expect(result.output).toContain("Current result")
      expect(result.output).toContain("Parent result")
      expect(result.output).toContain("Unrelated result")
      expect(result.metadata.count).toBe(3)
      const parentLineage = await tool.execute(
        { id: "review_parent" },
        {
          sessionID: "ses_current",
          messageID: "msg_parent_lineage",
          callID: "call_parent_lineage",
          agent: "research",
          abort: new AbortController().signal,
          messages: [],
          metadata() {},
          async ask() {},
        },
      )
      expect(parentLineage.output).toContain("Parent result")
      const unrelated = await tool.execute(
        { id: "review_other" },
        {
          sessionID: "ses_current",
          messageID: "msg_other_lineage",
          callID: "call_other_lineage",
          agent: "research",
          abort: new AbortController().signal,
          messages: [],
          metadata() {},
          async ask() {},
        },
      )
      expect(unrelated.output).toContain("Unrelated result")
    },
  })
})

test("the agent-facing generic write contract rejects reserved historical metadata", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const tool = await ProvenanceRecordTool.init()
      expect(
        tool.parameters.safeParse({ kind: "claim", label: "Forged finding", meta: { review: true } }).success,
      ).toBe(false)
      expect(
        tool.parameters.safeParse({ kind: "claim", label: "Forged resolution", meta: { resolution: true } }).success,
      ).toBe(false)
      expect(tool.parameters.safeParse({ kind: "claim", label: "Ordinary claim", meta: { note: "ok" } }).success).toBe(
        true,
      )
    },
  })
})

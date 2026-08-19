import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Provenance } from "../../src/science/provenance/store"
import { Review } from "../../src/science/provenance/review"
import { ProvenanceQueryTool, ProvenanceResolveTool } from "../../src/tool/provenance"
import { Session } from "../../src/session"
import { tmpdir } from "../fixture/fixture"

test("reviewer provenance inventory includes its direct parent but excludes unrelated sessions", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const scope = { projectID: Instance.project.id, directory: Instance.directory }
      const parent = await Session.create({})
      const child = await Session.create({ parentID: parent.id })
      await Promise.all([
        Provenance.recordOwned(scope, {
          id: "review_current",
          kind: "artifact",
          label: "Current result",
          meta: { sessionID: child.id },
        }),
        Provenance.recordOwned(scope, {
          id: "review_parent",
          kind: "artifact",
          label: "Parent result",
          meta: { sessionID: parent.id },
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
          sessionID: child.id,
          messageID: "msg_review",
          callID: "call_review",
          agent: "review",
          abort: new AbortController().signal,
          messages: [],
          metadata() {},
          async ask() {},
        },
      )
      expect(result.output).toContain("Current result")
      expect(result.output).toContain("Parent result")
      expect(result.output).not.toContain("Unrelated result")
      expect(result.metadata.count).toBe(2)
      const parentLineage = await tool.execute(
        { id: "review_parent" },
        {
          sessionID: child.id,
          messageID: "msg_parent_lineage",
          callID: "call_parent_lineage",
          agent: "review",
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
          sessionID: child.id,
          messageID: "msg_other_lineage",
          callID: "call_other_lineage",
          agent: "review",
          abort: new AbortController().signal,
          messages: [],
          metadata() {},
          async ask() {},
        },
      )
      expect(unrelated).toMatchObject({ output: 'No node "review_other".', metadata: { count: 0, edges: 0 } })
      await Session.remove(parent.id)
    },
  })
})

test("an author can address a finding only for a later reviewer to confirm", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const scope = { projectID: Instance.project.id, directory: Instance.directory }
      await Provenance.recordOwned(scope, {
        id: "review_target",
        kind: "artifact",
        label: "Result",
        meta: { sessionID: "ses_review" },
      })
      const finding = await Review.record({
        target: "review_target",
        finding: { claim: "value", issue: "wrong", severity: "major", evidence: "metrics.json:2" },
        verdict: "refutes",
        reviewer: "reviewer",
        sessionID: "ses_review",
        messageID: "msg_reviewer",
        callID: "call_reviewer",
        ...scope,
      })
      const tool = await ProvenanceResolveTool.init()
      const context = {
        sessionID: "ses_review",
        messageID: "msg_author",
        callID: "call_author",
        agent: "research" as const,
        abort: new AbortController().signal,
        messages: [],
        metadata() {},
        async ask() {},
      }
      await tool.execute(
        { finding: finding.node.id, reason: "Corrected in replacement artifact review_target_v2" },
        context,
      )
      expect((await Review.list(scope)).find((entry) => entry.finding.id === finding.node.id)?.status).toBe("addressed")
      await expect(
        tool.execute(
          { finding: finding.node.id, reason: "Reviewer tries to resolve its own finding" },
          { ...context, agent: "reviewer" },
        ),
      ).rejects.toThrow("Reviewers cannot mark their own findings")
      await Review.record({
        target: "review_target",
        confirms: finding.node.id,
        finding: { claim: "value", issue: "verified", severity: "info", evidence: "replacement run" },
        verdict: "supports",
        reviewer: "reviewer",
        sessionID: "ses_review",
        messageID: "msg_confirm",
        callID: "call_confirm",
        ...scope,
      })
      expect((await Review.list(scope)).find((entry) => entry.finding.id === finding.node.id)?.status).toBe("confirmed")
    },
  })
})

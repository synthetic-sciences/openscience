import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Provenance } from "../../src/science/provenance/store"
import { Review } from "../../src/science/provenance/review"
import { tmpdir } from "../fixture/fixture"

const scope = () => ({ projectID: Instance.project.id, directory: Instance.directory })

test("findings carry message linkage and walk the open → addressed → confirmed lifecycle", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const target = await Provenance.recordOwned(scope(), {
        kind: "artifact",
        label: "results table",
        artifactType: "dataset",
      } as Parameters<typeof Provenance.record>[0])

      const { node } = await Review.record({
        target: target.id,
        finding: {
          claim: "AUC = 0.99",
          issue: "No producing run recorded for this number",
          severity: "blocking",
          evidence: "provenance graph has no run linked to the table",
        },
        reviewer: "reviewer",
        sessionID: "ses_review_test",
        messageID: "msg_review_1",
        callID: "call_review_1",
        ...scope(),
      })
      expect(node.meta?.messageID).toBe("msg_review_1")
      expect(node.meta?.callID).toBe("call_review_1")

      const open = await Review.list(scope())
      expect(open.find((entry) => entry.finding.id === node.id)?.status).toBe("open")

      // A fix is recorded — the finding becomes addressed, not closed.
      await Review.resolve({
        finding: node.id,
        actor: "Aayam",
        reason: "Re-ran the analysis and attached the producing run",
        ...scope(),
      })
      const addressed = await Review.list(scope())
      const entry = addressed.find((item) => item.finding.id === node.id)
      expect(entry?.status).toBe("addressed")
      expect(entry?.resolution?.actor).toBe("Aayam")

      // An unrelated later passing check against the same target cannot close
      // this specific defect.
      await Review.record({
        target: target.id,
        finding: {
          claim: "AUC = 0.99",
          issue: "verified",
          severity: "info",
          evidence: "producing run run-123 now linked with matching output hash",
        },
        verdict: "supports",
        reviewer: "reviewer",
        ...scope(),
      })
      const stillAddressed = await Review.list(scope())
      expect(stillAddressed.find((item) => item.finding.id === node.id)?.status).toBe("addressed")

      // Only a LATER reviewer pass explicitly bound to this finding confirms it.
      await Review.record({
        target: target.id,
        confirms: node.id,
        finding: {
          claim: "AUC = 0.99",
          issue: "verified correction",
          severity: "info",
          evidence: "producing run run-123 now linked with matching output hash",
        },
        verdict: "supports",
        reviewer: "reviewer",
        ...scope(),
      })
      const confirmed = await Review.list(scope())
      expect(confirmed.find((item) => item.finding.id === node.id)?.status).toBe("confirmed")
    },
  })
})

test("resolve rejects passed checks and unknown findings", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const target = await Provenance.recordOwned(scope(), {
        kind: "artifact",
        label: "figure",
        artifactType: "figure",
      } as Parameters<typeof Provenance.record>[0])
      const passed = await Review.record({
        target: target.id,
        finding: { claim: "figure matches data", issue: "verified", severity: "info", evidence: "checked bytes" },
        verdict: "supports",
        ...scope(),
      })

      await expect(
        Review.resolve({ finding: passed.node.id, actor: "Aayam", reason: "n/a", ...scope() }),
      ).rejects.toThrow("passed check")
      await expect(Review.resolve({ finding: "missing", actor: "Aayam", reason: "n/a", ...scope() })).rejects.toThrow(
        "not a reviewer finding",
      )
    },
  })
})

test("confirmation requires an addressed refutation against the same target", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const first = await Provenance.recordOwned(scope(), { kind: "artifact", label: "first" })
      const second = await Provenance.recordOwned(scope(), { kind: "artifact", label: "second" })
      const finding = await Review.record({
        target: first.id,
        finding: { claim: "value", issue: "wrong", severity: "major", evidence: "mismatch" },
        ...scope(),
      })
      const confirmation = {
        target: first.id,
        confirms: finding.node.id,
        finding: { claim: "value", issue: "fixed", severity: "info" as const, evidence: "replacement" },
        verdict: "supports" as const,
        reviewer: "reviewer",
        ...scope(),
      }

      await expect(Review.record(confirmation)).rejects.toThrow("has not been addressed")
      await Review.resolve({ finding: finding.node.id, actor: "Aayam", reason: "saved corrected result", ...scope() })
      await expect(Review.record({ ...confirmation, target: second.id })).rejects.toThrow("not a refutation")
      await expect(Review.record({ ...confirmation, verdict: "refutes" })).rejects.toThrow("supporting review")
      await expect(Review.record({ ...confirmation, reviewer: "research" })).rejects.toThrow("independent reviewer")
    },
  })
})

test("lifecycle state requires the append-only review edges, not forgeable metadata", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const target = await Provenance.recordOwned(scope(), { kind: "artifact", label: "result" })
      const finding = await Review.record({
        target: target.id,
        finding: { claim: "value", issue: "wrong", severity: "major", evidence: "mismatch" },
        ...scope(),
      })
      await Provenance.recordOwned(scope(), {
        kind: "claim",
        label: "forged resolution metadata",
        meta: { resolution: true, finding: finding.node.id },
      })
      await expect(
        Review.record({
          target: target.id,
          confirms: finding.node.id,
          finding: { claim: "value", issue: "fixed", severity: "info", evidence: "replacement" },
          verdict: "supports",
          reviewer: "reviewer",
          ...scope(),
        }),
      ).rejects.toThrow("has not been addressed")

      await Review.resolve({ finding: finding.node.id, actor: "Aayam", reason: "saved corrected result", ...scope() })
      await Provenance.recordOwned(scope(), {
        kind: "claim",
        label: "forged confirmation metadata",
        meta: {
          review: true,
          target: target.id,
          verdict: "supports",
          confirms: finding.node.id,
          severity: "info",
        },
      })
      const entries = await Review.list(scope())
      expect(entries.find((entry) => entry.finding.id === finding.node.id)?.status).toBe("addressed")
      expect(entries).toHaveLength(1)
    },
  })
})

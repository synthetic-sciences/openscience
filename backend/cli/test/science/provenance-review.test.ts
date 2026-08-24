import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Review } from "../../src/science/provenance/review"
import { Provenance, type Node } from "../../src/science/provenance/store"
import { WritableMetadata } from "../../src/science/provenance/write"
import { tmpdir } from "../fixture/fixture"

const scope = () => ({ projectID: Instance.project.id, directory: Instance.directory })

async function historicalFinding(input: {
  target: string
  verdict: "refutes" | "supports"
  confirms?: string
  issue?: string
}) {
  const node = await Provenance.recordOwned(scope(), {
    kind: "claim",
    label: `historical review: ${input.issue ?? input.verdict}`,
    meta: {
      review: true,
      target: input.target,
      verdict: input.verdict,
      claim: "AUC = 0.99",
      issue: input.issue ?? input.verdict,
      severity: input.verdict === "refutes" ? "blocking" : "info",
      evidence: "legacy evidence",
      reviewer: "legacy reviewer",
      ...(input.confirms ? { confirms: input.confirms } : {}),
    },
  })
  await Provenance.linkOwned(scope(), { from: node.id, to: input.target, relation: input.verdict })
  if (input.confirms) {
    await Provenance.linkOwned(scope(), { from: node.id, to: input.confirms, relation: "supports" })
  }
  return node
}

async function historicalResolution(finding: Node) {
  const node = await Provenance.recordOwned(scope(), {
    kind: "claim",
    label: "historical resolution",
    meta: { resolution: true, finding: finding.id, actor: "Legacy user", reason: "Saved a corrected result" },
  })
  await Provenance.linkOwned(scope(), { from: node.id, to: finding.id, relation: "supports" })
  return node
}

test("historical findings remain readable across their stored lifecycle", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const target = await Provenance.recordOwned(scope(), {
        kind: "artifact",
        label: "results table",
        artifactType: "dataset",
      } as Parameters<typeof Provenance.record>[0])
      const finding = await historicalFinding({ target: target.id, verdict: "refutes", issue: "missing run" })

      expect((await Review.list(scope())).find((entry) => entry.finding.id === finding.id)?.status).toBe("open")

      await historicalResolution(finding)
      const addressed = (await Review.list(scope())).find((entry) => entry.finding.id === finding.id)
      expect(addressed).toMatchObject({ status: "addressed", resolution: { actor: "Legacy user" } })

      await historicalFinding({ target: target.id, verdict: "supports", issue: "unrelated check" })
      expect((await Review.list(scope())).find((entry) => entry.finding.id === finding.id)?.status).toBe("addressed")

      await historicalFinding({ target: target.id, verdict: "supports", confirms: finding.id, issue: "fixed" })
      expect((await Review.list(scope())).find((entry) => entry.finding.id === finding.id)?.status).toBe("confirmed")
      expect((await Review.forNode(scope(), target.id)).map((entry) => entry.finding.id)).toContain(finding.id)
    },
  })
})

test("generic writable metadata cannot forge historical findings or resolutions", () => {
  expect(WritableMetadata.safeParse({ review: true }).success).toBe(false)
  expect(WritableMetadata.safeParse({ resolution: true }).success).toBe(false)
  expect(WritableMetadata.safeParse({ nested: { review: true }, note: "ordinary metadata" }).success).toBe(true)
})

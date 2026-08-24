/**
 * Read-only compatibility view for provenance reviews created by earlier
 * OpenScience versions. Current generic provenance APIs cannot create these
 * reserved records or their `supports` / `refutes` edges.
 */
import { Provenance, type Node, type Edge, type ProjectScope } from "./store"

export namespace Review {
  /**
   * Historical findings recorded against a node through incoming `supports` /
   * `refutes` edges from reserved claim nodes.
   */
  export async function forNode(
    input: ProjectScope,
    target: string,
  ): Promise<Array<{ finding: Node; relation: Edge["relation"] }>> {
    const { nodes, edges } = await Provenance.query(input, target)
    const byId = new Map(nodes.map((n) => [n.id, n]))
    return edges
      .filter((e) => e.to === target && (e.relation === "refutes" || e.relation === "supports"))
      .map((e) => ({ finding: byId.get(e.from), relation: e.relation }))
      .filter(
        (r): r is { finding: Node; relation: Edge["relation"] } =>
          Boolean(r.finding) && (r.finding!.meta as Record<string, unknown> | undefined)?.review === true,
      )
  }

  /** Historical lifecycle of a refuting finding, derived from the append-only trail:
   *  "open" until someone records a fix, "addressed" once they have, and
   *  "confirmed" only after a LATER reviewer pass records a supports finding
   *  on the same target — a fix is never closed by assertion alone. */
  export type Status = "open" | "addressed" | "confirmed"

  export interface Entry {
    finding: Node
    target: string
    targetNode?: Node
    verdict: "refutes" | "supports"
    status?: Status
    resolution?: { actor: string; reason: string; recordedAt: string }
  }

  /** Every historical finding in the project with its derived lifecycle status. */
  export async function list(input: ProjectScope): Promise<Entry[]> {
    const graph = await Provenance.project(input)
    const meta = (node: Node) => (node.meta ?? {}) as Record<string, unknown>
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
    const findings = graph.nodes.filter((node) => {
      const detail = meta(node)
      const target = typeof detail.target === "string" ? detail.target : ""
      const verdict = detail.verdict === "supports" ? "supports" : "refutes"
      return (
        detail.review === true &&
        !!target &&
        graph.edges.some((edge) => edge.from === node.id && edge.to === target && edge.relation === verdict)
      )
    })
    const resolutions = graph.nodes.filter((node) => meta(node).resolution === true)

    return findings.map((finding) => {
      const detail = meta(finding)
      const target = typeof detail.target === "string" ? detail.target : ""
      const verdict = detail.verdict === "supports" ? ("supports" as const) : ("refutes" as const)
      const targetNode = nodes.get(target)
      if (verdict === "supports") return { finding, target, targetNode, verdict }

      const resolution = resolutions
        .filter(
          (node) =>
            meta(node).finding === finding.id &&
            graph.edges.some((edge) => edge.from === node.id && edge.to === finding.id && edge.relation === "supports"),
        )
        .toSorted((a, b) => b.recordedAt.localeCompare(a.recordedAt))[0]
      if (!resolution) return { finding, target, targetNode, verdict, status: "open" as const }

      const confirmed = findings.some(
        (other) =>
          meta(other).target === target &&
          meta(other).verdict === "supports" &&
          meta(other).confirms === finding.id &&
          graph.edges.some(
            (edge) => edge.from === other.id && edge.to === finding.id && edge.relation === "supports",
          ) &&
          // Legacy writers refused confirmations until a resolution existed,
          // so an equal millisecond timestamp is still causally later.
          other.recordedAt >= resolution.recordedAt,
      )
      const detailed = meta(resolution)
      return {
        finding,
        target,
        targetNode,
        verdict,
        status: confirmed ? ("confirmed" as const) : ("addressed" as const),
        resolution: {
          actor: typeof detailed.actor === "string" ? detailed.actor : "unknown",
          reason: typeof detailed.reason === "string" ? detailed.reason : "",
          recordedAt: resolution.recordedAt,
        },
      }
    })
  }
}

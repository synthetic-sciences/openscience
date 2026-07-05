/**
 * Reviewer findings over the provenance DAG.
 *
 * The reviewer sub-agent (actor-critic critic half) audits research outputs and
 * flags claims that the evidence does not support. A finding is recorded as a
 * content-addressed `claim` node holding {claim, issue, severity, evidence} and
 * linked to the node it concerns with a `refutes` edge (a defect) or a `supports`
 * edge (a check that passed). This is an append-only audit trail — it annotates
 * lineage, it never mutates the reviewed artifact.
 */
import { Provenance, type Node, type Edge } from "./store"

/** Severity of a reviewer finding. Mirrors the reviewer prompt's vocabulary. */
export type Severity = "blocking" | "major" | "minor" | "info"

/** A structured reviewer finding: {claim, issue, severity, evidence}. */
export interface Finding {
  /** The exact claim, number, or figure under review. */
  claim: string
  /** What is wrong with it (or "verified" when the finding supports it). */
  issue: string
  /** How serious the defect is. */
  severity: Severity
  /** Concrete evidence: file:line, value, tool-output id, or provenance node id. */
  evidence: string
}

export interface ReviewResult {
  /** The recorded finding node. */
  node: Node
  /** The relation used to link the finding to the target. */
  relation: "refutes" | "supports"
}

export namespace Review {
  /**
   * Record a reviewer finding against an existing provenance node.
   *
   * Creates a `claim` node carrying the finding payload and links it to `target`
   * with `refutes` (default — a defect was found) or `supports` (a verified-sound
   * check). The finding node is content-addressed, so identical findings dedupe.
   */
  export async function record(input: {
    /** Provenance node id the finding is about (claim / artifact / figure / run). */
    target: string
    finding: Finding
    /** "refutes" flags a problem (default); "supports" records a verified-sound check. */
    verdict?: "refutes" | "supports"
    /** Who recorded it (agent name). */
    reviewer?: string
    sessionID?: string
  }): Promise<ReviewResult> {
    const relation = input.verdict ?? "refutes"
    const node = await Provenance.record({
      kind: "claim",
      label: `review (${input.finding.severity}): ${input.finding.issue}`.slice(0, 140),
      meta: {
        review: true,
        target: input.target,
        claim: input.finding.claim,
        issue: input.finding.issue,
        severity: input.finding.severity,
        evidence: input.finding.evidence,
        verdict: relation,
        reviewer: input.reviewer ?? "reviewer",
        sessionID: input.sessionID,
      },
    })
    await Provenance.link({ from: node.id, to: input.target, relation })
    return { node, relation }
  }

  /**
   * All reviewer findings recorded against a node — the incoming `supports` /
   * `refutes` edges from review claim-nodes. Use to audit what has been flagged.
   */
  export async function forNode(target: string): Promise<Array<{ finding: Node; relation: Edge["relation"] }>> {
    const { nodes, edges } = await Provenance.query(target)
    const byId = new Map(nodes.map((n) => [n.id, n]))
    return edges
      .filter((e) => e.to === target && (e.relation === "refutes" || e.relation === "supports"))
      .map((e) => ({ finding: byId.get(e.from), relation: e.relation }))
      .filter(
        (r): r is { finding: Node; relation: Edge["relation"] } =>
          Boolean(r.finding) && (r.finding!.meta as Record<string, unknown> | undefined)?.review === true,
      )
  }
}

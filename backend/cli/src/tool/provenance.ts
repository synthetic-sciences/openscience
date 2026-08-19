import z from "zod"
import { Tool } from "./tool"
import { Provenance } from "../science/provenance/store"
import { Review } from "../science/provenance/review"
import { Instance } from "../project/instance"
import { Session } from "../session"

/**
 * Agent-facing tools over the provenance DAG. Let the model record what it
 * produced and audit the lineage of any artifact/claim later.
 */

const scope = () => ({
  projectID: Instance.project.id,
  directory: Instance.directory,
})

export const ProvenanceRecordTool = Tool.define("provenance_record", {
  description: [
    "Record a node (and optional edge) in the provenance DAG.",
    "Use to log artifacts you produce (datasets, figures, models, reports) and the runs that made them.",
    "Nodes are content-addressed; recording identical content returns the same id.",
  ].join("\n"),
  parameters: z.object({
    kind: z.enum(["artifact", "run", "source", "claim"]).describe("Node kind"),
    label: z.string().describe("Human-readable label"),
    artifact_type: z
      .string()
      .optional()
      .describe("For artifact nodes: type e.g. 'dataset' | 'figure' | 'model' | 'report'"),
    path: z.string().optional().describe("On-disk path if the node is a materialized file"),
    tool: z.string().optional().describe("For run nodes: the tool/command that executed"),
    meta: z.record(z.string(), z.any()).optional().describe("Arbitrary structured metadata"),
    derived_from: z
      .string()
      .optional()
      .describe("Optional id of a parent node this was derived from (creates a 'derived-from' edge)"),
  }),
  async execute(params, ctx) {
    if (params.derived_from) {
      const graph = await Provenance.project(scope())
      if (!graph.nodes.some((node) => node.id === params.derived_from)) {
        throw new Error(`Provenance node ${params.derived_from} is not part of this project`)
      }
    }
    const node = await Provenance.recordOwned(scope(), {
      kind: params.kind,
      label: params.label,
      ...(params.artifact_type ? { artifactType: params.artifact_type } : {}),
      ...(params.path ? { path: params.path } : {}),
      ...(params.tool ? { tool: params.tool } : {}),
      meta: {
        ...params.meta,
        sessionID: ctx.sessionID,
        directory: Instance.directory,
        projectID: Instance.project.id,
      },
    } as Parameters<typeof Provenance.record>[0])

    if (params.derived_from) {
      await Provenance.linkOwned(scope(), { from: node.id, to: params.derived_from, relation: "derived-from" })
    }

    return {
      title: `Recorded ${params.kind}: ${node.id}`,
      output: [
        `Recorded provenance node.`,
        `  id: ${node.id}`,
        `  kind: ${node.kind}`,
        `  label: ${node.label}`,
        params.derived_from ? `  derived-from: ${params.derived_from}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
      metadata: { id: node.id, kind: node.kind },
    }
  },
})

export const ProvenanceQueryTool = Tool.define("provenance_query", {
  description: [
    "Query the provenance DAG. With `id`, returns that node plus its lineage tree.",
    "Without `id`, lists recorded nodes; reviewer turns are scoped to their current session and direct parent.",
    "Use to audit how an artifact or claim was produced.",
  ].join("\n"),
  parameters: z.object({
    id: z.string().optional().describe("Node id to trace lineage for. Omit to list everything."),
  }),
  async execute(params, ctx) {
    const graph = await Provenance.project(scope())
    const reviewer = ctx.agent === "reviewer" || ctx.agent === "artifact-reviewer" || ctx.agent === "review"
    const session = reviewer ? await Session.get(ctx.sessionID).catch(() => undefined) : undefined
    const visible = new Set([ctx.sessionID, session?.parentID].filter((id): id is string => !!id))
    const nodes = reviewer
      ? graph.nodes.filter((node) => {
          const owner = (node.meta as Record<string, unknown> | undefined)?.sessionID
          return typeof owner === "string" && visible.has(owner)
        })
      : graph.nodes
    const ids = new Set(nodes.map((node) => node.id))
    const edges = reviewer ? graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)) : graph.edges
    if (!params.id) {
      if (!nodes.length) {
        return { title: "Provenance", output: "No provenance nodes recorded yet.", metadata: { count: 0, edges: 0 } }
      }
      const rows = nodes.map((n) => `- **${n.id}** [${n.kind}] ${n.label}`)
      return {
        title: `Provenance (${nodes.length} nodes)`,
        output: rows.join("\n"),
        metadata: { count: nodes.length, edges: 0 },
      }
    }

    if (!nodes.some((node) => node.id === params.id)) {
      return { title: "Provenance", output: `No node "${params.id}".`, metadata: { count: 0, edges: 0 } }
    }
    const connected = new Set([params.id])
    const queue = [params.id]
    while (queue.length) {
      const current = queue.shift()!
      for (const edge of edges) {
        if (edge.from !== current && edge.to !== current) continue
        const next = edge.from === current ? edge.to : edge.from
        if (connected.has(next)) continue
        connected.add(next)
        queue.push(next)
      }
    }
    const lineage = nodes.filter((node) => connected.has(node.id))
    const links = edges.filter((edge) => connected.has(edge.from) && connected.has(edge.to))
    const nodeRows = lineage.map((n) => `- **${n.id}** [${n.kind}] ${n.label}`)
    const edgeRows = links.map((e) => `- ${e.from} --${e.relation}--> ${e.to}`)
    return {
      title: `Lineage: ${params.id}`,
      output: [
        `**Nodes** (${lineage.length}):`,
        nodeRows.join("\n"),
        "",
        `**Edges** (${links.length}):`,
        edgeRows.join("\n"),
      ].join("\n"),
      metadata: { count: lineage.length, edges: links.length },
    }
  },
})

export const ProvenanceReviewTool = Tool.define("provenance_review", {
  description: [
    "Record a reviewer finding against a provenance node.",
    "Use to flag a claim, statistic, or figure that the evidence does not support (verdict 'refutes'),",
    "or to log a check that passed sound (verdict 'supports').",
    "Creates a content-addressed 'claim' node holding {claim, issue, severity, evidence} and links it",
    "to the target node with a 'refutes'/'supports' edge. Append-only audit trail — the artifact is not modified.",
  ].join("\n"),
  parameters: z.object({
    target: z
      .string()
      .describe("Provenance node id the finding is about (the claim / artifact / figure / run under review)"),
    claim: z.string().describe("The exact claim, number, or figure being evaluated (quote it)"),
    issue: z.string().describe("What is wrong with it — or 'verified' when the finding supports it"),
    severity: z
      .enum(["blocking", "major", "minor", "info"])
      .describe("Severity: blocking (invalidates a headline claim) | major | minor | info"),
    evidence: z
      .string()
      .describe("Concrete evidence: file:line, value, tool-output id, or provenance node id proving the finding"),
    verdict: z
      .enum(["refutes", "supports"])
      .default("refutes")
      .describe("'refutes' flags a defect (default); 'supports' records a verified-sound check"),
    finding: z
      .string()
      .optional()
      .describe("Exact addressed finding id this later supports verdict confirms; omit for an unrelated passed check"),
  }),
  async execute(params, ctx) {
    const graph = await Provenance.project(scope())
    if (!graph.nodes.some((node) => node.id === params.target)) {
      throw new Error(`Provenance node ${params.target} is not part of this project`)
    }
    const { node, relation } = await Review.record({
      target: params.target,
      finding: {
        claim: params.claim,
        issue: params.issue,
        severity: params.severity,
        evidence: params.evidence,
      },
      verdict: params.verdict,
      confirms: params.finding,
      reviewer: ctx.agent,
      sessionID: ctx.sessionID,
      messageID: ctx.messageID,
      callID: ctx.callID,
      projectID: Instance.project.id,
      directory: Instance.directory,
    })
    return {
      title: `Review ${relation}: ${node.id}`,
      output: [
        `Recorded reviewer finding.`,
        `  finding id: ${node.id}`,
        `  target:     ${params.target}`,
        `  relation:   ${node.id} --${relation}--> ${params.target}`,
        `  severity:   ${params.severity}`,
        `  claim:      ${params.claim}`,
        `  issue:      ${params.issue}`,
        `  evidence:   ${params.evidence}`,
      ].join("\n"),
      metadata: {
        id: node.id,
        target: params.target,
        relation,
        severity: params.severity,
        ...(params.finding ? { confirms: params.finding } : {}),
      },
    }
  },
})

export const ProvenanceResolveTool = Tool.define("provenance_resolve", {
  description: [
    "Mark a refuting reviewer finding as addressed after its underlying defect was actually corrected.",
    "This does not close the finding: a later independent reviewer must record supporting evidence",
    "against the original target before the lifecycle becomes confirmed.",
  ].join("\n"),
  parameters: z.object({
    finding: z.string().describe("Reviewer finding node id returned by provenance_review"),
    reason: z.string().min(12).describe("Concrete correction and its replacement run/artifact evidence"),
  }),
  async execute(params, ctx) {
    if (ctx.agent === "reviewer" || ctx.agent === "artifact-reviewer" || ctx.agent === "review") {
      throw new Error("Reviewers cannot mark their own findings as addressed")
    }
    const node = await Review.resolve({
      finding: params.finding,
      actor: ctx.agent,
      reason: params.reason,
      projectID: Instance.project.id,
      directory: Instance.directory,
      sessionID: ctx.sessionID,
    })
    return {
      title: `Finding addressed: ${params.finding}`,
      output: [
        "Recorded an addressed reviewer finding.",
        `  finding:    ${params.finding}`,
        `  resolution: ${node.id}`,
        `  actor:      ${ctx.agent}`,
        `  reason:     ${params.reason}`,
        "A later independent reviewer must confirm the correction against the original target.",
      ].join("\n"),
      metadata: { finding: params.finding, resolution: node.id, status: "addressed" },
    }
  },
})

export const ProvenanceTools = [ProvenanceRecordTool, ProvenanceQueryTool, ProvenanceReviewTool, ProvenanceResolveTool]

export const PROVENANCE_TOOL_IDS = new Set([
  "provenance_record",
  "provenance_query",
  "provenance_review",
  "provenance_resolve",
])

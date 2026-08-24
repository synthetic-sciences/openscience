import z from "zod"
import { Tool } from "./tool"
import { Provenance } from "../science/provenance/store"
import { WritableMetadata } from "../science/provenance/write"
import { Instance } from "../project/instance"

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
    meta: WritableMetadata.optional().describe("Arbitrary structured metadata"),
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
    "Without `id`, lists recorded nodes in this project.",
    "Use to audit how an artifact or claim was produced.",
  ].join("\n"),
  parameters: z.object({
    id: z.string().optional().describe("Node id to trace lineage for. Omit to list everything."),
  }),
  async execute(params) {
    const graph = await Provenance.project(scope())
    const { nodes, edges } = graph
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

export const ProvenanceTools = [ProvenanceRecordTool, ProvenanceQueryTool]

export const PROVENANCE_TOOL_IDS = new Set(["provenance_record", "provenance_query"])

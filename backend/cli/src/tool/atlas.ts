import z from "zod"
import { AtlasBroker } from "@/science/atlas/broker"
import { OpenScience } from "@/openscience"
import { Tool } from "./tool"

const Operation = z.enum(["brief", "node", "tree", "search", "ask", "usage"])

export const AtlasTool = Tool.define("atlas", {
  description: [
    "Read Gateway through the OpenScience host broker.",
    "Use this instead of shelling out to the bundled graph CLI when execution is sandboxed or network egress is denied.",
    "The host keeps Gateway credentials private and returns only the requested JSON.",
    "This first broker surface is read-only and accepts source identifiers, never host folder paths.",
  ].join("\n"),
  parameters: z.object({
    operation: Operation,
    project: z.string().trim().min(1).optional().describe("Project node id or slug for brief."),
    node: z.string().trim().min(1).optional().describe("Node id or slug for node or tree."),
    query: z.string().trim().min(1).max(20_000).optional().describe("Question for search or ask."),
    full: z.boolean().optional().describe("Load the expanded project brief."),
    mode: z.enum(["universal", "targeted", "web", "deep"]).optional().describe("Gateway library search mode."),
    top_k: z.number().int().min(1).max(50).optional().describe("Maximum search or answer result count."),
    source_ids: z.array(z.string().trim().min(1)).max(100).optional().describe("Indexed Gateway source ids."),
    projection: z.string().trim().min(1).optional().describe("Node or tree projection."),
    max_nodes: z.number().int().min(1).max(10_000).optional().describe("Maximum tree node count."),
    max_depth: z.number().int().min(0).max(100).optional().describe("Maximum tree depth."),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "atlas",
      patterns: [params.operation],
      always: [`${params.operation}*`],
      metadata: { broker: "host", mutation: false },
    })
    const result = await AtlasBroker.run(
      {
        operation: params.operation,
        project: params.project,
        node: params.node,
        query: params.query,
        full: params.full,
        mode: params.mode,
        topK: params.top_k,
        sourceIDs: params.source_ids,
        projection: params.projection,
        maxNodes: params.max_nodes,
        maxDepth: params.max_depth,
      },
      ctx.abort,
    )
    const output = OpenScience.redactSecrets(JSON.stringify(result, null, 2))
    ctx.metadata({
      title: `Gateway ${params.operation}`,
      metadata: { operation: params.operation, broker: "host", credentials: "host_only" },
    })
    return {
      title: `Gateway ${params.operation}`,
      output,
      metadata: { operation: params.operation, broker: "host", credentials: "host_only" },
    }
  },
})

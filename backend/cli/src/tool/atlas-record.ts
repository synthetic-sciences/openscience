import z from "zod"
import { OpenScience } from "@/openscience"
import { AtlasRecorder } from "@/science/atlas/record"
import { Tool } from "./tool"

const Data = z.record(z.string(), z.unknown())

export const AtlasRecordTool = Tool.define("atlas_record", {
  description: [
    "Publish one existing local kernel provenance record to Synthetic Sciences through the OpenScience host broker.",
    "Pass the provenance_id returned by the notebook or R kernel; the host verifies that it belongs to this project.",
    "The host derives code, output, outcome, and Git state. No local folder path, account credential, or arbitrary payload is accepted.",
  ].join("\n"),
  parameters: z.object({
    project: z.string().trim().min(1).describe("Synthetic Sciences project node id or slug."),
    provenance_id: z.string().trim().min(1).describe("Local provenance id returned by a kernel execution."),
    title: z.string().trim().min(1).max(240).optional().describe("Optional run title override."),
    config: Data.optional().describe("Additional non-secret run configuration."),
    metrics: Data.optional().describe("Structured run metrics."),
    outcome: z.enum(["success", "failure", "inconclusive"]).optional().describe("Optional outcome override."),
    failure_mode: z
      .enum(["diverged", "oom", "data_bug", "code_bug", "underperformed", "other"])
      .optional()
      .describe("Failure classification."),
    cluster: z.string().trim().min(1).max(240).optional().describe("Stable run cluster key."),
    plan: z.string().trim().min(1).optional().describe("Experiment-plan node id or slug."),
    hypothesis: z.string().trim().min(1).optional().describe("Hypothesis node id or slug."),
  }),
  async execute(params, ctx) {
    await ctx.ask({
      permission: "atlas_write",
      patterns: [`run:${params.project}`],
      always: [`run:${params.project}`],
      metadata: {
        broker: "host",
        mutation: true,
        project: params.project,
        provenanceID: params.provenance_id,
      },
    })
    const result = await AtlasRecorder.publish({
      project: params.project,
      provenanceID: params.provenance_id,
      title: params.title,
      config: params.config,
      metrics: params.metrics,
      outcome: params.outcome,
      failureMode: params.failure_mode,
      cluster: params.cluster,
      plan: params.plan,
      hypothesis: params.hypothesis,
      signal: ctx.abort,
    })
    const output = OpenScience.redactSecrets(JSON.stringify(result, null, 2))
    ctx.metadata({
      title: "Synthetic Sciences run recorded",
      metadata: {
        operation: "run",
        broker: "host",
        mutation: true,
        credentials: "host_only",
        provenanceID: params.provenance_id,
      },
    })
    return {
      title: "Synthetic Sciences run recorded",
      output,
      metadata: {
        operation: "run",
        broker: "host",
        mutation: true,
        credentials: "host_only",
        provenanceID: params.provenance_id,
      },
    }
  },
})

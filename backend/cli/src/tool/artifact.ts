import z from "zod"
import { Tool } from "./tool"
import { RLMArtifacts } from "@/session/rlm/artifacts"

function result(title: string, output: string, metadata: Record<string, unknown> = {}) {
  return { title, output, metadata }
}

export const ArtifactTool = Tool.define("artifact", {
  description: [
    "Store and retrieve large data artifacts by reference.",
    "Use this to keep large outputs (DataFrames, analysis results, raw data) out of context.",
    "Actions:",
    "  - register: Store content on disk, returns a reference ID + summary",
    "  - resolve: Retrieve full content by artifact ID",
    "  - list: Show all artifacts in this session",
  ].join(" "),
  parameters: z.object({
    action: z.enum(["register", "resolve", "list"]).describe("The action to perform"),
    type: z.string().optional().describe('For register: artifact type (e.g. "dataframe", "analysis", "raw_output")'),
    content: z.string().optional().describe("For register: the large content to store"),
    summary: z.string().optional().describe("For register: brief summary for context window"),
    artifact_id: z.string().optional().describe("For resolve: the artifact ID to retrieve"),
  }),
  async execute(params, ctx) {
    if (params.action === "register") {
      if (!params.type || !params.content) {
        return result("Error", "register requires `type` and `content` parameters")
      }
      const ref = await RLMArtifacts.register(ctx.sessionID, params.type, params.content, params.summary)
      return result(
        `Registered artifact: ${ref.id}`,
        [
          `Artifact stored successfully.`,
          `  ID: ${ref.id}`,
          `  Type: ${ref.type}`,
          `  Summary: ${ref.summary}`,
          `  Size: ${params.content.length} bytes`,
          "",
          "Use artifact_id in resolve to retrieve full content later.",
        ].join("\n"),
        { id: ref.id, type: ref.type },
      )
    }

    if (params.action === "resolve") {
      if (!params.artifact_id) {
        return result("Error", "resolve requires `artifact_id` parameter")
      }
      const content = await RLMArtifacts.resolve(ctx.sessionID, params.artifact_id)
      if (!content) {
        return result("Not found", `Artifact "${params.artifact_id}" not found in this session.`)
      }
      return result(`Resolved artifact: ${params.artifact_id}`, content, { id: params.artifact_id })
    }

    // list
    const artifacts = await RLMArtifacts.list(ctx.sessionID)
    if (artifacts.length === 0) {
      return result("No artifacts", "No artifacts registered in this session.")
    }
    const lines = artifacts.map((a) => `- ${a.id}: ${a.summary} (${a.type})`)
    return result(`${artifacts.length} artifact(s)`, lines.join("\n"), { count: artifacts.length })
  },
})

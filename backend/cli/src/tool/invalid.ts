import z from "zod"
import { Tool } from "./tool"

export const InvalidTool = Tool.define("invalid", {
  description: "Do not use",
  parameters: z.object({
    tool: z.string(),
    error: z.string(),
  }),
  async execute(params) {
    return {
      title: `Recovered incomplete ${params.tool} call`,
      output: `${params.error} Retry the intended call once with complete input, or choose a different approach.`,
      metadata: {
        recovered: true,
        sourceTool: params.tool,
      },
    }
  },
})

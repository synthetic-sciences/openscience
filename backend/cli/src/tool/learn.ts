import z from "zod"
import { Tool } from "./tool"
import { HarnessContract } from "@/session/harness/contract"
import { HarnessSkill } from "@/session/harness/skill"

export const LearnTool = Tool.define("learn", {
  description:
    "Quarantine a learned skill proposal distilled from conversation analysis. The proposal stays inactive until paired held-out benchmark and trigger evaluations qualify it.",
  parameters: z.object({
    name: z.string().describe("Skill identifier (kebab-case, e.g. 'debug-oom-pytorch')"),
    description: z.string().describe("One-line description of what this skill teaches"),
    content: z.string().describe("Full SKILL.md content including frontmatter"),
  }),
  async execute(params, ctx) {
    const contract = await HarnessContract.read(ctx.sessionID)
    const proposal = await HarnessSkill.propose({
      name: params.name,
      description: params.description,
      content: params.content,
      origin: "conversation",
      sessionID: ctx.sessionID,
      runID: contract?.runID,
      createdAt: Date.now(),
    })

    return {
      title: `Skill proposal: ${params.name}`,
      output: [
        `Learned skill proposal "${params.name}" is quarantined and inactive.`,
        `  SHA-256: ${proposal?.contentSHA256}`,
        `  Required: 3 distinct held-out tasks, 2 strict paired improvements, no regressions,`,
        `  and held-out trigger precision/recall of at least 0.8.`,
        "",
        "Only the evaluator-authenticated harness can qualify it for explicit promotion.",
      ].join("\n"),
      metadata: { name: params.name, status: proposal?.status, sha256: proposal?.contentSHA256 },
    }
  },
})

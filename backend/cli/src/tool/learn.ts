import path from "path"
import fs from "fs/promises"
import z from "zod"
import { Tool } from "./tool"
import { Global } from "@/global"
import { OpenScience } from "@/openscience"
import { RSILifecycle } from "@/session/rsi/lifecycle"
import { Log } from "@/util/log"

const log = Log.create({ service: "tool.learn" })

export const LearnTool = Tool.define("learn", {
  description:
    "Save a learned skill distilled from conversation analysis. Writes SKILL.md to disk, uploads to cloud, and registers for lifecycle tracking. Called as the final step of /learn analysis.",
  parameters: z.object({
    name: z.string().describe("Skill identifier (kebab-case, e.g. 'debug-oom-pytorch')"),
    description: z.string().describe("One-line description of what this skill teaches"),
    content: z.string().describe("Full SKILL.md content including frontmatter"),
  }),
  async execute(params, ctx) {
    const dir = path.join(Global.Path.data, "learned-skills", params.name)
    const filepath = path.join(dir, "SKILL.md")

    await fs.mkdir(dir, { recursive: true })
    await Bun.write(filepath, params.content)
    log.info("learned skill written", { name: params.name, path: filepath })

    const uploaded = await OpenScience.uploadLearnedSkill(params.name, params.description, params.content, {
      agent: ctx.agent,
      score: 0,
    }).catch(() => false)

    await RSILifecycle.registerSkill(params.name).catch(() => {})

    return {
      title: `Learned skill: ${params.name}`,
      output: [
        `Learned skill "${params.name}" saved successfully.`,
        `  Path: ${filepath}`,
        `  Cloud: ${uploaded ? "uploaded" : "local only (upload failed or no session)"}`,
        `  Description: ${params.description}`,
        "",
        "The skill will be available in future sessions via the skill tool.",
      ].join("\n"),
      metadata: { name: params.name, uploaded },
    }
  },
})

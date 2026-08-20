import { Ripgrep } from "../file/ripgrep"

import { Instance } from "../project/instance"
import { SessionFilesystem } from "./filesystem"

import PROMPT_CORE from "./prompt/core.txt"
import type { Provider } from "@/provider/provider"
import { Config } from "../config/config"
import { Skill } from "../skill"
import { PermissionNext } from "../permission/next"
import { ComputePrompt } from "../compute/prompt"

export namespace SystemPrompt {
  export function instructions() {
    return PROMPT_CORE.trim()
  }

  export function provider(_model: Provider.Model) {
    return [PROMPT_CORE]
  }

  export async function compute(value?: unknown) {
    return [await ComputePrompt.system(value)]
  }

  /** When the user message begins with `/<name>` matching an installed
   *  skill, the model should invoke the skill tool immediately and
   *  silently — zero text output before the tool call. */
  export function slashSkillDirective(): string[] {
    return [
      `<slash-skill-invocation>
If a user message begins with /<name> and <name> is an available skill, the first output must be
skill({name:"<name>"}) with no preceding text or acknowledgement. After it returns, answer the request;
when the message was only /<name>, ask what the user wants then. Treat unknown names as literal text.
</slash-skill-invocation>`,
    ]
  }

  export async function availableSkills(permission: PermissionNext.Ruleset) {
    const skills = (await Skill.all()).filter(
      (skill) => PermissionNext.evaluate("skill", skill.name, permission).action !== "deny",
    )
    if (skills.length === 0) {
      return [
        "<available-skills>",
        "No skills are currently available. Static skill routing tables are guidance only.",
        "Do not call the skill tool because no skill name will resolve.",
        "</available-skills>",
      ].join("\n")
    }

    const groups = new Map<string, string[]>()
    for (const skill of skills) {
      const category = skill.category ?? "other"
      groups.set(category, [...(groups.get(category) ?? []), skill.name])
    }

    const list = [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([category, names]) => [
        `### ${category}`,
        ...names.sort((a, b) => a.localeCompare(b)).map((name) => `- ${name}`),
      ])

    return [
      "<available-skills>",
      "Only the skill names below are currently loaded and callable.",
      "Static skill routing tables are guidance only. Never call a skill absent from this list.",
      ...list,
      "</available-skills>",
    ].join("\n")
  }

  export async function planModeInstructions(): Promise<string[]> {
    const config = await Config.get()
    if (config.experimental?.plan_mode !== true) return []
    return [
      `<plan-mode>
Plan Mode is enabled. You have a PlanWrite tool instead of TodoWrite.
Use PlanWrite to structure your work as a visible plan in the user's sidebar.
The plan panel shows items in real-time. Treat each item as a step, not a task.
Update status as you work: pending -> in_progress -> completed.
Keep only one item in_progress at a time.
</plan-mode>`,
    ]
  }

  export async function environment(model: Provider.Model, sessionID: string) {
    const project = Instance.project
    const workspace = await SessionFilesystem.workspace(sessionID)
    return [
      [
        `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        `  Working directory: ${workspace}`,
        `  Project directory: ${Instance.directory}`,
        `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
        `  Platform: ${process.platform}`,
        `  Today's date: ${new Date().toDateString()}`,
        `</env>`,
        `<files>`,
        `  ${
          project.vcs === "git" && false
            ? await Ripgrep.tree({
                cwd: workspace,
                limit: 200,
              })
            : ""
        }`,
        `</files>`,
      ].join("\n"),
    ]
  }
}

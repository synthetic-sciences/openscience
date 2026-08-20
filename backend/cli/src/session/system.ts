import { Ripgrep } from "../file/ripgrep"

import { Instance } from "../project/instance"
import { SessionFilesystem } from "./filesystem"

import PROMPT_CORE from "./prompt/core.txt"
import PROMPT_DIRECT from "./prompt/direct.txt"
import PROMPT_INSPECTION from "./prompt/inspection.txt"
import type { Provider } from "@/provider/provider"
import { Config } from "../config/config"
import { Skill } from "../skill"
import { PermissionNext } from "../permission/next"
import { ComputePrompt } from "../compute/prompt"

export namespace SystemPrompt {
  const skillPrompts = new WeakMap<Skill.Info[], Map<string, string>>()

  export function instructions(direct = false, inspection = false) {
    if (direct) return `You are OpenScience.\n\n${PROMPT_DIRECT.trim()}`
    if (inspection) return `You are OpenScience.\n\n${PROMPT_INSPECTION.trim()}`
    return PROMPT_CORE.trim()
  }

  export function provider(_model: Provider.Model, direct = false, inspection = false) {
    return [direct || inspection ? instructions(direct, inspection) : PROMPT_CORE]
  }

  export async function compute(value?: unknown) {
    return [await ComputePrompt.system(value)]
  }

  export async function availableSkills(permission: PermissionNext.Ruleset, message?: string) {
    const catalog = await Skill.all()
    const key = (message?.length ?? 0) <= 8_192 ? JSON.stringify([permission, message ?? ""]) : undefined
    const cache = (() => {
      const current = skillPrompts.get(catalog)
      if (current) return current
      const value = new Map<string, string>()
      skillPrompts.set(catalog, value)
      return value
    })()
    if (key) {
      const cached = cache.get(key)
      if (cached) return cached
    }
    const publish = (value: string) => {
      if (!key) return value
      cache.set(key, value)
      if (cache.size > 32) cache.delete(cache.keys().next().value!)
      return value
    }
    const skills = catalog.filter((skill) => PermissionNext.evaluate("skill", skill.name, permission).action !== "deny")
    if (skills.length === 0) {
      return publish(
        [
          "<available-skills>",
          "No skills are currently available. Static skill routing tables are guidance only.",
          "Do not call the skill tool because no skill name will resolve.",
          "</available-skills>",
        ].join("\n"),
      )
    }

    const groups = new Map<string, number>()
    for (const skill of skills) {
      const category = skill.category ?? "other"
      groups.set(category, (groups.get(category) ?? 0) + 1)
    }

    const list = [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([category, count]) => `${category} (${count})`)
      .join(", ")
    const total = skills.length === 1 ? "1 skill is" : `${skills.length} skills are`
    const name = message
      ?.trimStart()
      .match(/^\/([a-z0-9][a-z0-9_-]*)(?:\s|$)/i)?.[1]
      ?.toLowerCase()
    const stop = new Set([
      "and",
      "answer",
      "available",
      "concise",
      "final",
      "for",
      "from",
      "most",
      "outline",
      "relevant",
      "skill",
      "sound",
      "the",
      "this",
      "use",
      "with",
      "workflow",
    ])
    const words = (value: string) =>
      new Set((value.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => word.length > 2 && !stop.has(word)))
    const query = words(message ?? "")
    const matches = skills
      .map((skill) => {
        const keys = words(`${skill.name} ${skill.category ?? "other"}`)
        const body = words(skill.description)
        const score = [...query].reduce((sum, word) => sum + (keys.has(word) ? 4 : body.has(word) ? 1 : 0), 0)
        return { skill, score }
      })
      .filter((item) => item.score > 1)
      .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
      .slice(0, 8)
    const likely = matches.length
      ? [
          "Likely matches for this request:",
          ...matches.map(
            (item) =>
              `- ${item.skill.name}: ${item.skill.description.slice(0, 120)}${item.skill.description.length > 120 ? "..." : ""}`,
          ),
        ]
      : []
    const invoke =
      name && skills.some((skill) => skill.name === name)
        ? [
            "<slash-skill-invocation>",
            `The user invoked /${name}. First output skill({name:"${name}"}) with no preceding text. After it returns, answer the request; when the message was only /${name}, ask what they want then.`,
            "</slash-skill-invocation>",
          ]
        : []

    return publish(
      [
        "<available-skills>",
        `${total} callable across: ${list}.`,
        ...likely,
        "Load a likely match directly, or browse a relevant category when the shortlist is insufficient. Do not guess other names from static routing tables.",
        "</available-skills>",
        ...invoke,
      ].join("\n"),
    )
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

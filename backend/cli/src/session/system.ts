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
import { ProjectAccess } from "../project/access"

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
    const names = new Map(skills.map((skill) => [skill.name.toLowerCase(), skill.name]))
    const invoked = [...(message ?? "").matchAll(/(?:^|[\s([{'\"])\/([a-z0-9][a-z0-9_-]*)(?=$|[^a-z0-9_/-])/gi)]
      .map((match) => match[1].toLowerCase())
      .map((name) => names.get(name))
      .filter((name): name is string => !!name)
      .filter((name, index, all) => all.indexOf(name) === index)
    const route = [
      {
        when: "Venue-specific paper formatting, submission checks, or page limits",
        skills: ["venue-templates", "ml-paper-writing"],
      },
      {
        when: "General manuscript drafting or revision",
        skills: ["scientific-writing"],
      },
      {
        when: "Citation verification or bibliography repair",
        skills: ["citation-management", "research-lookup"],
      },
      {
        when: "Technical figures, architectures, workflows, or scientific diagrams",
        skills: ["scientific-schematics"],
      },
      {
        when: "Illustrations, artwork, photos, or other non-technical images",
        skills: ["generate-image"],
      },
    ]
      .map((item) => ({
        ...item,
        skills: item.skills.map((skill) => names.get(skill)).filter((skill): skill is string => !!skill),
      }))
      .filter((item) => item.skills.length > 0)
    const routing = route.length
      ? [
          "<skill-routing>",
          "When a request clearly matches one of these routes, load the listed skill or skills before the first substantive edit, build, search, or generation step. Do not merely mention the skill in prose.",
          ...route.map((item) => `- ${item.when}: ${item.skills.join(", ")}`),
          "For an existing manuscript, preserve its scientific content and existing figures unless the user asks for content or figure changes. When creating or replacing a technical figure, use scientific-schematics and the native generate_image tool so Nano Banana Pro runs through connected BYOK or a funded OpenScience wallet without exposing credentials to shell scripts.",
          "</skill-routing>",
        ]
      : []
    const invoke = invoked.length
      ? [
          "<slash-skill-invocation>",
          `The user explicitly invoked ${invoked.map((name) => `/${name}`).join(", ")}. Before substantive work, load ${invoked.map((name) => `skill({name:"${name}"})`).join(" and ")} with no preceding text. Then answer the surrounding request.`,
          "</slash-skill-invocation>",
        ]
      : []

    return publish(
      [
        "<available-skills>",
        `${total} callable across: ${list}.`,
        ...routing,
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

  export async function environment(model: { api: { id: string }; providerID: string }, sessionID: string) {
    const project = Instance.project
    const context = await Promise.all([
      SessionFilesystem.workspace(sessionID),
      SessionFilesystem.state(sessionID),
      ProjectAccess.status(project),
    ])
    const workspace = context[0]
    const filesystem = context[1]
    const projectAccess = context[2]
    const sources = filesystem.grants.filter(
      (grant) =>
        !grant.time.consumed && !grant.time.revoked && (grant.source === "api" || grant.source === "permission"),
    )
    const access =
      projectAccess.mode === "ask"
        ? "Ask for approval. Project actions require explicit approval."
        : projectAccess.mode === "approve"
          ? "Approve for me. Routine work in the project is automatically approved inside the sandbox; boundary actions still require approval."
          : "Full access. Project actions may run with unrestricted host file and network access without approval prompts."
    const projectName = project.name?.trim() || "Untitled project"
    return [
      [
        `You are powered by the model named ${model.api.id}. The exact model ID is ${model.providerID}/${model.api.id}`,
        `Here is some useful information about the environment you are running in:`,
        `<env>`,
        `  Project: ${projectName}`,
        `  Project ID: ${project.id}`,
        `  Session ID: ${sessionID}`,
        `  Project files: ${Instance.directory} (durable and shared across this project)`,
        `  Session scratch: ${workspace} (temporary and isolated to this conversation)`,
        `  Results: immutable project-wide deliverables saved with the artifact tool`,
        `  Access mode: ${access}`,
        `  Connected project folders:`,
        ...(sources.length
          ? sources.map(
              (grant) =>
                `    - ${grant.path} (${grant.access === "write" ? "read and write" : "read only"}, ${grant.scope} scope)`,
            )
          : [`    - none`]),
        `  Is directory a git repo: ${project.vcs === "git" ? "yes" : "no"}`,
        `  Platform: ${process.platform}`,
        `  Today's date: ${new Date().toDateString()}`,
        `</env>`,
        `An OpenScience project is a durable research context that may aggregate multiple connected folders and files. Session scratch belongs only to this conversation. Results are immutable deliverables shared project-wide; a normal workspace file is not a Result until artifact save_file returns its Result ID and version.`,
        `Work directly in Project files when the user refers to durable project material. Use Session scratch only for temporary work. Promote a scratch or project file to Results explicitly with artifact save_file before citing it as a durable Result or passing it to a Result-only contract.`,
        `The physical paths above are routing information. Use the human project name in conversation, not UUID directory components. Do not expose scratch, managed-project, or connected-folder paths in a generic greeting. Mention a path only when the user asks about location or when it is needed to complete their request.`,
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

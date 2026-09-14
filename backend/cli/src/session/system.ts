import { Ripgrep } from "../file/ripgrep"

import { Instance } from "../project/instance"
import { SessionFilesystem } from "./filesystem"

import PROMPT_RESPONSE from "./prompt/response.txt"
import PROMPT_SCIENCE from "../agent/prompt/science.txt"
import PROMPT_ANTHROPIC from "../agent/prompt/anthropic.txt"
import PROMPT_ASTRA from "../agent/prompt/gpt-astra.txt"
import PROMPT_GPT from "../agent/prompt/gpt.txt"
import PROMPT_CODEX from "../agent/prompt/codex.txt"
import PROMPT_GEMINI from "../agent/prompt/gemini.txt"
import PROMPT_DEFAULT from "../agent/prompt/default.txt"
import type { Agent } from "@/agent/agent"
import { SkillCatalog } from "../skill/catalog"
import { Skill } from "../skill"
import { searchSkills } from "../skill/search"
import { PermissionNext } from "../permission/next"
import { ProjectAccess } from "../project/access"

export namespace SystemPrompt {
  const skillPrompts = new WeakMap<Skill.Info[], Map<string, string>>()

  export type Family = "anthropic" | "gpt-astra" | "gpt" | "codex" | "gemini" | "default"

  const FAMILY: Record<Family, string> = {
    anthropic: PROMPT_ANTHROPIC,
    "gpt-astra": PROMPT_ASTRA,
    gpt: PROMPT_GPT,
    codex: PROMPT_CODEX,
    gemini: PROMPT_GEMINI,
    default: PROMPT_DEFAULT,
  }

  /** The slot every family file and the specialist template carry; the shared
   * science block is substituted at render time so it is identical everywhere. */
  export const SCIENCE_SLOT = "{{SCIENCE}}"
  export const DOMAIN_SKILLS_SLOT = "{{DOMAIN_SKILLS}}"

  export function science() {
    return PROMPT_SCIENCE.trim()
  }

  /** Header family by wire model id, in OpenCode's order. */
  export function family(id: string): Family {
    const lower = id.toLowerCase()
    if (lower.includes("gpt-4") || lower.includes("o1") || lower.includes("o3")) return "gpt"
    if (lower.includes("gpt")) {
      if (lower.includes("gpt-6") || lower.includes("astra")) return "gpt-astra"
      if (lower.includes("codex")) return "codex"
      return "gpt"
    }
    if (lower.includes("gemini-")) return "gemini"
    if (lower.includes("claude")) return "anthropic"
    return "default"
  }

  export function response(prompt: string) {
    return `${prompt.trim()}\n\n${PROMPT_RESPONSE.trim()}`
  }

  /** The model-family header with the science block filled and the writing
   * defaults appended: what an agent without a prompt of its own receives. */
  export function header(model: { api: { id: string } }) {
    return response(FAMILY[family(model.api.id)].replace(SCIENCE_SLOT, science()))
  }

  export function provider(model: { api: { id: string } }) {
    return [header(model)]
  }

  /** Fill an agent prompt's slots: the science block, and the agent's domain
   * skill index when it declares skill categories. */
  export async function render(agent: Agent.Info): Promise<Agent.Info> {
    if (!agent.prompt) return agent
    const withScience = agent.prompt.replace(SCIENCE_SLOT, science())
    if (!withScience.includes(DOMAIN_SKILLS_SLOT)) return { ...agent, prompt: withScience }
    const index = (await domainSkills(agent.skills ?? [], agent.permission)) ?? ""
    return { ...agent, prompt: withScience.replace(DOMAIN_SKILLS_SLOT, index).trim() }
  }

  /** A slash token is an explicit request for a command or skill. */
  export function slashInvocation(message?: string) {
    return /(?:^|[\s([{'"])\/([a-z0-9][a-z0-9_-]*)(?=$|[^a-z0-9_/-])/i.test(message ?? "")
  }

  function sentence(text: string) {
    const first = text.split(/(?<=[.!?])\s+/)[0] ?? text
    return first.length > 140 ? `${first.slice(0, 137)}...` : first
  }

  /** The `<domain-skills>` index of a specialist: every skill in its
   * categories, one line each, grouped by category. */
  export async function domainSkills(categories: string[], permission: PermissionNext.Ruleset) {
    if (!categories.length) return
    const catalog = (await Skill.catalog(permission)).allowed
    const groups = categories
      .map((category) => ({
        category,
        skills: catalog.filter((skill) => skill.category === category).sort((a, b) => a.name.localeCompare(b.name)),
      }))
      .filter((group) => group.skills.length)
    if (!groups.length) return
    return [
      "<domain-skills>",
      "Your domain library. Load a skill with skill({name}) when its procedure applies; load one at a time and do not narrate the load.",
      ...groups.flatMap((group) => [
        `${group.category}:`,
        ...group.skills.map((skill) => `- ${skill.name}: ${skill.summary ?? sentence(skill.description)}`),
      ]),
      "</domain-skills>",
    ].join("\n")
  }

  export async function availableSkills(permission: PermissionNext.Ruleset, message?: string) {
    const catalog = (await Skill.catalog(permission)).allowed
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
    const skills = catalog
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
    const matches = searchSkills(message ?? "", skills)
    const likely = matches.length
      ? [
          "Likely matches for this request:",
          ...matches.map(
            (skill) =>
              `- ${skill.name}: ${skill.description.slice(0, 120)}${skill.description.length > 120 ? "..." : ""}`,
          ),
        ]
      : []
    const names = new Map(skills.map((skill) => [skill.name.toLowerCase(), skill.name]))
    const invoked = [...(message ?? "").matchAll(/(?:^|[\s([{'\"])\/([a-z0-9][a-z0-9_-]*)(?=$|[^a-z0-9_/-])/gi)]
      .map((match) => match[1].toLowerCase())
      .map((name) => names.get(name) ?? names.get(SkillCatalog.resolve(name).toLowerCase()))
      .filter((name): name is string => !!name)
      .filter((name, index, all) => all.indexOf(name) === index)
    const invoke = invoked.length
      ? [
          "<slash-skill-invocation>",
          `The user explicitly invoked ${invoked.map((name) => `/${name}`).join(", ")}. Before substantive work, load ${invoked.map((name) => `skill({name:"${name}"})`).join(" and ")} with no preceding text. Treat these explicit skills as the complete requested workflow scope; do not add likely matches or routing-table skills unless a loaded skill names a required dependency. Then answer the surrounding request.`,
          "</slash-skill-invocation>",
        ]
      : []

    return publish(
      [
        "<available-skills>",
        `${total} callable across: ${list}.`,
        ...(invoked.length ? [] : likely),
        invoked.length
          ? "Use only the explicitly invoked skills for this request unless one of their loaded instructions names a required dependency."
          : 'Load a likely match by its listed exact name. If no exact name is known or the shortlist is insufficient, use skill({query:"<focused task>"}) and load a returned exact name. Browse a category only when category browsing is useful. Do not invent names from task descriptions or static routing tables.',
        "</available-skills>",
        ...invoke,
      ].join("\n"),
    )
  }

  /** The curated core in the order a research task tends to need it. Every
   * other core skill follows alphabetically, so a new core skill shows up
   * without a code change. */
  const CORE_ORDER = [
    "research-lookup",
    "literature-review",
    "brainstorming",
    "hypotheses",
    "reproduce",
    "autoresearch",
    "compute",
    "execution-hygiene",
    "delegation",
    "figures",
    "schematics",
    "paper-writing",
    "ml-paper-writing",
    "citations",
    "peer-review",
    "sources",
  ]

  /** Library categories worth naming in the index so a provider or database
   * skill is one exact-name load away, without a search. */
  const CORE_POINTERS: Array<{ category: string; when: string; limit: number }> = [
    { category: "cloud-compute", when: "GPU or cloud provider setup; check compute_job targets first", limit: 12 },
    { category: "databases", when: "a biological, chemical, clinical or scholarly database", limit: 12 },
  ]

  /**
   * The always-present skill index for Research: one line per core skill,
   * then the two library categories that a task may need by exact name.
   * Bodies are never preloaded; the model loads a skill when it applies.
   */
  export async function coreSkills(permission: PermissionNext.Ruleset) {
    const catalog = (await Skill.catalog(permission)).allowed
    const core = catalog
      .filter((skill) => skill.category === "core")
      .sort((a, b) => {
        const left = CORE_ORDER.indexOf(a.name)
        const right = CORE_ORDER.indexOf(b.name)
        if (left >= 0 && right >= 0) return left - right
        if (left >= 0) return -1
        if (right >= 0) return 1
        return a.name.localeCompare(b.name)
      })
    if (!core.length) return
    const sentence = (text: string) => {
      const first = text.split(/(?<=[.!?])\s+/)[0] ?? text
      return first.length > 200 ? `${first.slice(0, 197)}...` : first
    }
    const pointers = CORE_POINTERS.flatMap((pointer) => {
      const names = catalog
        .filter((skill) => skill.category === pointer.category)
        .map((skill) => skill.name)
        .sort()
      if (!names.length) return []
      const shown = names.slice(0, pointer.limit)
      const rest = names.length - shown.length
      return [
        `- ${pointer.when}: ${shown.join(", ")}${rest > 0 ? ` (+${rest} more via skill({category:"${pointer.category}"}))` : ""}`,
      ]
    })
    return [
      "<core-skills>",
      "Core skills, loaded with skill({name}) before the first substantive step when the request matches. Load one skill for the task at hand; do not stack skills or narrate the load.",
      ...core.map((skill) => `- ${skill.name}: ${skill.summary ?? sentence(skill.description)}`),
      ...(pointers.length ? ["Library skills by exact name for provider and database work:", ...pointers] : []),
      `Anything else in the ${catalog.length}-skill library: skill({query:"<focused task>"}) and load an exact returned name.`,
      "</core-skills>",
    ].join("\n")
  }

  /** The one line that stops a model treating its training-time frontier as
   * the present: the catalog's cutoff, the gap to today, and where the gap
   * bites (choosing a model, version, baseline or protocol). It is fixed for
   * the day, so it sits in the cached system prompt beside the date. */
  export function cutoff(knowledge: string | undefined, now = new Date()) {
    const parsed = knowledge ? new Date(/^\d{4}-\d{2}$/.test(knowledge) ? `${knowledge}-15` : knowledge) : undefined
    const known = parsed && !Number.isNaN(parsed.getTime()) ? parsed : undefined
    const months = known ? Math.max(0, Math.round((now.getTime() - known.getTime()) / (30.44 * 86_400_000))) : undefined
    const gap =
      months === undefined
        ? ""
        : months < 1
          ? ", within the last month"
          : `, about ${months} month${months === 1 ? "" : "s"} before today`
    const head = known
      ? `Knowledge cutoff: ${knowledge} (per the model catalog)${gap}.`
      : "Knowledge cutoff: not listed for this model; assume it is months before today."
    return `${head} Models, libraries, methods and results released since are not in your training: look up the current generation before pinning a model, version, baseline or protocol, and read "latest" in a dated source as of its date.`
  }

  export async function environment(
    model: { api: { id: string }; providerID: string; knowledge?: string },
    sessionID: string,
    /** Lines the harness units add inside <env>: compute, time budget, spend. */
    extra: string[] = [],
  ) {
    const project = Instance.project
    const context = await Promise.all([SessionFilesystem.snapshot(sessionID), ProjectAccess.status(project)])
    const filesystem = context[0]
    const workspace = filesystem.workspace.scratchRoot
    const isolated = filesystem.workspace.mode === "isolated"
    // A connected read/write folder that is the working directory: relative
    // paths land in the user's own folder, and scratch stays for side outputs.
    const folder = filesystem.toolDirectory !== workspace ? filesystem.toolDirectory : undefined
    // A delegated worker inherits the lead's directory rather than a folder
    // the user connected; say so, since its files are the lead's deliverables.
    const shared = filesystem.grants.some(
      (grant) => grant.source === "parent" && !grant.time.revoked && grant.path === folder,
    )
    const projectAccess = context[1]
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
        ...(folder
          ? [
              shared
                ? `  Working folder: ${folder} (the lead session's working directory, shared with this worker; relative paths resolve here and files written here are the lead's deliverables)`
                : `  Working folder: ${folder} (connected read and write folder; relative paths resolve here, and files stay when the session ends)`,
              `  Session scratch: ${workspace} (temporary and isolated to this conversation; for caches and side outputs)`,
            ]
          : isolated
            ? [`  Session scratch: ${workspace} (temporary and isolated to this conversation)`]
            : [`  Tool working directory: ${workspace} (project directory; durable and shared across this project)`]),
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
        `  ${cutoff(model.knowledge)}`,
        ...extra.map((line) => `  ${line}`),
        `</env>`,
        `An OpenScience project is a durable research context that may aggregate multiple connected folders and files. ${isolated ? "Session scratch belongs only to this conversation." : "This session uses the project directory as its default tool working directory; its files are shared and remain when the session is deleted."} Results are immutable deliverables shared project-wide; a normal workspace file is not a Result until artifact save_file returns its Result ID and version.`,
        `${
          folder
            ? "The Working folder is the user's own directory and the default for relative paths: create and edit the user's files there, preserve what exists, and treat changes as durable. Use Session scratch for downloads, caches, and throwaway intermediates the user did not ask to keep."
            : isolated
              ? "Use Session scratch by default for one-off downloads, analyses, scripts, tables, and plots. Work in Project files only when the user points to existing durable material or asks to keep reusable outputs."
              : "Use the project directory by default for local work. Preserve existing files and treat changes as durable project changes."
        } Reuse the selected folder's existing layout. Do not create an extra "OpenScience Research" root or mirror an attached project into Project files. Inspect a referenced plan subfolder without treating it as a new working location; keep outputs in the selected Working folder and existing project layout unless the user requests another location. Do not create a new project subfolder for an ordinary answer. Promote a file to Results only when the user requests a durable deliverable or a Result-only contract requires it.`,
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

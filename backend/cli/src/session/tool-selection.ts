import type { Agent } from "@/agent/agent"
import { PermissionNext } from "@/permission/next"

export namespace ToolSelection {
  export const THIN_RESEARCH_AGENT = "researchagent-test"
  export const THIN_TOOL_TARGET = 12

  const thinCore = new Set(["invalid", "question", "bash", "read", "glob", "grep", "apply_patch"])
  const thinForbidden = new Set(["research_contract", "atlas", "atlas_record", "provenance_query", "provenance_record"])
  const thinComplex =
    /\b(?:autonomously|benchmark|build|candidate|compare|dataset|deliver|design|develop|execute|experiment|implement|literature|paper|pipeline|rank|report|research|study|validate|workflow)\b/i
  const thinWeb =
    /https?:\/\/|\b(?:browse|citation|current|database|dataset|docs|documentation|download|find online|latest|literature|look up|online|paper|search|source|web)\b/i
  const thinSkill =
    /(?:^|[\s([{'"])\/[a-z0-9][a-z0-9_-]*(?=$|[^a-z0-9_/-])|\b(?:bionemo|citation|latex|manuscript|paper|pdf|skill|venue)\b/i
  const thinCompute = /\b(?:batch|cluster|compute|gpu|h100|job|modal|remote|slurm)\b/i
  const thinArtifact =
    /\b(?:artifact|deliver|docx|figure|file|html|latex|output|paper|pdf|plot|pptx|report|result|xlsx)\b/i
  const thinImage = /\b(?:generate|create|draw|render)\b.{0,40}\b(?:art|graphic|illustration|image|schematic)\b/i

  const domain = new Set([
    "artifact",
    "atlas",
    "atlas_record",
    "compute_job",
    "generate_image",
    "provenance_query",
    "provenance_record",
    "python",
    "r",
    "research_contract",
    "science_fetch",
    "science_list_dbs",
    "science_search",
  ])
  const code =
    /\b(?:api|backend|bash|branch|bug|build|cli|code|codebase|commit|compile|endpoint|frontend|git|github|golang|java|javascript|kotlin|lint|package manager|php|pull request|python|refactor|repo|repository|ruby|rust|sdk|server|shell|source code|swift|test suite|typecheck|typescript|working tree)\b/i
  const science =
    /\b(?:benchmark|bioinformatics|biology|cell|chemistry|clinical|data analysis|dataset|evidence|evaluation|experiment|gene|genomic|hypothesis|literature|machine learning|metric|model comparison|molecule|neural|paper|physics|protein|reproducibility|research|rna|science|scientific|simulation|statistics?|study|validation)\b/i
  const work =
    /\b(?:analy[sz]e|attached|calculate|cite|create|current|dataset|document|download|fetch|file|find|inspect|latest|load|look up|open|paper|plot|read|review|run|save|source|today|verify|write)\b|\bsearch\s+(?:for|my|our|the|this|these|those)\b|https?:\/\/|\.[a-z0-9]{1,5}\b/i
  const browse = new Set(["glob", "grep", "invalid", "read"])
  const slash = /(?:^|[\s([{'\"])\/([a-z0-9][a-z0-9_-]*)(?=$|[^a-z0-9_/-])/i
  const descriptions: Record<string, string> = {
    glob: "Find local files by glob pattern. Omit path for the workspace or provide a directory to constrain the search. Returns up to 100 paths.",
    grep: "Search local file contents with a regular expression. Constrain the directory with path and file globs with include. Returns matching lines with paths and line numbers.",
    read: "Read a local text, image, or PDF file by absolute path. Use parallel calls for independent files. Set offset and limit only when a bounded line range is sufficient.",
  }

  export function fresh(roles: string[]) {
    return roles.filter((role) => role === "user").length === 1
  }

  /** A slash token is an explicit request for a command or skill, even when
   *  the surrounding prose otherwise looks like a tool-free direct answer. */
  export function slashInvocation(message?: string) {
    return slash.test(message ?? "")
  }

  export function description(tool: string, value: string, inspection = false) {
    if (!inspection) return value
    return descriptions[tool] ?? value
  }

  function inspect(message: string) {
    const readonly =
      /\b(?:do not|don't|without)\s+(?:change|creat(?:e|ing)|delet(?:e|ing)|edit(?:ing)?|modif(?:y|ying)|writ(?:e|ing))\b/i
    const request = /\b(?:compare|explain|inspect|read|report|review|show|summarize)\b/i
    const local =
      /\b(?:codebase|file|files|path|repo|repository|source|working tree)\b|(?:^|[\s'"`])[\w./-]+\.[a-z0-9]{1,8}\b/i
    const broader =
      /https?:\/\/|\b(?:build|compile|current|execute|git|github|install|latest|look up|out[- ]of[- ]date|pull request|run|search (?:the )?(?:internet|web)|today|up[- ]to[- ]date|use (?:bash|lsp|python|r|shell))\b/i
    return (
      message.length <= 1_000 &&
      readonly.test(message) &&
      request.test(message) &&
      local.test(message) &&
      !broader.test(message) &&
      !science.test(message)
    )
  }

  export function enabled(
    tool: string,
    input: {
      permission: Agent.Info["permission"]
      tools?: Record<string, boolean>
    },
  ) {
    if (input.tools?.["*"] === false) return false
    if (input.tools?.[tool] === false) return false
    return !PermissionNext.disabled([tool], input.permission).has(tool)
  }

  /** The experimental thin profile keeps one small local work surface and
   * adds expensive/specialized capabilities only when the current request
   * names or strongly implies them. Production Research never enters here. */
  export function thinRelevant(
    tool: string,
    input: {
      message?: string
      tools?: Record<string, boolean>
    },
  ) {
    if (thinForbidden.has(tool)) return false
    if (input.tools?.[tool] === true) return true
    if (thinCore.has(tool)) return true

    const message = input.message?.trim() ?? ""
    if (tool === "task") return thinComplex.test(message)
    if (tool === "webfetch" || tool === "research_search") return thinWeb.test(message)
    if (tool === "skill") return thinSkill.test(message)
    if (tool === "compute_job") return thinCompute.test(message)
    if (tool === "artifact") return thinArtifact.test(message)
    if (tool === "generate_image") return thinImage.test(message)
    if (tool === "python") return /\b(?:python|notebook|pandas|scipy|sklearn|pytorch)\b/i.test(message)
    if (tool === "r") return /\b(?:r language|r kernel|rstudio|tidyverse|ggplot2)\b/i.test(message)
    return false
  }

  /** Cap the provider-facing thin surface after model-specific edit-tool
   * selection. `invalid` remains available for repair but does not consume one
   * of the advertised capability slots. Explicit per-turn enables win before
   * inferred capabilities. */
  export function thinLimit(ids: string[], tools?: Record<string, boolean>, maximum = THIN_TOOL_TARGET) {
    const available = new Set(ids)
    const selected = new Set<string>()
    if (available.has("invalid")) selected.add("invalid")

    const add = (id: string) => {
      if (!available.has(id) || selected.has(id)) return
      const active = [...selected].filter((item) => item !== "invalid").length
      if (active < maximum) selected.add(id)
    }
    for (const id of ["question", "bash", "read", "glob", "grep", "apply_patch"]) add(id)
    for (const [id, enabled] of Object.entries(tools ?? {})) {
      if (enabled && !thinForbidden.has(id)) add(id)
    }
    for (const id of [
      "task",
      "compute_job",
      "research_search",
      "webfetch",
      "skill",
      "artifact",
      "generate_image",
      "python",
      "r",
    ])
      add(id)
    return selected
  }

  export function direct(input: {
    agent?: string
    message?: string
    fresh?: boolean
    attachments?: boolean
    tools?: Record<string, boolean>
  }) {
    if (
      (input.agent !== "research" && input.agent !== THIN_RESEARCH_AGENT) ||
      !input.fresh ||
      input.attachments ||
      slashInvocation(input.message) ||
      Object.values(input.tools ?? {}).some((enabled) => enabled)
    )
      return false
    const message = input.message?.trim()
    if (!message || message.length > 320 || code.test(message) || work.test(message)) return false
    return /^(?:(?:in|within)\s+(?:no more than\s+)?(?:one|two|three|\d+)\s+sentences?,?\s*)?(?:please\s+)?(?:briefly\s+)?(?:compare|define|explain|how|what|why)\b/i.test(
      message,
    )
  }

  export function inspection(input: {
    agent?: string
    message?: string
    fresh?: boolean
    attachments?: boolean
    tools?: Record<string, boolean>
  }) {
    if (
      (input.agent !== "research" && input.agent !== THIN_RESEARCH_AGENT) ||
      !input.fresh ||
      input.attachments ||
      slashInvocation(input.message) ||
      Object.values(input.tools ?? {}).some((enabled) => enabled)
    )
      return false
    const message = input.message?.trim()
    return Boolean(message && inspect(message))
  }

  /**
   * Fresh direct answers carry no implicit tools. Explicit local read-only
   * requests keep file discovery only. Code-only requests drop research
   * contracts, while ambiguous and mixed work keeps the full registry. A named
   * tool or capability also stays available.
   */
  export function relevant(
    tool: string,
    input: {
      agent?: string
      message?: string
      tools?: Record<string, boolean>
      direct?: boolean
    },
  ) {
    if (input.agent === THIN_RESEARCH_AGENT) return thinRelevant(tool, input)
    if (input.tools?.[tool] === true) return true
    if (input.direct) return false
    if (input.agent !== "research") return true

    const message = input.message?.trim()
    if (message && inspect(message)) return browse.has(tool)
    if (!domain.has(tool)) return true
    if (!message || !code.test(message) || science.test(message)) return true

    const named = (() => {
      if (tool === "python") return /\bpython\b|\bpy(?:thon)? kernel\b|\bnotebook\b/i.test(message)
      if (tool === "r") return /\bR\b|\br (?:kernel|language)\b|\brstudio\b/.test(message)
      if (tool === "compute_job")
        return /\b(?:cluster|compute job|gpu|job broker|modal|remote compute|slurm)\b/i.test(message)
      if (tool === "research_contract")
        return /\b(?:research contract|research loop|autonomous research)\b/i.test(message)
      if (tool === "generate_image")
        return /\b(?:diagram|figure|graphic|illustration|image|nano banana|poster|schematic|slide|visual)\b/i.test(
          message,
        )
      if (tool === "atlas" || tool === "atlas_record") return /\batlas\b/i.test(message)
      if (tool.startsWith("provenance_")) return /\b(?:lineage|provenance)\b/i.test(message)
      if (tool.startsWith("science_")) return /\bscientific database\b|\bscience tool\b/i.test(message)
      return /\b(?:artifact|chart|figure|report|visualization)\b/i.test(message)
    })()
    return named
  }
}

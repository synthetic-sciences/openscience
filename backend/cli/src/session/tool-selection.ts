import type { Agent } from "@/agent/agent"
import { PermissionNext } from "@/permission/next"

export namespace ToolSelection {
  const domain = new Set([
    "artifact",
    "artifact_snapshot",
    "atlas",
    "atlas_record",
    "compute_job",
    "provenance_query",
    "provenance_record",
    "provenance_resolve",
    "provenance_review",
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
    /\b(?:bioinformatics|biology|cell|chemistry|clinical|data analysis|dataset|evidence|experiment|gene|genomic|hypothesis|literature|machine learning|molecule|neural|paper|physics|protein|research|rna|science|scientific|simulation|statistics?|study)\b/i

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

  /**
   * Drop research-only contracts for requests that are explicitly about code
   * and contain no scientific work. Ambiguous, mixed, and non-code requests
   * keep the full registry. A named tool or capability also stays available.
   */
  export function relevant(
    tool: string,
    input: {
      agent?: string
      message?: string
      tools?: Record<string, boolean>
    },
  ) {
    if (!domain.has(tool)) return true
    if (input.tools?.[tool] === true) return true
    if (input.agent !== "research") return true

    const message = input.message?.trim()
    if (!message || !code.test(message) || science.test(message)) return true

    const named = (() => {
      if (tool === "python") return /\bpython\b|\bpy(?:thon)? kernel\b|\bnotebook\b/i.test(message)
      if (tool === "r") return /\bR\b|\br (?:kernel|language)\b|\brstudio\b/.test(message)
      if (tool === "compute_job") return /\b(?:cluster|compute job|gpu|job broker|modal|remote compute|slurm)\b/i.test(message)
      if (tool === "research_contract") return /\b(?:research contract|research loop|autonomous research)\b/i.test(message)
      if (tool === "atlas" || tool === "atlas_record") return /\batlas\b/i.test(message)
      if (tool.startsWith("provenance_")) return /\b(?:lineage|provenance)\b/i.test(message)
      if (tool.startsWith("science_")) return /\bscientific database\b|\bscience tool\b/i.test(message)
      return /\b(?:artifact|chart|figure|report|visualization)\b/i.test(message)
    })()
    return named
  }
}

import type { Agent } from "@/agent/agent"
import { PermissionNext } from "@/permission/next"

export namespace ToolSelection {
  export const THIN_RESEARCH_AGENT = "researchagent-test"
  export function minimalResearchAgent(agent: string | undefined) {
    return agent === "research" || agent === THIN_RESEARCH_AGENT
  }
  const core = new Set([
    "invalid",
    "question",
    "bash",
    "read",
    "glob",
    "grep",
    "webfetch",
    "research_search",
    "skill",
    "task",
  ])
  const edits = new Set(["write", "edit", "apply_patch"])
  const python = new Set(["python", "notebook"])
  const r = new Set(["r", "rkernel"])
  const codeTools = new Set(["codesearch", "lsp", "multiedit"])
  const todo = new Set(["todowrite", "todoread", "planwrite"])
  const biology = new Set([
    "query_ensembl",
    "query_kegg",
    "query_ncbi_gene",
    "query_pdb",
    "query_pubmed",
    "query_string",
    "query_uniprot",
  ])
  const code =
    /\b(?:api|backend|bash|branch|bug|build|cli|code|codebase|commit|compile|endpoint|frontend|git|github|golang|java|javascript|kotlin|lint|package manager|php|pull request|python|refactor|repo|repository|ruby|rust|sdk|server|shell|source code|swift|test suite|typecheck|typescript|working tree)\b/i
  const science =
    /\b(?:benchmark|bioinformatics|biology|cell|chemistry|clinical|data analysis|dataset|evidence|evaluation|experiment|gene|genomic|hypothesis|literature|machine learning|metric|model comparison|molecule|neural|paper|physics|protein|reproducibility|research|rna|science|scientific|simulation|statistics?|study|validation)\b/i
  const scientificCatalog =
    /\b(?:alphafold[- ]?2|biopython|matplotlib|rdkit|scipy|scikit[- ]learn|boltz[- ]?2|diffdock|evo[- ]?2|genmol|molmim|msa[- ]?search|openfold[- ]?[23]|protein[- ]?mpnn|rf[- ]?diffusion|bionemo|nvidia[- ]nim)\b/i
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

  // The development profile keeps a smaller system prompt, but tool
  // availability follows the same relevance and permission rules as Research.
  // Capability selection belongs to the model, not a keyword shortlist.
  export function direct(input: {
    agent?: string
    message?: string
    fresh?: boolean
    attachments?: boolean
    tools?: Record<string, boolean>
  }) {
    if (
      !minimalResearchAgent(input.agent) ||
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
      !minimalResearchAgent(input.agent) ||
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
      capabilities?: ReadonlySet<string>
      activatedTools?: ReadonlySet<string>
    },
  ) {
    if (input.tools?.[tool] === true) return true
    if (input.activatedTools?.has(tool)) return true
    if (input.direct) return false
    if (!minimalResearchAgent(input.agent)) return true

    const message = input.message?.trim()
    if (message && inspect(message)) return browse.has(tool)
    // Atlas is a legacy compatibility surface, not a general research
    // capability. Keep it available for explicit Atlas work without letting
    // unrelated scientific prompts wander into a retired service path.
    if (tool === "atlas" || tool === "atlas_record") return Boolean(message && /\batlas\b/i.test(message))
    // Provenance remains an internal integrity primitive. It is deliberately
    // absent from the user-facing Research tool surface; Results and ordinary
    // files are the product-facing record.
    if (tool.startsWith("provenance_")) return false
    if (core.has(tool)) return true

    const text = message ?? ""
    const capabilities = input.capabilities ?? new Set<string>()
    const capability = [...capabilities].join(" ")
    const scientific =
      science.test(text) ||
      scientificCatalog.test(text) ||
      /protein|biology|interpretability|literature|scientific|modal/i.test(capability)
    const analysis =
      /\b(?:analy[sz](?:e|is)|benchmark|calculate|chart|data|dataset|experiment|fit|model|plot|simulation|statistics?|visuali[sz])\b/i.test(
        text,
      ) || /protein-binder|mechanistic-interpretability/i.test(capability)
    const writing =
      /\b(?:append|change|create|deliver|draft|edit|file|manuscript|modify|notes?|paper|report|save|update|write)\b/i.test(
        text,
      ) || /scientific-writing|paper-writing/i.test(capability)

    // Keep the compact catalog available for scientific work without paying
    // its schema cost on unrelated repository or product-UI turns.
    if (tool === "scientific_capability") return scientific
    if (edits.has(tool)) return writing || analysis || code.test(text)
    if (codeTools.has(tool)) return code.test(text)
    if (python.has(tool)) return analysis || /\bpython\b|\bnotebook\b/i.test(text)
    if (r.has(tool)) return /\bR\b|\br (?:kernel|language)\b|\brstudio\b/.test(text)
    if (tool === "artifact") return writing || analysis || /\b(?:deliverable|result)\b/i.test(text)
    if (tool === "generate_image")
      return /\b(?:diagrams?|figures?|graphics?|illustrations?|images?|posters?|schematics?|slides?|visuals?)\b/i.test(
        text,
      )
    if (tool === "compute_job" || tool === "modal")
      return (
        /\b(?:cluster|compute job|gpu|modal|remote compute|slurm|pbs|h100)\b/i.test(text) ||
        /modal-compute|protein-binder/i.test(capability)
      )
    if (tool === "research_contract") return /\bresearch contract\b/i.test(text)
    if (todo.has(tool)) {
      // A long research prompt is not consent to add controller ceremony. A
      // stale 0/N checklist is worse than no checklist, so expose these tools
      // only when the user explicitly asks to track one.
      return /\b(?:to-?dos?|task list|checklist)\b/i.test(text)
    }
    if (biology.has(tool)) {
      if (/literature-review/i.test(capability) && tool === "query_pubmed") return true
      const pattern: Record<string, RegExp> = {
        query_ensembl: /\b(?:ensembl|gene|genom)/i,
        query_kegg: /\b(?:kegg|pathway)/i,
        query_ncbi_gene: /\b(?:ncbi|gene)/i,
        query_pdb: /\b(?:pdb|protein structure|complex|binder)/i,
        query_pubmed: /\b(?:pubmed|literature|paper|citation)/i,
        query_string: /\b(?:string database|protein interaction)/i,
        query_uniprot: /\b(?:uniprot|protein|sequence)/i,
      }
      return pattern[tool]?.test(text) ?? false
    }
    if (tool.startsWith("science_"))
      return scientific && /\b(?:accession|database|dataset|doi|identifier|literature|source)\b/i.test(text)
    return false
  }
}

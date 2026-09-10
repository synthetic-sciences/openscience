import type { Agent } from "@/agent/agent"
import { PermissionNext } from "@/permission/next"
import type { MessageV2 } from "./message-v2"

export namespace ToolSelection {
  export const THIN_RESEARCH_AGENT = "researchagent-test"
  export function minimalResearchAgent(agent: string | undefined) {
    return agent === "research" || agent === THIN_RESEARCH_AGENT
  }
  const core = new Set([
    "artifact",
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
    /\b(?:alignment|benchmark|bioinformatics|biology|cell|chemistry|clinical|data analysis|dataset|evidence|evaluation|experiment|gene|genom(?:e|es|ic|ics)|hypothesis|literature|machine learning|metric|model comparison|molecule|neural|paper|physics|protein|reproducibility|research|rna|science|scientific|sequenc(?:e|ing)|simulation|statistics?|study|transcriptom(?:e|ic|ics)|validation)\b/i
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

  /** Capabilities and tools unlocked by skills loaded anywhere in the given
   * messages. Scanning a request's whole epoch keeps a skill's bundle offered
   * through the synthetic continuations of the same task. */
  export function activation(messages: readonly MessageV2.WithParts[]) {
    const capabilities = new Set<string>()
    const tools = new Set<string>()
    for (const message of messages) {
      if (message.info.role !== "assistant") continue
      for (const part of message.parts) {
        if (part.type !== "tool" || part.tool !== "skill" || part.state.status !== "completed") continue
        const metadata = part.state.metadata as { capability?: unknown; allowedTools?: unknown } | undefined
        if (typeof metadata?.capability === "string") capabilities.add(metadata.capability)
        if (!Array.isArray(metadata?.allowedTools)) continue
        for (const tool of metadata.allowedTools) if (typeof tool === "string") tools.add(tool)
      }
    }
    return { capabilities, tools }
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

  const quickAsk =
    /^(?:(?:ok(?:ay)?|now|also|and|then|great|thanks?|please|just|quickly|can you|could you|would you|pls)[\s,]+)*(?:please\s+|just\s+|quickly\s+)?(?:give|get|show|print|paste|copy|list|tell|write out|output|return|send|share|extract|pull out|summari[sz]e|convert|format|reformat|turn|put|make|export|translate|rename|shorten|expand|explain|what|what's|which|where|how many|how long|is|are|does|do|did|can)\b/i
  const heavy =
    /\b(?:analy[sz]e|benchmark|experiments?|investigate|implement|train|reproduce|survey|literature|pipeline|debug|refactor|deploy|design|research|evaluate|optimi[sz]e|thorough(?:ly)?|comprehensive|end[- ]to[- ]end|full(?:y)?|entire|whole|all (?:the )?(?:files|papers|datasets|results)|every|across|systematic|rigorous|from scratch|step[- ]by[- ]step|deep(?:ly)?)\b/i
  const deliverable =
    /\b(?:abstract|answer|bullet|caption|citation|code block|command|equation|figure|formula|latex|list|markdown|number|one[- ]liner|paragraph|sentence|snippet|summary|table|title|value|version)s?\b/i

  /**
   * A small ask inside a research conversation: an extraction, a reformat,
   * a short factual follow-up. It keeps every tool but drops the delegation
   * posture and asks the model to answer in one pass with default-low effort,
   * so a "give me the abstract as LaTeX" request takes seconds, not minutes.
   */
  export function quick(input: { agent?: string; message?: string; fresh?: boolean; attachments?: boolean }) {
    if (!minimalResearchAgent(input.agent) || slashInvocation(input.message)) return false
    const message = input.message?.trim().replace(/\s+/g, " ")
    if (!message || message.length > 400) return false
    const sentences = message.split(/(?<=[.!?])\s+/).filter(Boolean).length
    if (sentences > 2 || heavy.test(message)) return false
    if (!quickAsk.test(message)) return false
    // A fresh conversation has nothing to extract from; only a plainly small
    // deliverable qualifies there. Follow-ups qualify on shape alone.
    if (input.fresh && !input.attachments) return deliverable.test(message)
    return true
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
      extensions?: ReadonlySet<string>
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
    // Installed host extensions declare capabilities through their own schema.
    // Direct answers and read-only inspection above still keep their narrow set.
    if (input.extensions?.has(tool)) return true
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
    if (tool === "generate_image")
      return /\b(?:diagrams?|figures?|graphics?|illustrations?|images?|posters?|schematics?|slides?|visuals?)\b/i.test(
        text,
      )
    const compute = /\bcompute[-_ ]job\b/i.test(text)
    const remote =
      /\b(?:cluster|gpu|modal|remote compute|slurm|pbs|h100)\b/i.test(text) ||
      /modal-compute|protein-binder/i.test(capability)
    const durable =
      /\b(?:in the background|long[- ]running|multi[- ]hour|overnight|all night|outlive (?:this|the) call|keep (?:this|it|them) running|durable\s+(?:command|job|pipeline|process|task|work))\b/i.test(
        text,
      )
    // Work that plainly cannot finish inside one shell call: an explicit
    // duration, a workflow manager or scheduler, a genomics or ML tool that
    // runs for hours. Bash tells the model to reach for compute_job here, so
    // the tool has to be on offer when the prompt reads like this.
    const lengthy =
      /\b(?:(?:several|many|a few|couple of|\d+\+?)\s+(?:hours?|days?)|hours?[- ]long|days?[- ]long|takes? (?:a )?(?:while|long time)|(?:will|might|could|should|would) take (?:a )?(?:while|long|hours?|days?))\b/i.test(
        text,
      )
    const workflow =
      /\b(?:nextflow|snakemake|cromwell|wdl|cwl|sbatch|qsub|bsub|fasterq-dump|fastq-dump|prefetch|fastp|fastqc|bwa(?:-mem2?)?|bowtie2?|salmon|kallisto|hisat2?|minimap2|gatk|cellranger|colabfold|alphafold|fine-?tun\w*|pre-?train\w*|epochs?|training run)\b|\b(?:star|bwa|bowtie2?|salmon|kallisto|hisat2?)\s+(?:index|align\w*|quant\w*)\b|\b(?:genome|reference) index\b|\bfastq\b/i.test(
        text,
      )
    const repository =
      /\b(?:backend|branch|codebase|frontend|git|github|pull request|repo|repository|source code|test suite)\b/i.test(
        text,
      )
    if (tool === "compute_job")
      return (
        compute ||
        remote ||
        durable ||
        lengthy ||
        workflow ||
        (scientific &&
          !repository &&
          /\b(?:align|batch|download|index|pipeline|process|quantif|run|train|workflow)\w*\b/i.test(text))
      )
    if (tool === "modal") return remote
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

import { describe, expect, test } from "bun:test"
import { PermissionNext } from "../../src/permission/next"
import { ToolSelection } from "../../src/session/tool-selection"

describe("tool selection", () => {
  test("keeps the first user turn fresh across assistant tool-loop steps", () => {
    expect(ToolSelection.fresh(["user"])).toBe(true)
    expect(ToolSelection.fresh(["user", "assistant", "assistant"])).toBe(true)
    expect(ToolSelection.fresh(["user", "assistant", "user"])).toBe(false)
  })

  test("compacts only built-in inspection tool descriptions", () => {
    const original = "long global description"
    expect(ToolSelection.description("read", original)).toBe(original)
    expect(ToolSelection.description("read", original, true)).toContain("absolute path")
    expect(ToolSelection.description("grep", original, true)).toContain("regular expression")
    expect(ToolSelection.description("glob", original, true)).toContain("glob pattern")
    expect(ToolSelection.description("invalid", original, true)).toBe(original)
  })

  const permission = PermissionNext.fromConfig({
    "*": "allow",
    edit: "deny",
    read: "allow",
  })

  test("applies permission aliases before tools are initialized", () => {
    expect(ToolSelection.enabled("apply_patch", { permission })).toBe(false)
    expect(ToolSelection.enabled("edit", { permission })).toBe(false)
    expect(ToolSelection.enabled("read", { permission })).toBe(true)
  })

  test("applies per-turn tool controls", () => {
    expect(ToolSelection.enabled("read", { permission, tools: { read: false } })).toBe(false)
    expect(ToolSelection.enabled("read", { permission, tools: { "*": false, read: true } })).toBe(false)
  })

  test("removes research-only contracts from unambiguous repository work", () => {
    const input = { agent: "research", message: "Inspect this Git repository branch and run its test suite." }
    expect(ToolSelection.relevant("bash", input)).toBe(true)
    expect(ToolSelection.relevant("compute_job", input)).toBe(false)
    expect(ToolSelection.relevant("python", input)).toBe(false)
    expect(ToolSelection.relevant("science_search", input)).toBe(false)
  })

  test("activates scientific capabilities only when the request needs them", () => {
    for (const capability of [
      "SciPy",
      "Matplotlib",
      "scikit-learn",
      "Biopython",
      "RDKit",
      "AlphaFold2",
      "Boltz-2",
      "DiffDock",
      "Evo 2",
      "GenMol",
      "MolMIM",
      "MSA Search",
      "OpenFold2",
      "OpenFold3",
      "ProteinMPNN",
      "RFdiffusion",
      "BioNeMo",
      "NVIDIA NIM",
    ]) {
      expect(
        ToolSelection.relevant("scientific_capability", {
          agent: "research",
          message: `Use ${capability} for this workflow.`,
        }),
      ).toBe(true)
    }
    expect(
      ToolSelection.relevant("scientific_capability", {
        agent: "research",
        message: "Run this research workflow with the best supported scientific package.",
      }),
    ).toBe(true)
    expect(
      ToolSelection.relevant("scientific_capability", {
        agent: "research",
        message: "Fix the CSS in this repository and run its test suite.",
      }),
    ).toBe(false)
    expect(
      ToolSelection.relevant("compute_job", {
        agent: "research",
        message: "Fix the repository pipeline for this genomic dataset experiment.",
      }),
    ).toBe(false)
    expect(ToolSelection.relevant("python", { agent: "research", message: "Analyze this dataset." })).toBe(true)
    expect(ToolSelection.relevant("science_search", { agent: "biology", message: "Fix this file." })).toBe(true)
    expect(ToolSelection.relevant("science_search", { agent: "research", message: "Summarize this source." })).toBe(
      false,
    )
    expect(
      ToolSelection.relevant("research_contract", {
        agent: "research",
        message: "Update the Python harness and benchmark the model against a baseline metric.",
      }),
    ).toBe(false)
    expect(ToolSelection.relevant("atlas", { agent: "research", message: "Analyze this protein dataset." })).toBe(false)
    expect(
      ToolSelection.relevant("atlas_record", {
        agent: "research",
        message: "Publish this provenance record to Atlas.",
      }),
    ).toBe(true)
  })

  test("keeps explicitly named or enabled domain capabilities", () => {
    const message = "Use the Python kernel and GPU cluster while fixing this repository."
    expect(ToolSelection.relevant("python", { agent: "research", message })).toBe(true)
    expect(ToolSelection.relevant("compute_job", { agent: "research", message })).toBe(true)
    expect(
      ToolSelection.relevant("research_contract", {
        agent: "research",
        message: "Use Python to calculate the sum of these integers.",
      }),
    ).toBe(false)
    expect(
      ToolSelection.relevant("research_contract", {
        agent: "research",
        message: "Inspect this repository.",
        tools: { research_contract: true },
      }),
    ).toBe(true)
  })

  test("surfaces durable compute for natural scientific pipeline language", () => {
    const pipeline = {
      agent: "research",
      message:
        "Download 18 SRA runs, build the STAR genome index, align the reads, and run the expression quantification pipeline.",
    }
    expect(ToolSelection.relevant("compute_job", pipeline)).toBe(true)
    expect(ToolSelection.relevant("modal", pipeline)).toBe(false)
    expect(
      ToolSelection.relevant("compute_job", {
        agent: "research",
        message: "Start this long-running background job and let me check its status later.",
      }),
    ).toBe(true)
    expect(
      ToolSelection.relevant("compute_job", {
        agent: "research",
        message: "Fix the repository pipeline for this genomic dataset experiment.",
      }),
    ).toBe(false)
    for (const message of [
      "Use compute_job to run this.",
      "Use compute-job for this task.",
      "Run this in the background.",
      "Run this long running job.",
      "Run this overnight.",
    ]) {
      expect(ToolSelection.relevant("compute_job", { agent: "research", message })).toBe(true)
    }
    expect(
      ToolSelection.relevant("modal", {
        agent: "research",
        message: "Use compute_job to run this.",
      }),
    ).toBe(false)
  })

  test("keeps provenance recording out of the user-facing Research tool surface", () => {
    expect(
      ToolSelection.relevant("provenance_record", {
        agent: "research",
        message: "Run a quick exploratory analysis of the Titanic dataset and make three plots.",
      }),
    ).toBe(false)
    expect(
      ToolSelection.relevant("provenance_record", {
        agent: "research",
        message: "Select accessions by maximin diversity across genotype, provenance climate, and ancestry.",
      }),
    ).toBe(false)
    expect(
      ToolSelection.relevant("provenance_record", {
        agent: "research",
        message: "Record the provenance and lineage for these analysis outputs.",
      }),
    ).toBe(false)
  })

  test("recognizes only fresh self-contained conceptual questions as direct answers", () => {
    expect(
      ToolSelection.direct({
        agent: "research",
        message: "In two sentences, explain why randomization matters in an experiment.",
        fresh: true,
      }),
    ).toBe(true)
    expect(
      ToolSelection.direct({
        agent: "research",
        message: "In two sentences, explain why binary search is logarithmic.",
        fresh: true,
      }),
    ).toBe(true)
    expect(ToolSelection.direct({ agent: "research", message: "What is a p-value?", fresh: true })).toBe(true)
    expect(
      ToolSelection.direct({
        agent: "research",
        message: "What is a p-value? /fixture-skill",
        fresh: true,
      }),
    ).toBe(false)
    expect(ToolSelection.slashInvocation("Explain this (/fixture-skill), then answer.")).toBe(true)
    expect(ToolSelection.slashInvocation("Read /fixture-skill/reference.")).toBe(false)
    expect(
      ToolSelection.direct({ agent: "research", message: "Explain the search for those records.", fresh: true }),
    ).toBe(false)
    expect(ToolSelection.direct({ agent: "research", message: "What is the latest trial result?", fresh: true })).toBe(
      false,
    )
    expect(ToolSelection.direct({ agent: "research", message: "Explain this dataset.", fresh: true })).toBe(false)
    expect(ToolSelection.direct({ agent: "research", message: "Explain how Python works.", fresh: true })).toBe(false)
    expect(
      ToolSelection.direct({
        agent: "research",
        message: "Why does randomization matter?",
        fresh: true,
        attachments: true,
      }),
    ).toBe(false)
    expect(ToolSelection.direct({ agent: "research", message: "Why does randomization matter?", fresh: false })).toBe(
      false,
    )
    expect(
      ToolSelection.direct({
        agent: "research",
        message: "Why does randomization matter?",
        fresh: true,
        tools: { python: true },
      }),
    ).toBe(false)
  })

  test("direct answers advertise no implicit tools while explicit enables still win", () => {
    const input = { agent: "research", message: "What is a p-value?", direct: true }
    expect(ToolSelection.relevant("bash", input)).toBe(false)
    expect(ToolSelection.relevant("context7_query-docs", input)).toBe(false)
    expect(ToolSelection.relevant("python", input)).toBe(false)
    expect(ToolSelection.relevant("python", { ...input, tools: { python: true } })).toBe(true)
  })

  test("explicit local read-only inspection advertises only file discovery tools", () => {
    const message =
      "Inspect the root package.json and backend/cli/package.json. Report the exact Bun version and test script. Do not modify any files."
    const tools = [
      "apply_patch",
      "artifact",
      "bash",
      "context7_query-docs",
      "glob",
      "grep",
      "invalid",
      "question",
      "read",
      "skill",
      "task",
      "todowrite",
      "webfetch",
    ]
    expect(tools.filter((tool) => ToolSelection.relevant(tool, { agent: "research", message }))).toEqual([
      "glob",
      "grep",
      "invalid",
      "read",
    ])
    expect(
      ToolSelection.relevant("bash", {
        agent: "research",
        message: "Run the test script, but do not modify any files.",
      }),
    ).toBe(true)
    expect(
      ToolSelection.relevant("webfetch", {
        agent: "research",
        message: "Inspect https://example.com and do not modify any files.",
      }),
    ).toBe(true)
    expect(
      ToolSelection.relevant("webfetch", {
        agent: "research",
        message: "Review package.json for out-of-date dependencies without modifying files.",
      }),
    ).toBe(true)
    expect(
      ToolSelection.relevant("python", {
        agent: "research",
        message: "Inspect dataset.csv and report summary statistics without modifying files.",
      }),
    ).toBe(true)
    expect(
      ToolSelection.relevant("bash", {
        agent: "research",
        message,
        tools: { bash: true },
      }),
    ).toBe(true)
    expect(
      ToolSelection.inspection({
        agent: "research",
        message,
        fresh: true,
      }),
    ).toBe(true)
    expect(
      ToolSelection.inspection({
        agent: "research",
        message,
        fresh: false,
      }),
    ).toBe(false)
    expect(
      ToolSelection.inspection({
        agent: "research",
        message,
        fresh: true,
        tools: { bash: true },
      }),
    ).toBe(false)
    expect(
      ToolSelection.inspection({
        agent: "research",
        message: `${message} /fixture-skill`,
        fresh: true,
      }),
    ).toBe(false)
  })

  test("keeps a small core and adds only request-local scientific capabilities", () => {
    const message =
      "Use Modal and BioNeMo to execute a protein benchmark, search the literature, and deliver a LaTeX paper with artifacts."
    const available = [
      "invalid",
      "question",
      "bash",
      "read",
      "glob",
      "grep",
      "apply_patch",
      "task",
      "compute_job",
      "research_search",
      "webfetch",
      "skill",
      "artifact",
      "generate_image",
      "python",
      "r",
      "research_contract",
      "context7_query-docs",
    ]
    const relevant = available.filter((tool) =>
      ToolSelection.relevant(tool, { agent: ToolSelection.THIN_RESEARCH_AGENT, message }),
    )
    expect(relevant.length).toBeLessThanOrEqual(14)
    expect(relevant).toEqual(
      expect.arrayContaining([
        "question",
        "bash",
        "read",
        "glob",
        "grep",
        "apply_patch",
        "task",
        "compute_job",
        "research_search",
        "webfetch",
        "skill",
        "artifact",
        "python",
      ]),
    )
    expect(relevant).not.toContain("r")
    expect(relevant).not.toContain("research_contract")
    expect(relevant).not.toContain("context7_query-docs")
  })

  test("a loaded skill activates its bounded capability bundle", () => {
    const capabilities = new Set(["literature-review"])
    expect(
      ToolSelection.relevant("query_pubmed", {
        agent: "research",
        message: "Continue with the review.",
        capabilities,
      }),
    ).toBe(true)
    expect(
      ToolSelection.relevant("compute_job", {
        agent: "research",
        message: "Continue.",
        capabilities,
      }),
    ).toBe(false)

    expect(
      ToolSelection.relevant("generate_image", {
        agent: "research",
        message: "Continue with the requested refinement.",
        activatedTools: new Set(["generate_image"]),
      }),
    ).toBe(true)
  })

  test("plural figure requests keep native image generation visible", () => {
    const message = "Use /scientific-schematics to improve the images and figures in this paper."
    expect(ToolSelection.slashInvocation(message)).toBe(true)
    expect(ToolSelection.relevant("generate_image", { agent: "research", message })).toBe(true)
  })

  test("does not add stale checklist ceremony to a long autonomous research request", () => {
    const message =
      "Autonomously execute a comprehensive, multi-step protein analysis and deliver a publication-quality report with figures, uncertainty, and validation."
    expect(ToolSelection.relevant("todowrite", { agent: "research", message })).toBe(false)
    expect(ToolSelection.relevant("todoread", { agent: "research", message })).toBe(false)
    expect(
      ToolSelection.relevant("todowrite", {
        agent: "research",
        message: `${message} Keep a concise task list while you work.`,
      }),
    ).toBe(true)
  })

  test("keeps normal research relevance filtering for a code-only minimal-profile request", () => {
    const input = {
      agent: ToolSelection.THIN_RESEARCH_AGENT,
      message: "Fix the TypeScript server bug and run its test suite.",
    }
    expect(ToolSelection.relevant("bash", input)).toBe(true)
    expect(ToolSelection.relevant("research_contract", input)).toBe(false)
    expect(ToolSelection.relevant("compute_job", input)).toBe(false)
  })
})

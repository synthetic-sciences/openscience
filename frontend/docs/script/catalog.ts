import path from "node:path"
import { registry } from "../../../backend/cli/src/science/connectors"
import { capabilityManifests } from "../../../backend/cli/src/science/capability/manifests"
import { coreManifests } from "../../../backend/cli/src/science/capability/manifests/core"
import { bioNemoManifests } from "../../../backend/cli/src/science/capability/manifests/bionemo"
import { MANAGED_OPENROUTER_MODELS, MANAGED_MODEL_DETAILS } from "../../../backend/cli/src/provider/managed-catalog"

const root = path.resolve(import.meta.dir, "../../..")
const content = path.join(root, "frontend/docs/src/content/openscience")
const skills = path.join(root, "backend/cli/skills")
const check = Bun.argv.includes("--check")
const groups = new Map<string, Array<{ name: string; file: string; description: string }>>()
const labels: Record<string, string> = {
  biology: "Biology",
  chemistry: "Chemistry",
  physics: "Physics",
  quantum: "Quantum science",
  research: "Research methods",
  writing: "Writing",
  visualization: "Visualization",
  "ml-training": "Machine learning training",
  "ml-inference": "Machine learning inference",
  "data-engineering": "Data engineering",
  "cloud-compute": "Compute workflows",
  coding: "Coding",
  databases: "Databases",
  "llm-tools": "Language model tools",
  other: "Other workflows",
  general: "General",
}

for (const file of Array.from(new Bun.Glob("**/SKILL.md").scanSync({ cwd: skills })).sort()) {
  const source = await Bun.file(path.join(skills, file)).text()
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ""
  const metadata = Bun.YAML.parse(frontmatter) as Record<string, unknown>
  const field = (key: string) => (typeof metadata[key] === "string" ? (metadata[key] as string) : undefined)
  const name = field("name") ?? path.basename(path.dirname(file))
  const category = field("category") ?? "general"
  const entries = groups.get(category) ?? []
  entries.push({ name, file, description: field("description") ?? "Read the linked instructions for this procedure." })
  groups.set(category, entries)
}

const descriptions: Record<string, string> = {
  "givemeanode-agent-compute":
    "Use a connected GiveMeANode service for GPU work, jobs, and storage with explicit resource limits.",
  "fireworks-ai-inference": "Use your Fireworks account for supported inference and fine-tuning workflows.",
  "together-ai-inference": "Use your Together account for supported inference, embeddings, and fine-tuning workflows.",
  stop: "Stop active work in the current conversation and check the state of ongoing jobs.",
  "serving-llms-vllm":
    "Serve language models with vLLM and investigate memory, throughput, and inference configuration.",
  "groq-inference": "Use your Groq account for supported inference and audio workflows.",
  whisper: "Transcribe speech, identify language, or translate speech to English with available Whisper models.",
  "generate-image":
    "Generate illustrations, graphical abstracts and image edits with generate_image through Ace or a Gemini or OpenAI key.",
  clip: "Work on image-text matching, image classification, and related vision-language tasks.",
  langchain: "Build language-model applications with retrieval, tools, and connected services.",
  infographics: "Create and review explanatory infographics; this procedure is experimental.",
  "research-workflows": "Plan, review, verify, reproduce, compare, audit sources, and package scientific work.",
  "research-lookup": "Find current research and technical references with configured search access and citations.",
  "perplexity-search": "Search for current information and source-backed answers using your configured search access.",
}
const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ")
const summary = (name: string, value: string) => {
  const text = (descriptions[name] ?? value).replace(/\s+/g, " ").trim()
  const first = text.match(/^.*?[.!?](?:\s|$)/)?.[0]?.trim() ?? text
  return first.length <= 260 ? first : first.slice(0, 257).replace(/\s+\S*$/, "") + "…"
}
const total = Array.from(groups.values()).reduce((sum, entries) => sum + entries.length, 0)
const library = [
  "---",
  'title: "Skill directory"',
  'description: "Browse the research procedures included with this documentation version."',
  "---",
  "",
  "OpenScience includes " +
    total +
    " skill files in this version. This directory is generated from the bundled library. Each entry describes the procedure and links to its full usage instructions and supporting files on GitHub.",
  "",
  "Use **Customize → Skills** or `openscience skill list --all` for the library available in your installed version. A listed skill is a procedure, not a claim that all of its software, data, or services are installed.",
  "",
  "## How to use any entry",
  "",
  "Find the skill by name in **Customize → Skills**, enable it, then select it through the conversation's `/` picker or ask OpenScience to use it. Give the actual input path, expected output, and checks. Open the linked instructions for prerequisites and detailed usage.",
  "",
  'For example: "Use peer-review on drafts/paper.md. Save prioritized findings with source sections and proposed checks in results/review.md."',
  "",
  "See [Skills](/openscience/skills) for installation and authoring, and [Skill recipes](/openscience/skill-workflows) for complete example requests. The summaries below describe skill instructions, not a guarantee of installed software, account access, or current third-party product terms.",
  "",
  "## Where the skills come from",
  "",
  "Most of these skills were written by other people and adapted for OpenScience's tools: [Scientific Agent Skills](https://github.com/K-Dense-AI/scientific-agent-skills) and [Claude Scientific Writer](https://github.com/K-Dense-AI/claude-scientific-writer) by K-Dense Inc. (MIT), [AI Research Skills](https://github.com/Orchestra-Research/AI-Research-SKILLs) by Orchestra Research (MIT), [Hugging Face skills](https://github.com/huggingface/skills) (Apache-2.0), Anthropic's document skills, and the [NVIDIA BioNeMo Agent Toolkit](https://github.com/NVIDIA-BioNeMo/bionemo-agent-toolkit). Each skill's frontmatter names its original author, and [ATTRIBUTION.md](https://github.com/synthetic-sciences/openscience/blob/main/backend/cli/skills/ATTRIBUTION.md) lists every derived skill with its upstream path and license. If a K-Dense skill contributes to published work, cite [Kassis et al. (2026)](https://arxiv.org/abs/2609.00065).",
  "",
  ...Array.from(groups.entries())
    .sort(([a], [b]) => (labels[a] ?? a).localeCompare(labels[b] ?? b))
    .flatMap(([category, entries]) => [
      "## " + (labels[category] ?? category),
      "",
      "| Skill and usage instructions | What the procedure covers |",
      "| --- | --- |",
      ...entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(
          (entry) =>
            "| [" +
            entry.name.replaceAll("[", "\\[").replaceAll("]", "\\]") +
            "](https://github.com/synthetic-sciences/openscience/blob/main/backend/cli/skills/" +
            entry.file.split("/").map(encodeURIComponent).join("/") +
            ") | " +
            cell(summary(entry.name, entry.description)) +
            " |",
        ),
      "",
    ]),
].join("\n")

const domains = new Map<string, ReturnType<typeof registry.catalog>>()
for (const entry of registry.catalog()) {
  const entries = domains.get(entry.domain) ?? []
  entries.push(entry)
  domains.set(entry.domain, entries)
}
const databases = [
  "---",
  'title: "Scientific databases"',
  'description: "Find the scientific records and literature sources available to the agent."',
  "---",
  "",
  "The built-in directory contains " +
    registry.catalog().length +
    " database connectors in this version. Ask OpenScience to search a named database or retrieve a record by its identifier.",
  "",
  'For example: "Find the UniProt record for human BRCA1, report its accession, and link the source." Include the organism, reference assembly, or identifier version when it matters.',
  "",
  "Public records may be accessible without a key, but availability, rate limits, licensing, and full-text access depend on the source. Some databases require credentials or a local dataset. A missing result is not proof that a record does not exist.",
  "",
  "These are built-in database connections. Use [Connectors and MCP](/openscience/connectors) for external tool servers, [Skills](/openscience/skills) for procedures, and [Literature reviews](/openscience/literature-review) for a review workflow.",
  "",
  ...Array.from(domains.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .flatMap(([domain, entries]) => [
      "## " + domain.charAt(0).toUpperCase() + domain.slice(1),
      "",
      "| Source and documentation | Identifier | Records and uses | Declared formats |",
      "| --- | --- | --- | --- |",
      ...entries
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(
          (entry) =>
            "| " +
            (entry.homepage ? "[" + entry.name + "](" + entry.homepage + ")" : entry.name) +
            " | `" +
            entry.id +
            "` | " +
            cell(entry.description) +
            " | " +
            (entry.formats?.length
              ? entry.formats.map((format) => "`" + format + "`").join(", ")
              : "Structured record") +
            " |",
        ),
      "",
    ]),
  "## How to search and fetch",
  "",
  "Choose a source above and ask for a bounded query. Select an identifier from the results, then request a structured record or one of that source's declared formats. See [Database workflows](/openscience/database-workflows) for complete examples, output checks, and source-error handling.",
  "",
  "## Check source records",
  "",
  "Ask for the exact accession, DOI, or source URL and the retrieval date. Confirm whether a result is a record, abstract, full text, prediction, or experimental observation before citing it.",
  "",
  "If access fails, narrow the query, check identifiers, and inspect the reported source error. Do not replace a missing record with an uncited guess.",
  "",
].join("\n")

const scientific = Object.values(capabilityManifests)
const categories = [...new Set(scientific.map((entry) => entry.category))].sort()
const toolSummary = (value: string) => value.replace(/^Hosted /, "").replace(/ through NVIDIA's .*$/, ".")
const toolUse = (id: string, blocked: boolean) => {
  if (blocked)
    return "Unavailable in this catalog. Review prerequisites in the linked source; choose another supported tool."
  if (id in coreManifests)
    return "Check readiness in Tools, follow setup, and request a small validated calculation. [Setup guide](/openscience/scientific-tools)."
  if (id in bioNemoManifests)
    return "An NVIDIA BioNeMo NIM. Connect your NVIDIA API key, check accepted inputs and cost, then try a small case. [Connection guide](/openscience/service-credentials) · [BioNeMo Agent Toolkit](https://github.com/NVIDIA-BioNeMo/bionemo-agent-toolkit)."
  return "Reference entry: this release does not install or execute it through Tools. Follow the linked source for your own setup and use compatible skills or scripts."
}
const catalog = [
  "---",
  'title: "Scientific tool catalog"',
  'description: "Every scientific catalog entry, with a purpose, documentation link, and setup or availability details."',
  "---",
  "",
  "This version lists " +
    scientific.length +
    " scientific capabilities. The catalog includes supported local setup paths, connected scientific tools, reference entries, and unavailable entries. These are different levels of support; the list is not a count of ready-to-run tools.",
  "",
  "## Start with availability",
  "",
  "Open **Customize → Tools** and search the name. Check readiness, follow a supported setup or connection action, and validate a small known input before a larger run. The supported integrations remain experimental in this catalog; inspect the current app status and output checks.",
  "",
  'Try: "Check whether RDKit is ready. If it is, validate the SMILES in data/molecules.csv and save molecular weights, invalid records, and the script in the project."',
  "",
  "For reference entries, the source link explains the underlying software. Use a separately configured environment or an appropriate skill if you choose to work with it; a reference entry alone does not make it available to the agent.",
  "",
  "## Find a tool",
  "",
  ...categories.map(
    (category) =>
      "- **" +
      category.replaceAll("_", " ") +
      ":** " +
      scientific
        .filter((entry) => entry.category === category)
        .sort((a, b) => a.name.localeCompare(b.name))
        .map(
          (entry) =>
            "[" +
            entry.name +
            "](#" +
            entry.name
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-|-$/g, "") +
            ")",
        )
        .join(" · "),
  ),
  "",
  ...categories.flatMap((category) => [
    "## " + category.replaceAll("_", " ").replace(/^./, (value) => value.toUpperCase()),
    "",
    ...scientific
      .filter((entry) => entry.category === category)
      .sort((a, b) => a.name.localeCompare(b.name))
      .flatMap((entry) => [
        "### " + entry.name,
        "",
        toolSummary(entry.summary),
        "",
        "**How to use:** " + toolUse(entry.id, entry.maturity === "blocked"),
        "",
        "[Documentation and source](" + entry.source.reference + ") · Catalog identifier: `" + entry.id + "`",
        "",
      ]),
  ]),
  "## Related tools",
  "",
  "Use [Built-in research tools](/openscience/built-in-tools) for file operations, Python, R, search, and jobs. Use [Scientific databases](/openscience/databases) for records, [Scientific viewers](/openscience/scientific-viewers) to inspect data, and the [Skill directory](/openscience/skill-library) for research procedures.",
  "",
].join("\n")

const models = [
  "---",
  'title: "Ace model directory"',
  'description: "Browse the reviewed managed model identities and token limits shipped with this documentation version."',
  "---",
  "",
  "This directory is generated from the reviewed Ace roster shipped with OpenScience. It contains " +
    MANAGED_OPENROUTER_MODELS.length +
    " chat models. Live account access, route availability, pricing, and supported controls still come from the managed service. A listed model is not a guarantee that it is available to your account at this moment.",
  "",
  "## Choose and verify a model",
  "",
  "Open **Customize → Models → Rates and limits**, or use the conversation model picker. Confirm the funding label, selected speed, context option, and current rates. Copy an exact CLI identifier from `openscience models --flat`; service model IDs in the table below are not complete CLI provider/model selections.",
  "",
  "Context and maximum output are token limits, not a promise that both can be used at their maximum simultaneously. Runtime metadata and the selected route may constrain them further. A pricing threshold can differ from the context window. GPT-6 models also have a reviewed maximum input of 922,000 tokens.",
  "",
  "## Reviewed chat roster",
  "",
  "| Model | Service model ID | Context tokens | Maximum output tokens |",
  "| --- | --- | ---: | ---: |",
  ...MANAGED_OPENROUTER_MODELS.map((id) => {
    const model = MANAGED_MODEL_DETAILS[id]
    return (
      "| " +
      model.name +
      " | `" +
      id +
      "` | " +
      model.context.toLocaleString("en-US") +
      " | " +
      model.output.toLocaleString("en-US") +
      " |"
    )
  }),
  "",
  "Gemini 4 Argon uses the backend Gemini route with Low, Medium and High reasoning (Medium by default). Ace currently limits synchronous output to the deployed key’s verified 32,768 tokens. It appears only after the managed service explicitly confirms availability.",
  "",
  "## Effort and Fast mode",
  "",
  "Supported effort choices vary by model and connection. GPT-6 Astra, Claude Opus 5.5, and Claude Fable 5.1 expose Low through Max; Sol and Luna also support a no-reasoning option. The picker is authoritative for the route you selected. Research effort (Normal or Ultra) and worker delegation are separate controls from model reasoning effort.",
  "",
  "Ace Fast for the GPT-6 family uses its separately verified priority route and pricing. Claude and Gemini do not offer Ace Fast. Fast only appears after route metadata confirms support; Refresh options reloads metadata without sending a paid inference request.",
  "",
  "## Images and retired models",
  "",
  "The managed image route is Nano Banana Pro, documented in [Image generation](/openscience/image-generation). Selecting a chat model does not replace the image tool's separate route, requirements, or billing.",
  "",
  "Existing conversations retain their saved model identities. If a prior model is unavailable, select a current model before continuing. Your own provider can expose a different roster; do not infer Ace availability from a provider-key catalog.",
  "",
  "See [Ace and your account](/openscience/ace) for hosting and funding, [Models and providers](/openscience/models) for selection and reasoning, [Pricing](/openscience/pricing) for Wallet rates, and [Usage reports](/openscience/usage) for actual activity.",
  "",
].join("\n")

for (const [name, source] of [
  ["skill-library.mdx", library],
  ["databases.mdx", databases],
  ["tool-catalog.mdx", catalog],
  ["ace-models.mdx", models],
]) {
  const file = Bun.file(path.join(content, name))
  if (check) {
    if (!(await file.exists()) || (await file.text()) !== source)
      throw new Error(name + " is stale. Run bun run --cwd frontend/docs catalog.")
  } else await Bun.write(file, source)
}
console.log(
  check
    ? "Documentation catalogs are current."
    : "Generated " +
        total +
        " skills and " +
        registry.catalog().length +
        " databases, and " +
        scientific.length +
        " scientific capabilities, and " +
        MANAGED_OPENROUTER_MODELS.length +
        " Ace models.",
)

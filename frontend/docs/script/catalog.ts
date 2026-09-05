import path from "node:path"
import { registry } from "../../../backend/cli/src/science/connectors"

const root = path.resolve(import.meta.dir, "../../..")
const content = path.join(root, "frontend/docs/src/content/openscience")
const skills = path.join(root, "backend/cli/skills")
const check = Bun.argv.includes("--check")
const groups = new Map<string, Array<{ name: string; file: string }>>()
const labels: Record<string, string> = {
  biology: "Biology", chemistry: "Chemistry", physics: "Physics", quantum: "Quantum science",
  research: "Research methods", writing: "Writing", visualization: "Visualization",
  "ml-training": "Machine learning training", "ml-inference": "Machine learning inference",
  "data-engineering": "Data engineering", "cloud-compute": "Compute workflows",
  coding: "Coding", databases: "Databases", "llm-tools": "Language model tools",
  other: "Other workflows", general: "General",
}

for (const file of Array.from(new Bun.Glob("**/SKILL.md").scanSync({ cwd: skills })).sort()) {
  const source = await Bun.file(path.join(skills, file)).text()
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1] ?? ""
  const field = (key: string) => frontmatter.match(new RegExp("^" + key + ":\\s*(.+)$", "m"))?.[1].trim().replace(/^["']|["']$/g, "")
  const name = field("name") ?? path.basename(path.dirname(file))
  const category = field("category") ?? "general"
  const entries = groups.get(category) ?? []
  entries.push({ name, file })
  groups.set(category, entries)
}

const total = Array.from(groups.values()).reduce((sum, entries) => sum + entries.length, 0)
const library = [
  "---",
  'title: "Skill directory"',
  'description: "Browse the research procedures included with this documentation version."',
  "---",
  "",
  "OpenScience includes " + total + " skill files in this version. This directory is generated from the bundled library. Names link to their instructions and supporting files on GitHub.",
  "",
  "Use **Customize → Skills** or `openscience skill list --all` for the library available in your installed version. A listed skill is a procedure, not a claim that all of its software, data, or services are installed.",
  "",
  "See [Skills](/openscience/skills) to enable, install, or write a skill.",
  "",
  ...Array.from(groups.entries()).sort(([a], [b]) => (labels[a] ?? a).localeCompare(labels[b] ?? b)).flatMap(([category, entries]) => [
    "## " + (labels[category] ?? category),
    "",
    ...entries.sort((a, b) => a.name.localeCompare(b.name)).map((entry) =>
      "- [" + entry.name.replaceAll("[", "\\[").replaceAll("]", "\\]") + "](https://github.com/synthetic-sciences/openscience/blob/main/backend/cli/skills/" +
      entry.file.split("/").map(encodeURIComponent).join("/") + ")"),
    "",
  ]),
].join("\n")

const domains = new Map<string, ReturnType<typeof registry.catalog>>()
for (const entry of registry.catalog()) {
  const entries = domains.get(entry.domain) ?? []
  entries.push(entry)
  domains.set(entry.domain, entries)
}
const cell = (text: string) => text.replaceAll("|", "\\|").replaceAll("\n", " ")
const databases = [
  "---",
  'title: "Scientific databases"',
  'description: "Find the scientific records and literature sources available to the agent."',
  "---",
  "",
  "The built-in directory contains " + registry.catalog().length + " database connectors in this version. Ask OpenScience to search a named database or retrieve a record by its identifier.",
  "",
  'For example: "Find the UniProt record for human BRCA1, report its accession, and link the source." Include the organism, reference assembly, or identifier version when it matters.',
  "",
  "Public records may be accessible without a key, but availability, rate limits, licensing, and full-text access depend on the source. Some databases require credentials or a local dataset. A missing result is not proof that a record does not exist.",
  "",
  "These are built-in database connections. Use [Connectors and MCP](/openscience/connectors) for external tool servers, [Skills](/openscience/skills) for procedures, and [Literature reviews](/openscience/literature-review) for a review workflow.",
  "",
  ...Array.from(domains.entries()).sort(([a], [b]) => a.localeCompare(b)).flatMap(([domain, entries]) => [
    "## " + domain.charAt(0).toUpperCase() + domain.slice(1),
    "",
    "| Source | Identifier | Records and uses |",
    "| --- | --- | --- |",
    ...entries.sort((a, b) => a.name.localeCompare(b.name)).map((entry) =>
      "| " + (entry.homepage ? "[" + entry.name + "](" + entry.homepage + ")" : entry.name) +
      " | `" + entry.id + "` | " + cell(entry.description) + " |"),
    "",
  ]),
  "## Check source records",
  "",
  "Ask for the exact accession, DOI, or source URL and the retrieval date. Confirm whether a result is a record, abstract, full text, prediction, or experimental observation before citing it.",
  "",
  "If access fails, narrow the query, check identifiers, and inspect the reported source error. Do not replace a missing record with an uncited guess.",
  "",
].join("\n")

for (const [name, source] of [["skill-library.mdx", library], ["databases.mdx", databases]]) {
  const file = Bun.file(path.join(content, name))
  if (check) {
    if (!(await file.exists()) || (await file.text()) !== source) throw new Error(name + " is stale. Run bun run --cwd frontend/docs catalog.")
  } else await Bun.write(file, source)
}
console.log(check ? "Documentation catalogs are current." : "Generated " + total + " skills and " + registry.catalog().length + " database entries.")


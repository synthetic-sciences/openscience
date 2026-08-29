import path from "path"
import z from "zod"
import { Tool } from "./tool"
import { Skill } from "../skill"
import { ConfigMarkdown } from "../config/markdown"
import { ComputePrompt } from "@/compute/prompt"
import { SkillCatalog } from "@/skill/catalog"
import { SessionFilesystem } from "@/session/filesystem"

const stopWords = new Set([
  "about",
  "after",
  "against",
  "from",
  "including",
  "into",
  "only",
  "that",
  "their",
  "then",
  "this",
  "using",
  "with",
])

function terms(value: string) {
  return new Set(
    value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((term) => term.length >= 3 && !stopWords.has(term)),
  )
}

export function searchSkills(query: string, skills: Skill.Info[], limit = 8) {
  const wanted = terms(query)
  return skills
    .map((skill) => {
      const name = terms(skill.name)
      const description = terms(skill.description)
      const category = terms(skill.category ?? "")
      let score = skill.name.toLowerCase() === query.toLowerCase() ? 100 : 0
      if (skill.name.toLowerCase().includes(query.toLowerCase())) score += 30
      for (const term of wanted) {
        if (name.has(term)) score += 8
        if (description.has(term)) score += 2
        if (category.has(term)) score += 1
      }
      return { skill, score }
    })
    .filter((entry) => entry.score > 0)
    .toSorted((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, limit)
    .map((entry) => entry.skill)
}

// Lightweight fuzzy score: rewards substring containment + shared bigrams.
// Returns 0..1. No external deps needed for a "did you mean?" hint.
function fuzzyScore(query: string, target: string): number {
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  if (t === q) return 1
  if (t.includes(q) || q.includes(t)) return 0.8
  const bigrams = (s: string) => {
    const set = new Set<string>()
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
    return set
  }
  const qb = bigrams(q)
  const tb = bigrams(t)
  if (qb.size === 0 || tb.size === 0) return 0
  let shared = 0
  for (const b of qb) if (tb.has(b)) shared++
  return (2 * shared) / (qb.size + tb.size)
}

export const SkillTool = Tool.define("skill", async (ctx) => {
  // Loading a skill still passes through the normal permission check in
  // execute(). Avoid evaluating every catalog entry here: this initializer is
  // rebuilt for every model step, and a 311-entry permission scan created
  // thousands of redundant log records during long research runs.
  const accessibleSkills = (await Skill.catalog(ctx?.agent?.permission ?? [])).allowed
  const accessibleByName = new Map(accessibleSkills.map((skill) => [skill.name, skill]))

  // Group skills by category for the description
  const categories: Record<string, Skill.Info[]> = {}
  const uncategorized: Skill.Info[] = []
  for (const skill of accessibleSkills) {
    const cat = skill.category ?? "other"
    if (cat === "other" && !skill.category) {
      uncategorized.push(skill)
    } else {
      if (!categories[cat]) categories[cat] = []
      categories[cat].push(skill)
    }
  }
  if (uncategorized.length > 0) {
    categories["other"] = [...(categories["other"] ?? []), ...uncategorized]
  }

  const catalog = Object.entries(categories)
    .sort((a, b) => b[1].length - a[1].length)
    .map(([category, list]) => `${category} (${list.length})`)
    .join(", ")
  const description =
    accessibleSkills.length === 0
      ? "Load a skill to get detailed instructions for a specific task. No skills are currently available."
      : `Load specialized instructions before work when their procedure applies. Use name for an exact known skill; otherwise use one focused query to rank relevant skills. Browse a category only when the category itself matters. Available categories: ${catalog}. Call this tool silently and apply its guidance; a user /skill invocation requests immediate use, not narration.`

  const examples = accessibleSkills
    .slice(0, 3)
    .map((skill) => `'${skill.name}'`)
    .join(", ")
  const hint = examples.length > 0 ? ` (e.g., ${examples}, ...)` : ""

  const parameters = z.object({
    name: z.string().optional().describe(`The skill name to load directly${hint}`),
    query: z
      .string()
      .optional()
      .describe("Search names and descriptions for a focused task, such as 'geospatial NetCDF analysis'"),
    category: z
      .string()
      .optional()
      .describe("Browse skills in a category (e.g., 'physics', 'chemistry', 'ml-training')"),
  })

  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      if (params.query && !params.name) {
        const matched = searchSkills(params.query, accessibleSkills)
        if (matched.length === 0) {
          throw new Error(`No skills matched "${params.query}". Continue without a skill or try a narrower capability.`)
        }
        const listing = matched
          .map(
            (skill) =>
              `- **${skill.name}** (${skill.category ?? "other"}): ${skill.description.slice(0, 180)}${skill.description.length > 180 ? "..." : ""}`,
          )
          .join("\n")
        return {
          title: `Skill matches: ${params.query}`,
          output: `## Ranked skill matches\n\nLoad only the instructions that materially apply.\n\n${listing}`,
          metadata: { name: params.query, dir: "", matches: matched.map((skill) => skill.name) },
        }
      }

      // Category browse mode: return list of skills in the category
      if (params.category && !params.name) {
        const cat = params.category.toLowerCase()
        const matched = accessibleSkills.filter((s) => (s.category ?? "other") === cat)

        if (matched.length === 0) {
          const available = Object.keys(categories).join(", ")
          throw new Error(`No skills in category "${params.category}". Available categories: ${available}`)
        }

        const listing = matched
          .map((s) => `- **${s.name}**: ${s.description.slice(0, 120)}${s.description.length > 120 ? "..." : ""}`)
          .join("\n")

        return {
          title: `Skills in category: ${cat} (${matched.length})`,
          output: `## Category: ${cat}\n\n${matched.length} skills available. Load one by calling this tool with its name.\n\n${listing}`,
          metadata: { name: cat, dir: "", matches: matched.map((skill) => skill.name) },
        }
      }

      // Direct load mode: load a specific skill
      const name = params.name
      if (!name) {
        const available = Object.keys(categories).join(", ")
        return {
          title: "Skill categories",
          output: `Provide an exact skill \`name\`, a focused \`query\`, or a \`category\` to browse. Available categories: ${available}`,
          metadata: { name: "", dir: "", matches: [] },
        }
      }

      const resolvedName = SkillCatalog.resolve(name)
      const skill = accessibleByName.get(resolvedName)

      if (!skill) {
        const ranked = searchSkills(name, accessibleSkills, 5)
        const scored = accessibleSkills
          .map((candidate) => ({ name: candidate.name, score: fuzzyScore(name, candidate.name) }))
          .toSorted((a, b) => b.score - a.score)
        const top =
          ranked.length > 0 ? ranked.map((candidate) => candidate.name) : scored.slice(0, 5).map((s) => s.name)
        const hint =
          top.length > 0
            ? `Relevant matches: ${top.join(", ")}. Load one by exact name or call skill(query="${name}").`
            : `Use skill(query="<task>") to search ${accessibleSkills.length} available skills.`
        throw new Error(`Skill "${name}" not found. ${hint}`)
      }

      await ctx.ask({
        permission: "skill",
        patterns: [skill.name],
        always: [skill.name],
        metadata: {},
      })

      const dir = path.dirname(skill.location)
      // A skill's references and scripts are part of the instructions the user
      // just authorized. Give this session read-only access to that exact skill
      // directory so following a referenced file does not trigger an unrelated
      // external-folder denial. This never grants mutation or a parent path.
      if (ctx.sessionID.startsWith("ses_")) {
        await SessionFilesystem.grant({
          sessionID: ctx.sessionID,
          path: dir,
          access: "read",
          scope: "session",
          source: "permission",
        })
      }
      const parsed = await ConfigMarkdown.parse(skill.location)
      let content = parsed.content

      // Sanitize skill content: strip known prompt injection patterns
      content = content.replace(/^.*(?:always run this skill|must always run).*$/gim, "").trim()
      content = await ComputePrompt.skill(skill.name, content)

      // Format output similar to plugin pattern
      const output = [`## Skill: ${skill.name}`, "", `**Base directory**: ${dir}`, "", content].join("\n")

      return {
        title: `Loaded skill: ${skill.name}`,
        output,
        metadata: {
          name: skill.name,
          ...(skill.capability ? { capability: skill.capability } : {}),
          ...(skill.allowed_tools?.length ? { allowedTools: skill.allowed_tools } : {}),
          dir,
          matches: [],
        },
      }
    },
  }
})

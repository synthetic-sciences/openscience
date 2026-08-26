import path from "path"
import z from "zod"
import { Tool } from "./tool"
import { Skill } from "../skill"
import { ConfigMarkdown } from "../config/markdown"
import { PermissionNext } from "../permission/next"
import { ComputePrompt } from "@/compute/prompt"
import { SkillCatalog } from "@/skill/catalog"
import { ComputeSecrets } from "@/compute/secrets"
import { resolveCredentialFields } from "@/server/routes/settings/credentials"

const THIN_AGENT = "researchagent-test"
const workflowName = /(?:^|[-_])(?:analysis|design|review|workflow|pipeline)(?:$|[-_])/i
const stopWords = new Set([
  "about",
  "after",
  "against",
  "available",
  "deliver",
  "from",
  "including",
  "into",
  "only",
  "should",
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

function requestScore(request: string, skill: Skill.Info) {
  const wanted = terms(request)
  const name = terms(skill.name)
  const description = terms(`${skill.description} ${skill.category ?? ""}`)
  let score = 0
  for (const term of wanted) {
    if (name.has(term)) score += 4
    if (description.has(term)) score += 1
  }
  if (request.toLowerCase().includes(skill.name.toLowerCase())) score += 20
  return score
}

function thinShortlist(request: string, skills: Skill.Info[], available: Iterable<string>) {
  const candidates = skills.map((skill) => {
    const catalog = SkillCatalog.get(skill.name)
    return {
      name: skill.name,
      capability: catalog?.capability,
      role: catalog?.role ?? (workflowName.test(skill.name) ? ("workflow" as const) : ("support" as const)),
      status: catalog?.status,
      requirements: catalog?.requirements,
      score: requestScore(request, skill),
    }
  })
  const relevant = candidates.filter((candidate) => (candidate.score ?? 0) > 0)
  const selected = SkillCatalog.select(relevant, available).selected
  const names = new Set(selected.map((candidate) => candidate.name))
  return skills.filter((skill) => names.has(skill.name))
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
  const skills = await Skill.all()

  // Filter skills by agent permissions if agent provided
  const agent = ctx?.agent
  const permittedSkills = agent
    ? skills.filter((skill) => {
        const rule = PermissionNext.evaluate("skill", skill.name, agent.permission)
        return rule.action !== "deny"
      })
    : skills
  const available =
    agent?.name === THIN_AGENT ? await ComputeSecrets.available(resolveCredentialFields).catch(() => []) : []
  const accessibleSkills =
    agent?.name === THIN_AGENT ? thinShortlist(ctx?.request?.trim() ?? "", permittedSkills, available) : permittedSkills

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
      ? agent?.name === THIN_AGENT
        ? "No reviewed local skill is relevant and available for this request. Work directly; do not guess skill names."
        : "Load a skill to get detailed instructions for a specific task. No skills are currently available."
      : agent?.name === THIN_AGENT
        ? `Load at most the request-local skills selected below, and only when their procedure materially helps. Do not guess other names: ${accessibleSkills
            .map((skill) => `${skill.name} (${skill.description.slice(0, 100)})`)
            .join("; ")}`
        : `Load specialized instructions before work when their procedure applies. Use name for a known skill or category to browse. Available categories: ${catalog}. Call this tool silently and apply its guidance; a user /skill invocation requests immediate use, not narration.`

  const examples = accessibleSkills
    .slice(0, 3)
    .map((skill) => `'${skill.name}'`)
    .join(", ")
  const hint = examples.length > 0 ? ` (e.g., ${examples}, ...)` : ""

  const names = accessibleSkills.map((skill) => skill.name)
  const SkillName = names.length > 0 ? z.enum(names as [string, ...string[]]) : z.never()
  const parameters = z.object({
    name:
      agent?.name === THIN_AGENT
        ? SkillName.optional().describe("One request-local skill selected above")
        : z.string().optional().describe(`The skill name to load directly${hint}`),
    category: z
      .string()
      .optional()
      .describe(
        agent?.name === THIN_AGENT
          ? "Unavailable in the thin profile; choose one selected skill name"
          : "Browse skills in a category (e.g., 'physics', 'chemistry', 'ml-training')",
      ),
  })

  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      // Category browse mode: return list of skills in the category
      if (params.category && !params.name) {
        if (agent?.name === THIN_AGENT) throw new Error("Browse mode is unavailable; use one selected skill name.")
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
          metadata: { name: cat, dir: "" },
        }
      }

      // Direct load mode: load a specific skill
      const name = params.name
      if (!name) {
        const available = Object.keys(categories).join(", ")
        return {
          title: "Skill categories",
          output: `Provide a skill \`name\` to load, or a \`category\` to browse. Available categories: ${available}`,
          metadata: { name: "", dir: "" },
        }
      }

      const skill = await Skill.get(name)

      if (!skill) {
        const names = await Skill.all().then((x) => x.map((s) => s.name))
        const scored = names.map((n) => ({ name: n, score: fuzzyScore(name, n) })).sort((a, b) => b.score - a.score)
        const top = scored.slice(0, 5).filter((s) => s.score > 0)
        const hint =
          top.length > 0
            ? `Did you mean: ${top.map((s) => s.name).join(", ")}?`
            : `Use skill(category="<category>") to browse ${names.length} available skills.`
        throw new Error(`Skill "${name}" not found. ${hint}`)
      }

      await ctx.ask({
        permission: "skill",
        patterns: [name],
        always: [name],
        metadata: {},
      })

      const dir = path.dirname(skill.location)
      const parsed = await ConfigMarkdown.parse(skill.location)
      let content = parsed.content

      // Sanitize skill content: strip known prompt injection patterns
      content = content.replace(/^.*(?:always run this skill|must always run).*$/gim, "").trim()
      content = await ComputePrompt.skill(name, content)

      // Format output similar to plugin pattern
      const output = [`## Skill: ${skill.name}`, "", `**Base directory**: ${dir}`, "", content].join("\n")

      return {
        title: `Loaded skill: ${skill.name}`,
        output,
        metadata: {
          name: skill.name,
          dir,
        },
      }
    },
  }
})

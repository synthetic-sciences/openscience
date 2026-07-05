import path from "path"
import fs from "fs/promises"
import z from "zod"
import { Tool } from "./tool"
import { Skill } from "../skill"
import { ConfigMarkdown } from "../config/markdown"
import { PermissionNext } from "../permission/next"
import { OpenScience } from "@/openscience"
import { RSILifecycle } from "@/session/rsi/lifecycle"
import { Global } from "@/global"

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
  const accessibleSkills = agent
    ? skills.filter((skill) => {
        const rule = PermissionNext.evaluate("skill", skill.name, agent.permission)
        return rule.action !== "deny"
      })
    : skills

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

  const description =
    accessibleSkills.length === 0
      ? "Load a skill to get detailed instructions for a specific task. No skills are currently available."
      : [
          "Load a skill by name for expert-level instructions, code examples, and troubleshooting guidance.",
          "Load skills BEFORE starting work — they contain critical setup steps, common pitfalls, and production-ready patterns.",
          "Use `name` to load a specific skill directly, or `category` to browse available skills in a domain.",
          "",
          "INVOCATION ETIQUETTE: Call this tool silently. Do NOT preface the call with messages like 'Let me load the X skill' or 'I'll consult the X skill first'. The tool call is internal — emit your first user-visible message AFTER the skill content is loaded, using the loaded guidance directly. If the user typed `/<skill-name>` to invoke a skill, treat it as a request to act on that skill's instructions immediately, not as a request to narrate the load.",
          "",
          "<skill_categories>",
          ...Object.entries(categories)
            .sort((a, b) => b[1].length - a[1].length)
            .map(([cat, list]) => {
              const examples = list
                .slice(0, 3)
                .map((s) => s.name)
                .join(", ")
              return `  <category name="${cat}" count="${list.length}">${examples}, ...</category>`
            }),
          "</skill_categories>",
        ].join(" ")

  const examples = accessibleSkills
    .slice(0, 3)
    .map((skill) => `'${skill.name}'`)
    .join(", ")
  const hint = examples.length > 0 ? ` (e.g., ${examples}, ...)` : ""

  const parameters = z.object({
    name: z.string().optional().describe(`The skill name to load directly${hint}`),
    category: z
      .string()
      .optional()
      .describe("Browse skills in a category (e.g., 'physics', 'chemistry', 'ml-training')"),
  })

  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
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

      // Ensure skill content + supporting files are cached locally before reading.
      // Only fetch from API for cached skills — never overwrite local dev skill files.
      const dir = path.dirname(skill.location)
      const isCachedSkill = skill.location.startsWith(Global.Path.cache)
      if (isCachedSkill) {
        const hasContent = await Bun.file(skill.location).exists()
        const hasFiles = await Bun.file(path.join(dir, ".cache-v2")).exists()
        if (!hasContent || !hasFiles) {
          const fetched = await OpenScience.fetchSkillContent(name)
          if (!fetched) {
            if (!hasContent) throw new Error(`Skill "${name}" not available (offline and not cached)`)
          } else {
            // Sanitize before writing to cache: strip injection directives
            let sanitized = fetched
            sanitized = sanitized.replace(/^.*(?:always run this skill|must always run).*$\n?/gim, "")
            await fs.mkdir(dir, { recursive: true })
            await Bun.write(skill.location, sanitized)
          }
        }
      }

      const parsed = await ConfigMarkdown.parse(skill.location)
      let content = parsed.content

      // Track usage for RSI-distilled learned skills
      if (parsed.data?.source === "rsi") {
        RSILifecycle.trackUsage(name).catch(() => {})
      }

      // Sanitize skill content: strip known prompt injection patterns
      content = content.replace(/^.*(?:always run this skill|must always run).*$/gim, "").trim()

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

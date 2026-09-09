import path from "path"
import z from "zod"
import { Tool } from "./tool"
import { Skill } from "../skill"
import { createHash } from "node:crypto"
import { ComputePrompt } from "@/compute/prompt"
import { SkillCatalog } from "@/skill/catalog"
import { SessionFilesystem } from "@/session/filesystem"

import { searchSkills } from "../skill/search"
export { searchSkills } from "../skill/search"

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

// SKILL.md files call sibling skills by their source-tree path
// (`skills/<category>/<dir>/scripts/x.py`, or the older `skills/<dir>/...`
// without the category). Compiled releases materialize the library under a
// digest-named cache directory, so that prefix only resolves from a source
// checkout. Point every reference that names a known skill at that skill's
// real directory; anything else (including `.claude/skills/...` and URLs, which
// carry a `/` before `skills`) is left untouched.
export function resolveSkillPaths(content: string, skills: Iterable<Pick<Skill.Info, "location">>): string {
  const dirs = new Map<string, string>()
  for (const skill of skills) {
    const dir = path.dirname(skill.location)
    dirs.set(path.basename(dir), dir)
    dirs.set(`${path.basename(path.dirname(dir))}/${path.basename(dir)}`, dir)
  }
  if (dirs.size === 0) return content
  const segment = "[A-Za-z0-9_-]+(?:\\.[A-Za-z0-9_-]+)*"
  return content.replace(
    new RegExp(`(?<![\\w./-])skills/(${segment})(?:/(${segment}))?`, "g"),
    (token: string, first: string, second: string | undefined) => {
      const nested = second ? dirs.get(`${first}/${second}`) : undefined
      if (nested) return nested
      const flat = dirs.get(first)
      if (flat) return second ? `${flat}/${second}` : flat
      return token
    },
  )
}

export const SkillTool = Tool.define("skill", async (ctx) => {
  // Loading a skill still passes through the normal permission check in
  // execute(). Avoid evaluating every catalog entry here: this initializer is
  // rebuilt for every model step, and a 311-entry permission scan created
  // thousands of redundant log records during long research runs.
  const ctxPermission = ctx?.agent?.permission ?? []
  const accessibleSkills = (await Skill.catalog(ctxPermission)).allowed

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
      : `Discover or load specialized instructions when their procedure applies. Load with name only when the exact available name is known; do not invent a name from the task. Otherwise omit name and use one focused query, then load an exact name returned by discovery. Search and category results contain metadata, not instructions. If an unknown name accompanies a query, only discovery runs. Browse a category only when the category itself matters. Available categories: ${catalog}. Call this tool silently and apply its guidance; a user /skill invocation requests immediate use, not narration.`

  const parameters = z.object({
    name: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Exact available skill name to load, copied from the available skills or discovery results. Omit to search.",
      ),
    query: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        "Search names, descriptions, tags and capabilities for a focused task, such as 'geospatial NetCDF analysis'",
      ),
    category: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe("Browse a category, or restrict query results to it (e.g., 'physics', 'chemistry', 'ml-training')"),
    offset: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Category browse offset for the next page; ignored when searching or loading"),
  })

  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      // Selection can change after the model saw this tool's description.
      // Re-check before search and direct loading, not only at initialization.
      const accessibleSkills = (await Skill.catalog(ctxPermission)).allowed
      const accessibleByName = new Map(accessibleSkills.map((skill) => [skill.name, skill]))
      const available = [...new Set(accessibleSkills.map((skill) => skill.category ?? "other"))].toSorted().join(", ")
      const candidates = params.category
        ? accessibleSkills.filter(
            (skill) => (skill.category ?? "other").toLowerCase() === params.category!.toLowerCase(),
          )
        : accessibleSkills
      const selected = params.name ? accessibleByName.get(SkillCatalog.resolve(params.name)) : undefined
      if (params.query && !selected) {
        const matched = searchSkills(params.query, candidates)
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
          output: `## Ranked skill matches\n\n${params.name ? `Skill "${params.name}" is unavailable. Searched the provided query instead. ` : ""}No skill instructions have been loaded. Load an applicable result by calling this tool with its exact name.\n\n${listing}`,
          metadata: {
            name: params.query,
            dir: "",
            matches: matched.map((skill) => skill.name),
            ...(params.name ? { unavailableName: params.name } : {}),
          },
        }
      }

      // Category browse mode: return list of skills in the category
      if (params.category && !params.name) {
        const cat = params.category.toLowerCase()
        const matched = candidates.slice(params.offset ?? 0, (params.offset ?? 0) + 40)

        if (matched.length === 0) {
          throw new Error(
            `No skills at this offset in category "${params.category}". Available categories: ${available}`,
          )
        }

        const listing = matched
          .map((s) => `- **${s.name}**: ${s.description.slice(0, 120)}${s.description.length > 120 ? "..." : ""}`)
          .join("\n")

        return {
          title: `Skills in category: ${cat} (${candidates.length})`,
          output: `## Category: ${cat}\n\n${candidates.length} skills available. Showing ${matched.length} from offset ${params.offset ?? 0}. Load one by calling this tool with its name.${(params.offset ?? 0) + matched.length < candidates.length ? ` Browse the next page with offset ${(params.offset ?? 0) + matched.length}, or use a focused query.` : ""}\n\n${listing}`,
          metadata: { name: cat, dir: "", matches: matched.map((skill) => skill.name) },
        }
      }

      // Direct load mode: load a specific skill
      const name = params.name
      if (!name) {
        return {
          title: "Skill categories",
          output: `Provide an exact skill \`name\`, a focused \`query\`, or a \`category\` to browse. Available categories: ${available}`,
          metadata: { name: "", dir: "", matches: [] },
        }
      }

      if (!selected) {
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
        patterns: [selected.name],
        always: [selected.name],
        metadata: {},
      })

      ctx.abort.throwIfAborted()
      const current = (await Skill.catalog(ctxPermission)).allowed.find((skill) => skill.name === selected.name)
      if (!current) {
        throw new Error(`Skill "${selected.name}" is no longer active. Enable it in Skills before loading it.`)
      }
      if (current.location !== selected.location || current.origin !== selected.origin) {
        throw new Error(`Skill "${selected.name}" changed while awaiting permission. Select it again.`)
      }
      const loaded = await Skill.load(current)
      const skill = loaded.info
      ctx.abort.throwIfAborted()

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
          source: "skill",
        })
      }
      let content = loaded.content

      // Sanitize skill content: strip known prompt injection patterns
      content = content.replace(/^.*(?:always run this skill|must always run).*$/gim, "").trim()
      // Only same-origin siblings resolve: a project skill directory must not
      // be able to redirect a bundled skill's script invocations to itself.
      const siblings = (await Skill.all({ includeDisabled: true })).filter((entry) => entry.origin === skill.origin)
      content = resolveSkillPaths(content, siblings)
      content = await ComputePrompt.skill(skill.name, content)

      // Format output similar to plugin pattern
      const output = [`## Skill: ${skill.name}`, "", `**Base directory**: ${dir}`, "", content].join("\n")

      return {
        title: `Loaded skill: ${skill.name}`,
        output,
        metadata: {
          name: skill.name,
          origin: skill.origin,
          contentHash: createHash("sha256").update(content).digest("hex"),
          ...(skill.capability ? { capability: skill.capability } : {}),
          ...(skill.allowed_tools?.length ? { allowedTools: skill.allowed_tools } : {}),
          dir,
          matches: [],
        },
      }
    },
  }
})

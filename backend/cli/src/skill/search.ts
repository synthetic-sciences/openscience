import type { Skill } from "./skill"
import { SkillCatalog } from "./catalog"

const stopWords = new Set([
  "about",
  "and",
  "answer",
  "available",
  "concise",
  "final",
  "for",
  "most",
  "outline",
  "relevant",
  "skill",
  "sound",
  "the",
  "use",
  "workflow",
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
      .split(/[^\p{L}\p{N}]+/u)
      .filter((term) => term.length >= 2 && !stopWords.has(term)),
  )
}

export function searchSkills(query: string, skills: Skill.Info[], limit = 8) {
  query = query.trim().toLowerCase()
  if (!query) return []
  const wanted = terms(query)
  const resolved = SkillCatalog.resolve(query)
  return skills
    .map((skill) => {
      const name = terms(skill.name)
      const description = terms(skill.description)
      const category = terms(skill.category ?? "")
      const tags = terms((skill.tags ?? []).join(" "))
      const capability = terms(skill.capability ?? "")
      let score = skill.name.toLowerCase() === resolved ? 100 : 0
      if (skill.name.toLowerCase().includes(query)) score += 30
      for (const term of wanted) {
        if (name.has(term)) score += 8
        if (description.has(term)) score += 2
        if (category.has(term)) score += 1
        if (tags.has(term)) score += 5
        if (capability.has(term)) score += 5
      }
      return { skill, score }
    })
    .filter((entry) => entry.score > 0)
    .toSorted((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, limit)
    .map((entry) => entry.skill)
}

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
  const indexed = skills.map((skill) => ({
    skill,
    fields: [
      { terms: terms(skill.name), weight: 8 },
      { terms: terms(skill.description), weight: 3 },
      { terms: terms(skill.category ?? ""), weight: 2 },
      { terms: terms((skill.tags ?? []).join(" ")), weight: 5 },
      { terms: terms(skill.capability ?? ""), weight: 5 },
    ],
  }))
  const frequency = new Map<string, number>()
  for (const entry of indexed) {
    for (const term of new Set(entry.fields.flatMap((field) => [...field.terms]))) {
      frequency.set(term, (frequency.get(term) ?? 0) + 1)
    }
  }
  return indexed
    .map(({ skill, fields }) => {
      let score = 0
      for (const term of wanted) {
        // Count each term once per skill. Repeating a common word such as
        // "data" across metadata must not swamp a more specific task term.
        const weight = Math.max(...fields.map((field) => (field.terms.has(term) ? field.weight : 0)))
        score += weight * Math.log(1 + skills.length / (1 + (frequency.get(term) ?? 0)))
      }
      const exact = skill.name.toLowerCase() === resolved
      const phrase = skill.name.toLowerCase().includes(query)
      return { skill, score, exact, phrase }
    })
    .filter((entry) => entry.exact || entry.phrase || entry.score > 0)
    .toSorted(
      (a, b) =>
        Number(b.exact) - Number(a.exact) ||
        Number(b.phrase) - Number(a.phrase) ||
        b.score - a.score ||
        a.skill.name.localeCompare(b.skill.name),
    )
    .slice(0, limit)
    .map((entry) => entry.skill)
}

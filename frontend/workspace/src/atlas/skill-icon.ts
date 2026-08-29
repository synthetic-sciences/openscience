import type { IconProps } from "@synsci/ui/icon"

export type SkillIconIdentity = {
  name: string
  description?: string
  category?: string
  tags?: readonly string[]
}

const CATEGORY_ICON: Record<string, IconProps["name"]> = {
  biology: "activity",
  chemistry: "flask",
  physics: "atom",
  quantum: "sparkles",
  "ml-training": "cpu",
  "ml-inference": "models",
  databases: "server",
  "llm-tools": "brain",
  coding: "code",
  writing: "pencil-line",
  research: "magnifying-glass",
  "data-engineering": "braces",
  "cloud-compute": "cloud",
  visualization: "layout-grid",
}

const SKILL_ICON_RULES: Array<{ terms: string[]; icon: IconProps["name"] }> = [
  { terms: ["microscopy", "bioimage", "imaging", "vision", "image"], icon: "photo" },
  { terms: ["clinical", "decision support", "health", "medical"], icon: "checklist" },
  { terms: ["genomic", "genome", "sequence", "biopython", "protein", "gene"], icon: "braces" },
  { terms: ["literature", "citation", "paper", "publication"], icon: "book-open" },
  { terms: ["plot", "chart"], icon: "layout-grid" },
  { terms: ["database", "sql", "registry", "warehouse"], icon: "server" },
  { terms: ["security", "safety", "permission", "audit"], icon: "shield" },
  { terms: ["benchmark", "evaluation", "test", "review"], icon: "checklist" },
  { terms: ["github", "git", "repository"], icon: "github" },
  { terms: ["web", "browser", "scrape", "crawl"], icon: "window-cursor" },
  { terms: ["notebook", "python", "r-language", "shell", "script"], icon: "console" },
  { terms: ["presentation", "slide", "poster"], icon: "layout-grid" },
]

const FALLBACK_ICONS: IconProps["name"][] = ["book-open", "task", "code-lines", "flask", "models", "folder-tree"]

/** One stable icon decision shared by every skill surface. */
export function skillIconFor(skill: SkillIconIdentity): IconProps["name"] {
  const category = skill.category?.trim().toLowerCase()
  const signature = [skill.name, skill.description, ...(skill.tags ?? [])].filter(Boolean).join(" ").toLowerCase()
  const specific = SKILL_ICON_RULES.find((rule) => rule.terms.some((term) => signature.includes(term)))
  if (specific) return specific.icon
  if (category && CATEGORY_ICON[category]) return CATEGORY_ICON[category]

  let hash = 0
  for (const char of category || skill.name) hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  return FALLBACK_ICONS[hash % FALLBACK_ICONS.length]!
}

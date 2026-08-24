import path from "node:path"

export const RETIRED_ATLAS_SKILL_NAMES = [
  "atlas",
  "atlas-auto",
  "atlas-auto-cli",
  "atlas-autoresearch",
  "atlas-cli",
  "atlas-frontier",
  "atlas-lab",
  "atlas-lookahead",
  "atlas-lookahead-cli",
  "atlas-loop",
  "atlas-map",
  "atlas-optimize",
  "atlas-paper",
  "atlas-plan",
  "atlas-prove",
  "atlas-prove-cli",
  "atlas-record",
  "atlas-reproduce",
  "atlas-reproduce-cli",
  "atlas-search",
  "atlas-survey",
  "atlas-survey-cli",
  "atlas-to-graph",
  "atlas-to-graph-cli",
  "atlas-tree",
  "atlas-tree-cli",
] as const

export const RETIRED_PRODUCT_SKILL_NAMES = [
  ...RETIRED_ATLAS_SKILL_NAMES,
  "initialize-atlas-graph",
  "initialize-research-graph",
] as const

const retiredProductSkillNames = new Set<string>(RETIRED_PRODUCT_SKILL_NAMES)

/** Atlas product skills and graph commands that were removed rather than aliased. Matching is
 * case-insensitive, but exact: similarly named third-party skills remain valid. */
export function isRetiredProductSkillName(name: string): boolean {
  return retiredProductSkillNames.has(name.trim().toLowerCase())
}

/** Reject a retired on-disk directory even if stale frontmatter was edited. */
export function isRetiredProductSkillPath(file: string): boolean {
  return isRetiredProductSkillName(path.basename(path.dirname(file)))
}

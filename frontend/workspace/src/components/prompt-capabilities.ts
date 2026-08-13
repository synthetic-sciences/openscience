export type CapabilityPreferences = {
  delegation_enabled: boolean
  delegation_specialist: string | null
}

export type ReviewPreferences = {
  auto: boolean
  model: { providerID: string; modelID: string } | null
}

export type SpecialistOption = {
  name: string
  description?: string
}

export const RESEARCH_EFFORTS = ["normal", "ultra"] as const
export type ResearchEffort = (typeof RESEARCH_EFFORTS)[number]

export type ResearchEffortState = {
  workspace: ResearchEffort
  sessions: Record<string, ResearchEffort>
}

export function normalizeResearchEffort(value: unknown): ResearchEffort {
  return value === "ultra" ? "ultra" : "normal"
}

export function researchEffortLabel(value: ResearchEffort) {
  return value === "ultra" ? "Ultra" : "Normal"
}

export function migrateResearchEffortState(value: unknown): ResearchEffortState {
  if (typeof value === "string") {
    return { workspace: normalizeResearchEffort(value), sessions: {} }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { workspace: "normal", sessions: {} }
  }

  const record = value as Record<string, unknown>
  const source = record.sessions
  const sessions =
    source && typeof source === "object" && !Array.isArray(source)
      ? Object.fromEntries(
          Object.entries(source as Record<string, unknown>).map(([id, effort]) => [
            id,
            normalizeResearchEffort(effort),
          ]),
        )
      : {}

  return {
    workspace: normalizeResearchEffort(record.workspace ?? record.effort),
    sessions,
  }
}

const LABELS: Record<string, string> = {
  research: "Research",
  biology: "Biology",
  physics: "Physics",
  ml: "ML",
  write: "Scientific writing",
  docs: "Documentation",
  task: "General",
  explore: "Exploration",
  "literature-review": "Literature review",
  critique: "Scientific critique",
  "physics-critique": "Physics critique",
  reviewer: "Research reviewer",
}

export const CORE_SPECIALISTS = ["biology", "physics", "ml"] as const

export function isCoreSpecialist(name: string) {
  return CORE_SPECIALISTS.some((specialist) => specialist === name)
}

export function specialistLabel(name: string) {
  return LABELS[name] ?? name.replaceAll("-", " ")
}

export function delegatedSpecialist(enabled: boolean, selected: string | null, explicit: string[]) {
  if (!enabled || !selected || explicit.length > 0) return undefined
  return selected
}

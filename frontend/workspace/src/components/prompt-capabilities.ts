export type CapabilityPreferences = {
  delegation_enabled: boolean
  delegation_specialist: string | null
  delegation_level?: DelegationLevel
  delegation_worker_model?: DelegationModel | null
  delegation_autonomy?: DelegationAutonomy
  delegation_diversity?: DelegationDiversity
}

export type DelegationLevel = "off" | "light" | "standard" | "high"
export type DelegationAutonomy = "interactive" | "balanced" | "autonomous"
export type DelegationDiversity = "focused" | "balanced" | "exploratory"

export type DelegationModel = {
  providerID: string
  modelID: string
}

export type DelegationSettings = {
  level: DelegationLevel
  workerModel?: DelegationModel
  autonomy: DelegationAutonomy
  diversity: DelegationDiversity
}

export const DELEGATION_LEVELS: Array<{ value: DelegationLevel; label: string; description: string }> = [
  { value: "off", label: "Off", description: "No workers" },
  { value: "light", label: "Light", description: "Use one worker when it clearly helps" },
  { value: "standard", label: "Standard", description: "Use a small team for independent work" },
  { value: "high", label: "High", description: "Use several workers for parallel research" },
]

export const DELEGATION_AUTONOMY: Array<{
  value: DelegationAutonomy
  label: string
  description: string
}> = [
  { value: "interactive", label: "Interactive", description: "Ask when an important choice is unclear" },
  { value: "balanced", label: "Balanced", description: "Use safe assumptions; ask before consequential choices" },
  { value: "autonomous", label: "Independent", description: "Ask only when blocked or missing permission" },
]

export const DEFAULT_DELEGATION: DelegationSettings = {
  level: "standard",
  autonomy: "balanced",
  diversity: "balanced",
}

export function delegationSettings(preferences?: CapabilityPreferences): DelegationSettings {
  const level = preferences?.delegation_level ?? (preferences?.delegation_enabled === false ? "off" : "standard")
  return {
    level,
    workerModel: preferences?.delegation_worker_model ?? undefined,
    autonomy: preferences?.delegation_autonomy ?? DEFAULT_DELEGATION.autonomy,
    // Kept in the wire contract for backward compatibility. The product no
    // longer exposes a creativity/diversity control.
    diversity: DEFAULT_DELEGATION.diversity,
  }
}

export function delegationLabel(settings: DelegationSettings) {
  return DELEGATION_LEVELS.find((option) => option.value === settings.level)?.label ?? "Standard"
}

export type SpecialistOption = {
  name: string
  description?: string
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

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
  { value: "off", label: "Off", description: "Keep all work in this conversation" },
  { value: "light", label: "Light", description: "Use one worker for a clear parallel task" },
  { value: "standard", label: "Standard", description: "Delegate when it materially speeds up research" },
  { value: "high", label: "High", description: "Explore several useful branches in parallel" },
]

export const DELEGATION_AUTONOMY: Array<{
  value: DelegationAutonomy
  label: string
  description: string
}> = [
  { value: "interactive", label: "Interactive", description: "Ask before consequential delegated work" },
  { value: "balanced", label: "Balanced", description: "Proceed on routine work and surface decisions" },
  { value: "autonomous", label: "Autonomous", description: "Complete delegated work within current permissions" },
]

export const DELEGATION_DIVERSITY: Array<{
  value: DelegationDiversity
  label: string
  description: string
}> = [
  { value: "focused", label: "Focused", description: "Keep workers on the most likely approach" },
  { value: "balanced", label: "Balanced", description: "Mix confirmation with distinct approaches" },
  { value: "exploratory", label: "Exploratory", description: "Favor independent approaches and broader search" },
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
    diversity: preferences?.delegation_diversity ?? DEFAULT_DELEGATION.diversity,
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

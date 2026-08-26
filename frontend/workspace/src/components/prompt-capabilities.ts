export type CapabilityPreferences = {
  delegation_enabled: boolean
  delegation_specialist: string | null
  delegation_level?: DelegationLevel
  delegation_worker_model?: DelegationModel | null
  delegation_autonomy?: DelegationAutonomy
  /** @deprecated Accepted from older local servers but no longer used. */
  delegation_diversity?: "focused" | "balanced" | "exploratory"
}

export type DelegationLevel = "off" | "light" | "standard" | "high"
export type DelegationAutonomy = "interactive" | "balanced" | "autonomous"

export type DelegationModel = {
  providerID: string
  modelID: string
}

export type DelegationSettings = {
  level: DelegationLevel
  workerModel?: DelegationModel
  autonomy: DelegationAutonomy
}

export const DELEGATION_LEVELS: Array<{ value: DelegationLevel; label: string; description: string }> = [
  { value: "off", label: "Off", description: "Keep work in the lead conversation" },
  { value: "light", label: "Low", description: "Delegate only when it clearly helps" },
  { value: "standard", label: "Normal", description: "Parallelize independent work when useful" },
  { value: "high", label: "High", description: "Aggressively parallelize research and verification" },
]

export const DELEGATION_AUTONOMY: Array<{
  value: DelegationAutonomy
  label: string
  description: string
}> = [
  {
    value: "interactive",
    label: "Interactive",
    description: "Lead and workers ask before consequential choices",
  },
  {
    value: "balanced",
    label: "Balanced",
    description: "Lead and workers make routine assumptions and ask when stakes change",
  },
  {
    value: "autonomous",
    label: "Independent",
    description: "Lead and workers ask only when blocked or missing permission",
  },
]

export const DEFAULT_DELEGATION: DelegationSettings = {
  level: "standard",
  autonomy: "balanced",
}

export function delegationSettings(preferences?: CapabilityPreferences): DelegationSettings {
  const level = preferences?.delegation_level ?? (preferences?.delegation_enabled === false ? "off" : "standard")
  return {
    level,
    workerModel: preferences?.delegation_worker_model ?? undefined,
    autonomy: preferences?.delegation_autonomy ?? DEFAULT_DELEGATION.autonomy,
  }
}

export function delegationLabel(settings: DelegationSettings) {
  return DELEGATION_LEVELS.find((option) => option.value === settings.level)?.label ?? "Normal"
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

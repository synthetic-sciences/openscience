export type CapabilityPreferences = {
  delegation_enabled: boolean
  delegation_specialist: string | null
  delegation_level?: DelegationLevel | "light"
  delegation_worker_model?: DelegationModel | null
  delegation_autonomy?: DelegationAutonomy
  delegation_strategy?: DelegationStrategy
  /** @deprecated Accepted from older local servers but no longer used. */
  delegation_diversity?: "focused" | "balanced" | "exploratory"
}

export type DelegationLevel = "off" | "standard" | "high"
export type DelegationAutonomy = "interactive" | "balanced" | "autonomous"
/** `fusion` binds one persistent worker (the worker model) to the lead. */
export type DelegationStrategy = "parallel" | "fusion"

export type DelegationModel = {
  providerID: string
  modelID: string
}

export function sameDelegationModel(
  current: DelegationModel | null | undefined,
  next: DelegationModel | null | undefined,
) {
  if (!current || !next) return !current && !next
  return current.providerID === next.providerID && current.modelID === next.modelID
}

export type DelegationSettings = {
  level: DelegationLevel
  workerModel?: DelegationModel
  autonomy: DelegationAutonomy
  strategy: DelegationStrategy
}

export const DELEGATION_LEVELS: Array<{ value: DelegationLevel; label: string }> = [
  { value: "off", label: "Off" },
  { value: "standard", label: "Auto" },
  { value: "high", label: "High" },
]

export const DELEGATION_AUTONOMY: Array<{
  value: DelegationAutonomy
  label: string
  description: string
}> = [
  {
    value: "interactive",
    label: "Interactive",
    description: "Plan together and ask at consequential choices, with one recommended option",
  },
  {
    value: "balanced",
    label: "Balanced",
    description: "Decide routine reversible details and ask only when the outcome could materially change",
  },
  {
    value: "autonomous",
    label: "Independent",
    description: "Take the recommended path, record assumptions, and ask only when blocked or missing authority",
  },
]

export const DELEGATION_STRATEGIES: Array<{ value: DelegationStrategy; label: string }> = [
  { value: "parallel", label: "Parallel" },
  { value: "fusion", label: "Fusion" },
]

const DEFAULT_DELEGATION: DelegationSettings = {
  level: "standard",
  autonomy: "balanced",
  strategy: "parallel",
}

export function delegationSettings(preferences?: CapabilityPreferences): DelegationSettings {
  const stored = preferences?.delegation_level
  const level =
    stored === "light" ? "standard" : (stored ?? (preferences?.delegation_enabled === false ? "off" : "standard"))
  return {
    level,
    workerModel: preferences?.delegation_worker_model ?? undefined,
    autonomy: preferences?.delegation_autonomy ?? DEFAULT_DELEGATION.autonomy,
    strategy: preferences?.delegation_strategy ?? DEFAULT_DELEGATION.strategy,
  }
}

export const CAPABILITY_PREFERENCES_EVENT = "openscience:capability-preferences"

export function publishCapabilityPreferences(preferences: CapabilityPreferences) {
  globalThis.dispatchEvent(new CustomEvent(CAPABILITY_PREFERENCES_EVENT, { detail: preferences }))
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

const CORE_SPECIALISTS = ["biology", "physics", "ml"] as const

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

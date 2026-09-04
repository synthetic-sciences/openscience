// Context row in Customize → General. The backend keeps this in the global
// openscience.json (`compaction.threshold`) and serves the effective value through
// /settings/preferences.
export type ContextPreferences = {
  compaction_auto: boolean
  compaction_threshold: number
}

export const THRESHOLD_OPTIONS = [0.5, 0.6, 0.75, 0.9] as const

export type ThresholdOption = { value: number; label: string }

export function thresholdLabel(value: number) {
  return `${Math.round(value * 100)}%`
}

// The select always carries the effective value, so a hand-edited threshold outside the
// preset list still renders as the current choice instead of an empty control.
export function thresholdOptions(current?: number): ThresholdOption[] {
  const preset = [...THRESHOLD_OPTIONS] as number[]
  const values = current === undefined || preset.includes(current) ? preset : [...preset, current]
  return values.sort((a, b) => a - b).map((value) => ({ value, label: thresholdLabel(value) }))
}

// Context rows in Customize → General. The backend keeps these in the global
// openscience.json (`compaction.threshold`, `compaction.warn_tokens`) and serves the
// effective values through /settings/preferences.
export type ContextPreferences = {
  compaction_auto: boolean
  compaction_threshold: number
  compaction_warn_tokens: number
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

export const WARN_TOKENS_MIN = 1_000

// Accepts "120000", "120,000", "120 000" and "120k"; anything else (blank, fractional,
// below the floor) returns undefined so the row can restore the saved value.
export function parseWarnTokens(raw: string): number | undefined {
  const text = raw
    .trim()
    .replace(/[\s,_]/g, "")
    .toLowerCase()
  const match = /^(\d+)(k?)$/.exec(text)
  if (!match) return undefined
  const value = Number(match[1]) * (match[2] ? 1_000 : 1)
  if (!Number.isSafeInteger(value) || value < WARN_TOKENS_MIN) return undefined
  return value
}

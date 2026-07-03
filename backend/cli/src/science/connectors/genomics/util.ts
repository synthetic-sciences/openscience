/**
 * Small defensive accessors shared by the genomics connectors.
 *
 * External APIs return loosely-typed JSON, so every field read goes through
 * these helpers to stay `any`-free and to never throw on missing/odd shapes.
 */

export type Rec = Record<string, unknown>

/** Coerce an unknown value to a plain record (empty object if it isn't one). */
export function asRecord(value: unknown): Rec {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Rec) : {}
}

/** Read a value as a trimmed string, if it is a string or number. */
export function str(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value)
  return undefined
}

/** Read a value as a finite number, tolerating numeric strings. */
export function num(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

/** Coerce an unknown value to an array (empty if it isn't one). */
export function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

/** Join defined, non-empty snippet parts with a middot separator. */
export function summarize(parts: (string | undefined)[], max = 300): string | undefined {
  const joined = parts.filter((p): p is string => typeof p === "string" && p.length > 0).join(" · ")
  if (joined.length === 0) return undefined
  return joined.length > max ? `${joined.slice(0, max - 1)}…` : joined
}

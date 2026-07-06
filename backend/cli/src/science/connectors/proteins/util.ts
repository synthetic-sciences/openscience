/**
 * Small shared helpers for the protein / structure connectors.
 *
 * These are deliberately defensive: every external API returns loosely-typed
 * JSON that changes shape over time, so the connectors narrow values through
 * these helpers instead of trusting a fixed schema.
 */
import { getJSON } from "../http"

/** Clamp a requested limit into `[1, max]`, defaulting when unset. */
export function clampLimit(limit: number | undefined, def: number, max: number): number {
  const n = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : def
  return Math.min(Math.max(1, n), max)
}

/** Coerce an unknown JSON value into a plain record suitable for `hit.extra`. */
export function toRaw(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>
  return { value }
}

/** Return the first non-empty string among the candidates, else undefined. */
export function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) if (typeof v === "string" && v.trim().length > 0) return v
  return undefined
}

/** Narrow an unknown value to an array (empty array otherwise). */
export function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

/** True when a string looks like a UniProt accession (e.g. P00520, A0A0B5AC95).
 *  The leading character must accept O, P and Q: Swiss-Prot accessions
 *  overwhelmingly begin with them (P04637, P38398, O43426, Q9Y6K9, and this
 *  file's own P00520 example). An earlier `[A-NR-Z0-9]` class silently excluded
 *  O/P/Q, so the AlphaFold and SIFTS connectors skipped their fast-path exact-ac
 *  lookup for the most common human proteins. */
export function looksLikeAccession(value: string): boolean {
  return /^[A-Z0-9][A-Z0-9]{5,9}$/i.test(value.trim())
}

interface UniProtLite {
  results?: { primaryAccession?: string }[]
}

/**
 * Resolve a free-text protein query into UniProt accessions. Several sources
 * (AlphaFold, SIFTS) are keyed by accession only, so this bridges a name search
 * to the accessions they understand. Never throws — returns [] on any failure.
 */
export async function resolveUniProtAccessions(query: string, limit: number, signal?: AbortSignal): Promise<string[]> {
  const url =
    `https://rest.uniprot.org/uniprotkb/search?query=${encodeURIComponent(query)}` +
    `&format=json&size=${clampLimit(limit, 5, 25)}&fields=accession`
  try {
    const data = await getJSON<UniProtLite>(url, { signal })
    return asArray<{ primaryAccession?: string }>(data.results)
      .map((r) => r.primaryAccession)
      .filter((a): a is string => typeof a === "string")
  } catch {
    return []
  }
}

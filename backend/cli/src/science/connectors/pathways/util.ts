/**
 * Small defensive helpers shared by the pathway/interaction connectors.
 *
 * These keep each connector's parsing terse while staying resilient to the
 * loose, evolving shapes returned by public biological REST/GraphQL APIs.
 */

/** Strip simple HTML tags (e.g. Reactome `<span class="highlighting">` markup). */
export function stripTags(input: string | undefined | null): string {
  if (!input) return ""
  // Loop until stable: a single pass leaves fragments like
  // "<scr<script>ipt>" reassembling into a tag.
  let out = input
  let prev = ""
  while (out !== prev) {
    prev = out
    out = out.replace(/<[^>]*>/g, "")
  }
  return out.replace(/\s+/g, " ").trim()
}

/** Clamp a caller-supplied limit into a sane `[1, ceiling]` range. */
export function clampLimit(limit: number | undefined, fallback: number, ceiling: number): number {
  const n = typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : fallback
  return Math.max(1, Math.min(n, ceiling))
}

/** Coerce an unknown value to a trimmed non-empty string, or undefined. */
export function asText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined
  if (typeof value === "number" || typeof value === "boolean") return String(value)
  return undefined
}

/** Narrow an unknown value to a plain record (empty object if not one). */
export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

/** Truncate a snippet to a sensible length for list display. */
export function snippet(text: string | undefined, max = 300): string | undefined {
  if (!text) return undefined
  const clean = text.trim()
  if (!clean) return undefined
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

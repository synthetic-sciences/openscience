const MAX_DELAY_MS = 2_000

export function retryAfterMilliseconds(headers: Headers, attempt: number, now = Date.now()) {
  const value = headers.get("retry-after")?.trim()
  if (value && /^\d+(?:\.\d+)?$/u.test(value)) return Math.min(Number(value) * 1_000, MAX_DELAY_MS)
  if (value) {
    const at = Date.parse(value)
    if (Number.isFinite(at)) return Math.min(Math.max(0, at - now), MAX_DELAY_MS)
  }
  return Math.min(250 * 2 ** attempt, MAX_DELAY_MS)
}

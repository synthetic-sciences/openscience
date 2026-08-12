function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

/**
 * Generated SDK requests throw the parsed API error body. Keep the check
 * deliberately narrow: only a confirmed 404/NotFound removes a persisted tab;
 * network and server failures must leave valid older tabs intact.
 */
export function sessionUnavailable(error: unknown) {
  const root = record(error)
  const candidates = [root, record(root?.error), record(root?.cause), record(root?.response)].filter(
    (value): value is Record<string, unknown> => Boolean(value),
  )

  return candidates.some((value) => {
    if (value.name === "NotFoundError") return true
    const status = value.status ?? value.statusCode
    return typeof status === "number" && status === 404
  })
}

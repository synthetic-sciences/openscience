const stages = [
  "os_authenticated",
  "os_authorized",
  "os_admitted",
  "os_upstream_dispatch",
  "os_upstream_headers",
  "os_upstream_response",
] as const

export type GatewayTiming = {
  gatewayRequestID?: string
  /** Millisecond offsets from gateway arrival, not independent durations. */
  gatewayTiming?: Partial<Record<(typeof stages)[number], number>>
}

/** Call only for the authenticated managed route. Keep descriptions, arbitrary
 * metrics and all other response headers out of telemetry. */
export function gatewayTiming(headers: Headers): GatewayTiming {
  const id = headers.get("x-openscience-gateway-request-id")
  const result: GatewayTiming = id && /^[a-f0-9]{32}$/.test(id) ? { gatewayRequestID: id } : {}
  const raw = headers.get("server-timing")
  if (!raw || raw.length > 4_096) return result
  const offsets: GatewayTiming["gatewayTiming"] = {}
  for (const item of raw.split(",")) {
    const match = /^\s*(os_[a-z_]+)\s*;\s*dur\s*=\s*(\d+(?:\.\d+)?)\s*$/.exec(item)
    if (!match || !stages.includes(match[1] as (typeof stages)[number])) continue
    const stage = match[1] as (typeof stages)[number]
    const offset = Number(match[2])
    // Duplicate or impossible offsets are ambiguous, so retain only the ID.
    if (stage in offsets || !Number.isFinite(offset) || offset > 86_400_000) return result
    offsets[stage] = offset
  }
  const ordered = stages.flatMap((stage) => (offsets[stage] === undefined ? [] : [offsets[stage]!]))
  if (ordered.some((offset, index) => index > 0 && offset < ordered[index - 1])) return result
  if (ordered.length) result.gatewayTiming = offsets
  return result
}

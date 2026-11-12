import { createOpenScienceClient } from "@synsci/sdk/v2/client"

/**
 * A local server can stall for seconds without being down — Windows Defender
 * scanning the sidecar's first response, or a cold project catalog. Issue #1042
 * measured 6 of 18 probes past 3 s and one healthy answer at ~9 s; every slow
 * answer counted toward the disconnect banner. Keep the probe above that tail
 * so latency alone cannot mark a live server dead.
 */
export const SERVER_HEALTH_TIMEOUT_MS = 15_000

export type ServerHealth = { healthy: boolean | undefined; version?: string }

export async function probeServerHealth(
  url: string,
  fetchImpl?: typeof fetch,
  timeoutMs = SERVER_HEALTH_TIMEOUT_MS,
): Promise<ServerHealth> {
  // A local AbortController keeps the deadline portable; happy-dom's
  // AbortSignal.timeout replacement throws when no window is bound.
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const sdk = createOpenScienceClient({
      baseUrl: url,
      fetch: fetchImpl,
      signal: controller.signal,
    })
    const result = await sdk.global.health()
    return { healthy: result.data?.healthy === true, version: result.data?.version }
  } catch {
    return { healthy: false }
  } finally {
    clearTimeout(timer)
  }
}

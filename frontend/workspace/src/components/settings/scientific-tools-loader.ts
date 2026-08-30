import type { ScientificToolSetupResult, ScientificToolsResponse } from "./scientific-tools-state"
import { settingsApi } from "./api"

const TTL = 30_000
const cache = new Map<
  string,
  { value?: ScientificToolsResponse; expires: number; request?: Promise<ScientificToolsResponse> }
>()

/**
 * Scientific tools and Connectors read the same local catalog. Share both the
 * in-flight request and a short-lived result so switching panels never starts
 * duplicate inventory work.
 */
export function loadScientificTools(url: string, fetcher: typeof fetch, refresh = false) {
  const current = cache.get(url)
  if (!refresh && current?.value && current.expires > Date.now()) return Promise.resolve(current.value)
  if (!refresh && current?.request) return current.request

  const request = settingsApi<ScientificToolsResponse>(url, fetcher, "/settings/scientific-tools")
  cache.set(url, { value: current?.value, expires: current?.expires ?? 0, request })

  return request.then(
    (value) => {
      cache.set(url, { value, expires: Date.now() + TTL })
      return value
    },
    (error) => {
      const latest = cache.get(url)
      if (latest?.request === request) cache.set(url, { value: latest.value, expires: latest.expires })
      throw error
    },
  )
}

export async function setupScientificTool(url: string, fetcher: typeof fetch, id: string) {
  const result = await settingsApi<ScientificToolSetupResult>(
    url,
    fetcher,
    `/settings/scientific-tools/${encodeURIComponent(id)}/setup`,
    { method: "POST" },
  )
  cache.delete(url)
  return result
}

import { settingsApi } from "./api"

export type CredentialField = {
  name: string
  label: string
  type: "password" | "text" | "textarea"
  optional: boolean
  placeholder?: string
}

export type Service = {
  id: string
  label: string
  description: string
  category?: "compute" | "integration"
  custom: boolean
  fields: CredentialField[]
  connected: boolean
  set_fields: string[]
  updated_at: string | null
  source: "local" | "account" | null
  organization_id?: string | null
}

type Snapshot = { services: Service[] }

const TTL = 30_000
const cache = new Map<string, { value?: Snapshot; expires: number; request?: Promise<Snapshot> }>()

/**
 * Credentials and Compute both list `/settings/credentials`. Share the
 * in-flight request and a short-lived result so switching between those panels
 * never repeats the same read.
 */
export function loadCredentials(url: string, fetcher: typeof fetch, refresh = false) {
  const current = cache.get(url)
  if (!refresh && current?.value && current.expires > Date.now()) return Promise.resolve(current.value)
  if (!refresh && current?.request) return current.request

  const request = settingsApi<Snapshot>(url, fetcher, "/settings/credentials")
  cache.set(url, { value: current?.value, expires: current?.expires ?? 0, request })

  return request.then(
    (value) => {
      if (cache.get(url)?.request === request) cache.set(url, { value, expires: Date.now() + TTL })
      return value
    },
    (error) => {
      const latest = cache.get(url)
      if (latest?.request === request) cache.set(url, { value: latest.value, expires: latest.expires })
      throw error
    },
  )
}

/** Any credential write invalidates both saved and in-flight snapshots. */
export function invalidateCredentials(url: string) {
  cache.delete(url)
}

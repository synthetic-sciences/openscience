// Thin JSON helper for settings panels that call NEW local-server routes not
// yet in the generated SDK (settings/credentials, settings/storage). Targets
// the same loopback base URL the SDK uses; the app origin is allow-listed by
// the server's host/origin guard, so a direct fetch is accepted.
export async function settingsApi<T>(
  base: string,
  fetchFn: typeof fetch,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const res = await fetchFn(`${base.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(text || `${res.status} ${res.statusText}`)
  }
  if (res.status === 204) return undefined as T
  return (await res.json()) as T
}

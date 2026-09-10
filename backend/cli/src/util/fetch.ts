/** Bun 1.3.14 can reuse a half-open pooled socket without checking that the
 * peer still answers. Keep inference and its credential requests off that
 * pool: a fresh connection avoids minute-long waits before gateway dispatch.
 * Connection: close is necessary on the pinned runtime; keepalive: false
 * alone does not reliably disable reuse. This does not retry a request. */
export function fetchWithFreshConnection(input: string | URL | Request, init?: BunFetchRequestInit): Promise<Response> {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
  headers.set("Connection", "close")
  return fetch(input, { ...init, headers, keepalive: false })
}

type DefaultServerInput = {
  explicit?: string
  stored?: string
  configured?: string
  hostname: string
  origin: string
  dev: boolean
}

const loopback = (url: string) => /^https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(url)

/** A stored default names a server the user picked while the UI was served
 * from somewhere else. When this page itself came from a loopback OpenScience
 * server, that server is alive by definition, while a stored loopback port is
 * often a sidecar or dev server that has since exited: preferring it leaves
 * the page failing to fetch from nothing. Remote defaults are still honoured. */
function staleLoopbackDefault(input: DefaultServerInput) {
  // A build configured for a separate API server is not served by that API.
  return (
    !input.dev &&
    !input.configured &&
    !!input.stored &&
    loopback(input.stored) &&
    loopback(input.origin) &&
    normalize(input.stored) !== normalize(input.origin)
  )
}

const normalize = (url: string) => url.replace(/\/+$/, "").toLowerCase()

export function resolveDefaultServerUrl(input: DefaultServerInput) {
  if (input.explicit) return input.explicit
  if (input.stored && !staleLoopbackDefault(input)) return input.stored
  if (input.configured) return input.configured
  if (input.dev) return "http://localhost:4096"
  return input.origin
}

export function resolveDesktopServerUrl(search: string, origin: string) {
  return new URLSearchParams(search).get("desktop") === "1" ? origin : undefined
}

export function hasDesktopUpdateCapability(search: string) {
  const query = new URLSearchParams(search)
  return query.get("desktop") === "1" && query.get("desktop-update") === "1"
}

/** Route browser calls through the selected OpenScience server when the UI is
 * hosted separately, while keeping compact relative URLs in bundled builds. */
export function resolveServerRoute(path: string, server: string, pageOrigin: string) {
  const target = new URL(server, pageOrigin)
  return target.origin === pageOrigin ? path : new URL(path, target).toString()
}

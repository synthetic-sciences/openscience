type DefaultServerInput = {
  explicit?: string
  stored?: string
  configured?: string
  hostname: string
  origin: string
  dev: boolean
}

export function resolveDefaultServerUrl(input: DefaultServerInput) {
  if (input.explicit) return input.explicit
  if (input.stored) return input.stored
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

type DefaultServerInput = {
  explicit?: string
  stored?: string
  configured?: string
  hostname: string
  origin: string
  hostedDomain: string
  dev: boolean
}

export function resolveDefaultServerUrl(input: DefaultServerInput) {
  if (input.explicit) return input.explicit
  if (input.stored) return input.stored
  if (input.configured) return input.configured
  if (input.hostname.includes(input.hostedDomain)) return "http://localhost:4096"
  if (input.dev) return "http://localhost:4096"
  return input.origin
}

export type KernelTransport = (path: string, init?: RequestInit, query?: Record<string, string>) => Promise<Response>

export type KernelRoute = readonly [canonical: string, legacy: string]

const discoveryRoute = (path: string) => {
  const route = path.split("?", 1)[0]
  if (route === "/kernels" || route === "/kernels/commands" || route === "/kernels/compute") return route
  return undefined
}

/**
 * Canonical plain-runtime routes paired with the notebook compatibility routes
 * served by older local backends. Keep the pairing here so every Compute
 * surface follows the same migration boundary.
 */
export const kernelAPI = {
  inventory: ["/kernels", "/notebook/kernels"] as const,
  commands: ["/kernels/commands", "/notebook/commands"] as const,
  compute(client: string): KernelRoute {
    const query = `?client=${encodeURIComponent(client)}`
    return [`/kernels/compute${query}`, `/notebook/compute${query}`]
  },
  control(kernelID: string, action: "restart" | "stop" | "interrupt"): KernelRoute {
    const id = encodeURIComponent(kernelID)
    return [`/kernels/${id}/${action}`, `/notebook/kernels/${id}/${action}`]
  },
  stopCommand(commandID: string): KernelRoute {
    const id = encodeURIComponent(commandID)
    return [`/kernels/commands/${id}/stop`, `/notebook/commands/${id}/stop`]
  },
}

/**
 * Prefer the canonical Python/R runtime API. A 404 is the one reliable signal
 * that the running local backend predates it, so only that status retries the
 * still-supported notebook compatibility route. Authentication, authority,
 * validation, runtime, and network failures remain truthful to the caller.
 */
export async function requestKernelRoute(
  request: KernelTransport,
  route: KernelRoute,
  init?: RequestInit,
  query?: Record<string, string>,
) {
  const response = await request(route[0], init, query)
  if (response.status !== 404) return response
  return request(route[1], init, query)
}

const LEGACY_TTL = 60_000

/**
 * Remember a confirmed compatibility miss for high-frequency discovery
 * routes. A local backend's route generation does not change between 2.5s
 * polls, so probing a known-missing canonical route every cycle only adds
 * latency and noisy 404s. The memory expires after a minute so a backend that
 * was upgraded underneath a long-lived tab gets its canonical route back.
 * Control routes stay uncached: a missing runtime on a current backend must
 * never switch unrelated requests to the legacy API.
 */
export function createKernelRouteRequester(
  request: KernelTransport,
  options: { ttl?: number; now?: () => number } = {},
) {
  const ttl = options.ttl ?? LEGACY_TTL
  const now = options.now ?? Date.now
  const legacy = new Map<string, number>()

  return async (route: KernelRoute, init?: RequestInit, query?: Record<string, string>) => {
    const key = discoveryRoute(route[0])
    if (key && (legacy.get(key) ?? 0) > now()) return request(route[1], init, query)

    const response = await request(route[0], init, query)
    if (response.status !== 404) return response
    if (key) legacy.set(key, now() + ttl)
    return request(route[1], init, query)
  }
}

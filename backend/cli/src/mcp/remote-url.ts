const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"])

export namespace McpRemoteUrl {
  function isLoopback(value: URL): boolean {
    return LOOPBACK.has(value.hostname.toLowerCase())
  }

  export function network(
    input: string | URL,
    label = "Remote MCP URL",
    options: { allowLoopbackHttp?: boolean } = {},
  ): URL {
    const value = input instanceof URL ? new URL(input) : new URL(input)
    const secure = value.protocol === "https:"
    const loopback = options.allowLoopbackHttp === true && value.protocol === "http:" && isLoopback(value)
    if (!secure && !loopback) throw new Error(`${label} must use HTTPS (loopback HTTP is allowed for development)`)
    if (value.username || value.password) throw new Error(`${label} must not contain URL credentials`)
    return value
  }

  export function endpoint(input: string | URL): URL {
    const value = network(input, "Remote MCP URL", { allowLoopbackHttp: true })
    if (value.search || value.hash) {
      throw new Error("Remote MCP endpoint URLs must not contain query credentials or fragments; use headers instead")
    }
    return value
  }

  export function validEndpoint(input: string): boolean {
    try {
      endpoint(input)
      return true
    } catch {
      return false
    }
  }

  /** Discovered OAuth URLs may use loopback HTTP only when the configured MCP
   * endpoint itself is loopback HTTP. An HTTPS server must not be able to turn
   * metadata into a credential-bearing request to a local service. */
  export function discovered(input: string | URL, endpoint: string | URL, label: string): URL {
    const configured = McpRemoteUrl.endpoint(endpoint)
    return network(input, label, {
      allowLoopbackHttp: configured.protocol === "http:" && isLoopback(configured),
    })
  }

  /** Bun's redirect:"error" currently surfaces an internal UnexpectedRedirect
   * as an unhandled test error. Manual mode plus an explicit 3xx rejection has
   * the same no-forwarding guarantee and a controlled application error. */
  export async function fetchNoRedirect(input: string | URL, init?: RequestInit): Promise<Response> {
    const response = await fetch(input, { ...init, redirect: "manual" })
    if (response.status >= 300 && response.status < 400) {
      await response.body?.cancel().catch(() => undefined)
      throw new Error(`Redirects are not allowed for credential-bearing MCP requests (${response.status})`)
    }
    return response
  }
}

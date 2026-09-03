// The local openscience server is loopback-only and unauthenticated (its single
// security control is a Host-header check on the server). The web app therefore
// makes plain fetch/WebSocket calls with no Authorization header.
export const openscienceFetch: typeof fetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetch(input, init),
  { preconnect: typeof fetch.preconnect === "function" ? fetch.preconnect.bind(fetch) : () => undefined },
)

type Query = Record<string, string | number | boolean | undefined>
const selectors = new Set(["project", "projectID", "directory"])

export type ProjectRequest = {
  (path: string, init?: RequestInit, query?: Query): Promise<Response>
  url(path: string, query?: Query): string
}

function projectID(value: string | undefined) {
  const id = value?.trim()
  if (id) return id
  throw new Error("Project request requires an opaque project selector.")
}

function directory(value: string) {
  return /[^\x00-\x7F]/.test(value) ? encodeURIComponent(value) : value
}

/**
 * Build requests from the active SDK capability. Callers can add resource
 * query parameters, but cannot replace the project selector or root override.
 */
export function createProjectRequest(input: {
  baseUrl: () => string
  projectID: () => string | undefined
  directory: () => string
  fetch: () => typeof fetch
}): ProjectRequest {
  const target = (path: string, query?: Query) => {
    const base = `${input.baseUrl().replace(/\/+$/, "")}/`
    const url = new URL(path.replace(/^\/+/, ""), base)
    if (url.origin !== new URL(base).origin)
      throw new Error("Project requests must target the active OpenScience server.")
    for (const selector of selectors) url.searchParams.delete(selector)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value === undefined || selectors.has(key)) continue
      url.searchParams.set(key, String(value))
    }
    return url
  }
  const request = (path: string, init?: RequestInit, query?: Query) => {
    const headers = new Headers(init?.headers)
    headers.set("x-openscience-project", projectID(input.projectID()))
    const root = input.directory()
    headers.delete("x-openscience-directory")
    if (root) headers.set("x-openscience-directory", directory(root))
    return input.fetch()(target(path, query), {
      ...init,
      headers,
    })
  }
  return Object.assign(request, {
    url(path: string, query?: Query) {
      const url = target(path, query)
      url.searchParams.set("project", projectID(input.projectID()))
      const root = input.directory()
      if (root) url.searchParams.set("directory", root)
      return url.toString()
    },
  })
}

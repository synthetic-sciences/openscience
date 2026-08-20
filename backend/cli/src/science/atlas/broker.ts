import path from "node:path"
import { API_BASE, OpenScience } from "@/openscience"

export type AtlasBrokerInput = {
  operation: "brief" | "node" | "tree" | "search" | "ask" | "usage"
  project?: string
  node?: string
  query?: string
  full?: boolean
  mode?: "universal" | "targeted" | "web" | "deep"
  topK?: number
  sourceIDs?: string[]
  projection?: string
  maxNodes?: number
  maxDepth?: number
}

export class AtlasBrokerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = "AtlasBrokerError"
  }
}

const timeout = Number(process.env["OPENSCIENCE_ATLAS_TIMEOUT_MS"]) || 60_000

const required = (value: string | undefined, name: string) => {
  const result = value?.trim()
  if (!result) throw new AtlasBrokerError(`${name} is required`)
  return result
}

const sources = (values: string[] | undefined) => {
  if (!values?.length) return
  if (values.length > 100) throw new AtlasBrokerError("source_ids accepts at most 100 Gateway identifiers")
  const result = new Set<string>()
  for (const raw of values) {
    const value = raw.trim()
    const normalized = value.replaceAll("\\", "/")
    const segments = normalized.split("/")
    const local =
      !value ||
      value.length > 512 ||
      value.includes("\0") ||
      path.isAbsolute(value) ||
      /^[A-Za-z]:[\\/]/.test(value) ||
      normalized.startsWith("~/") ||
      segments.includes(".") ||
      segments.includes("..")
    if (local) throw new AtlasBrokerError("source_ids must contain Gateway identifiers, not local folder paths")
    result.add(value)
  }
  return [...result]
}

const query = (values: Record<string, string | number | boolean | undefined>) => {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value))
  }
  const suffix = params.toString()
  return suffix ? `?${suffix}` : ""
}

export async function atlasRequest(method: string, path: string, body?: unknown, signal?: AbortSignal) {
  const session = await OpenScience.getSession()
  if (!session?.api_key) throw new AtlasBrokerError("Sign in to Gateway before using the host broker.", 401)
  const limit = AbortSignal.timeout(timeout)
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${session.api_key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, limit]) : limit,
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new AtlasBrokerError(detail || `Gateway request failed with HTTP ${response.status}`, response.status)
  }
  return response.json() as Promise<unknown>
}

export namespace AtlasBroker {
  export async function run(input: AtlasBrokerInput, signal?: AbortSignal) {
    if (input.operation === "brief") {
      const project = required(input.project, "project")
      return atlasRequest(
        "GET",
        `/api/v1/projects/${encodeURIComponent(project)}/brief${query({ full: input.full || undefined })}`,
        undefined,
        signal,
      )
    }
    if (input.operation === "node") {
      const node = required(input.node, "node")
      return atlasRequest(
        "GET",
        `/api/v1/nodes/${encodeURIComponent(node)}${query({ projection: input.projection })}`,
        undefined,
        signal,
      )
    }
    if (input.operation === "tree") {
      const node = required(input.node, "node")
      return atlasRequest(
        "GET",
        `/api/v1/nodes/${encodeURIComponent(node)}/tree${query({
          projection: input.projection,
          max_nodes: input.maxNodes,
          max_depth: input.maxDepth,
        })}`,
        undefined,
        signal,
      )
    }
    if (input.operation === "search") {
      const text = required(input.query, "query")
      const sourceIDs = sources(input.sourceIDs)
      return atlasRequest(
        "POST",
        "/api/v1/search",
        {
          query: text,
          ...(input.mode ? { mode: input.mode } : {}),
          ...(input.topK ? { top_k: input.topK } : {}),
          ...(sourceIDs?.length ? { data_sources: sourceIDs } : {}),
        },
        signal,
      )
    }
    if (input.operation === "ask") {
      const text = required(input.query, "query")
      const sourceIDs = sources(input.sourceIDs)
      return atlasRequest(
        "POST",
        "/api/v1/documents/ask",
        {
          query: text,
          ...(input.topK ? { top_k: input.topK } : {}),
          ...(sourceIDs?.length ? { source_ids: sourceIDs } : {}),
        },
        signal,
      )
    }
    return atlasRequest("GET", "/api/v1/usage/summary", undefined, signal)
  }
}

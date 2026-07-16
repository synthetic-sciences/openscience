/**
 * Thin client for the dev-only /api/atlas bridge (see vite-atlas.js).
 * Each call shells out to the local @synsci/atlas binary on the host.
 */

export interface AtlasNode {
  node_id: string
  title: string | null
  summary: string
  hypothesis: string
  content: string
  kind: string
  lifecycle: "staged" | "committed" | string
  outcome: string | null
  parent_ids: string[]
  child_ids: string[]
  graph_tags: string[]
  tag_ids: string[]
  sharing_mode: "public" | "private" | "unlisted" | string
  slug_name: string | null
  repo_url: string | null
  branch_name: string | null
  head_commit_sha: string | null
  revision: number
  created_at: string
  updated_at: string
  updated_by: string | null
  no_artifacts_reason: string | null
}

export interface NodesListResponse {
  nodes: AtlasNode[]
  total: number
  page: number
  per_page: number
  has_more: boolean
}

export interface AtlasArtifact {
  artifact_id: string
  node_id: string
  kind: string
  name?: string
  uri?: string
  bytes?: number
  created_at?: string
  [key: string]: unknown
}

export interface ArtifactsListResponse {
  artifacts: AtlasArtifact[]
  has_more?: boolean
}

async function getJSON<T>(path: string): Promise<T> {
  const res = await fetch(`/api/atlas${path}`)
  if (!res.ok) {
    let detail = ""
    try {
      detail = (await res.json())?.detail ?? ""
    } catch {}
    throw new Error(`atlas ${path} failed: ${res.status}${detail ? ` — ${detail}` : ""}`)
  }
  return res.json()
}

async function postJSON<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/atlas${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    let detail = ""
    try {
      detail = (await res.json())?.detail ?? ""
    } catch {}
    throw new Error(`atlas POST ${path} failed: ${res.status}${detail ? ` — ${detail}` : ""}`)
  }
  return res.json()
}

export interface GraphTreeResponse {
  anchor_node_id?: string
  root_node_ids?: string[]
  nodes: AtlasNode[]
  node_count?: number
}

export interface InitProjectResponse {
  project_id: string | null
  error?: "unauthenticated" | "unreachable" | "plan" | "backend" | string
  status?: number
  message?: string
  host?: string
}

export const atlasAPI = {
  listNodes: () => getJSON<NodesListResponse>("/nodes"),
  /** The user's graphs = root nodes; the canvas shows one at a time. */
  listGraphs: () => getJSON<NodesListResponse>("/graphs"),
  /** Full subgraph for a single graph/root. */
  getGraphTree: (id: string) => getJSON<GraphTreeResponse>(`/graphs/${id}/tree`),
  createNode: (title: string) => postJSON<AtlasNode>("/nodes", { title }),
  /** Resolve the OPENED project's root id (null if unlinked/offline). The
   *  directory is the project the SPA has open, not the serve launch dir. */
  resolveProject: (directory: string) =>
    getJSON<{ project_id: string | null }>(`/project?directory=${encodeURIComponent(directory)}`),
  /** Find-or-create the OPENED project's root (explicit user action). */
  initProject: (directory: string) =>
    postJSON<InitProjectResponse>(`/project/init?directory=${encodeURIComponent(directory)}`, {}),
  githubStatus: () => getJSON<unknown>("/github/status"),
  githubRefresh: () => postJSON<unknown>("/github/refresh", {}),
  githubDisconnect: () => postJSON<unknown>("/github/disconnect", {}),
  githubLink: (input: { installationID: string; state?: string }) =>
    postJSON<unknown>("/github/link", {
      installation_id: input.installationID,
      state: input.state,
    }),
  listArtifacts: (nodeID: string) => getJSON<ArtifactsListResponse | AtlasArtifact[]>(`/nodes/${nodeID}/artifacts`),
}

// Pre-warm the bridge on app boot so the canvas tab is fast on first open.
// The canvas loads the cheap root list (`/graphs`) + the selected project's
// subtree (`/graphs/:id/tree`) — NOT the full `/nodes` set — so warm `/graphs`
// (and resolve this folder's project), not the expensive all-nodes endpoint.
if (typeof window !== "undefined") {
  setTimeout(() => {
    fetch("/api/atlas/graphs").catch(() => {})
  }, 250)
}

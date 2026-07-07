/**
 * Bridge for `/api/thesis/*` → the Atlas graph backend.
 *
 * The OpenScience web canvas (node list) and project/session sync proxy
 * through here to the Atlas REST API (`API_BASE/api/v1/*`), authenticated
 * with the user's stored `thk_` key (`OpenScience.getSession()`). This is the
 * same backend + token the CLI already uses for sync/skills/billing, and
 * the same contract the `atlas` CLI binary speaks (`nodes:list`,
 * `nodes:commit-new`, `auth/github/*`).
 *
 * Unauthenticated (or backend-unreachable) callers get graceful empty /
 * local-stub payloads so the canvas + sync stay quiet instead of throwing
 * 401 toasts on every project open.
 */
import { Hono } from "hono"
import crypto from "crypto"
import { realpathSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { lazy } from "../../util/lazy"
import { OpenScience, API_BASE } from "../../openscience"
import { Log } from "../../util/log"

const log = Log.create({ service: "atlas-bridge" })

const EMPTY_NODES = { nodes: [] as unknown[], total: 0, page: 1, per_page: 50, has_more: false }
const EMPTY_ARTIFACTS = { artifacts: [] as unknown[], has_more: false }
const EMPTY_GITHUB = { connected: false }

/** Deterministic local placeholder id for unauthenticated callers — lets
 *  the SPA cache a project/session mapping without minting real Atlas state. */
function stubNodeId(seed: string): string {
  return `stub-${crypto
    .createHash("sha256")
    .update(seed || "stub")
    .digest("hex")
    .slice(0, 24)}`
}

function nodeIdOf(data: any): string | null {
  return (
    data?.node_id ??
    data?.id ??
    data?.node?.node_id ??
    data?.node?.id ??
    data?.committed?.node_id ??
    data?.result?.node_id ??
    null
  )
}

async function token(): Promise<string | null> {
  const session = await OpenScience.getSession()
  return session?.api_key ?? null
}

// Bound every Atlas bridge call. Without this a slow/unresponsive backend hangs
// the caller forever — and because `openscience project init` (run from the
// research prompt on every session) goes through here, and the agent's bash tool
// has no default timeout, a slow graph-create wedged a whole session for >60 min.
// A timeout turns that into a fast, actionable "couldn't reach Atlas" instead.
// Overridable for genuinely slow links via OPENSCIENCE_ATLAS_TIMEOUT_MS.
const ATLAS_TIMEOUT_MS = Number(process.env["OPENSCIENCE_ATLAS_TIMEOUT_MS"]) || 60_000

/** Call the Atlas backend with the user's key. Throws if unauthenticated, and
 *  aborts (rejects) after ATLAS_TIMEOUT_MS so callers fail fast, never hang. */
async function atlas(method: string, path: string, body?: unknown): Promise<Response> {
  const key = await token()
  if (!key) throw new Error("unauthenticated")
  return fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(ATLAS_TIMEOUT_MS),
  })
}

// ── best-effort git repo context (mirrors the dev bridge) ────────────────
async function git(args: string[], cwd: string): Promise<string> {
  try {
    const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    return out.trim()
  } catch {
    return ""
  }
}

function normalizeRemote(remote: string): string | null {
  const t = remote.trim()
  if (!t) return null
  const ssh = t.match(/^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/)
  if (ssh) return `https://github.com/${ssh[1]}/${ssh[2]}`
  const https = t.match(/^https?:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/)
  if (https) return `https://github.com/${https[1]}/${https[2]}`
  return t
}

// ── git-repo-rooted project resolution ───────────────────────────────────
// A "project" is its GIT REPO, not the arbitrary folder the SPA opened. When
// the opened path is inside a git work tree, resolve up to the repo top-level
// (`git rev-parse --show-toplevel`) so opening a SUBFOLDER — or a clone at a
// different absolute path — resolves to the SAME project + Atlas graph. When
// the path is not a repo, fall back to the opened folder itself (non-git
// folders still get a stable per-folder project — backward compatible).
export async function repoRoot(directory: string): Promise<string> {
  if (!directory) return directory
  const top = await git(["rev-parse", "--show-toplevel"], directory)
  if (!top) return directory
  try {
    return realpathSync(top)
  } catch {
    return top
  }
}

async function repoContext(directory: string) {
  const empty = {
    repo_url: null as string | null,
    branch_name: null as string | null,
    head_commit_sha: null as string | null,
    origin_host: null as string | null,
    updated_by: null as string | null,
    external_transcript_ref: null as string | null,
  }
  if (!directory) return empty
  const [remote, branch, head, user] = await Promise.all([
    git(["config", "--get", "remote.origin.url"], directory),
    git(["branch", "--show-current"], directory),
    git(["rev-parse", "HEAD"], directory),
    git(["config", "user.email"], directory),
  ])
  const repo = remote ? normalizeRemote(remote) : null
  let host: string | null = null
  if (repo) {
    try {
      host = new URL(repo).hostname
    } catch {}
  }
  return {
    ...empty,
    repo_url: repo,
    branch_name: branch || null,
    head_commit_sha: head || null,
    origin_host: host,
    updated_by: user || null,
  }
}

/** Non-2xx backend answer, carrying enough to classify WHY it failed. */
class BackendHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`HTTP ${status}`)
    this.name = "BackendHttpError"
  }
}

async function commitNew(input: {
  localID: string
  parentIDs: string[]
  title: string
  kind: string
  summary: string
  hypothesis: string
  content: string
  reason: string
  context: unknown
  insights?: string[]
}): Promise<{ node_id: string | null; raw: unknown }> {
  const res = await atlas("POST", "/api/v1/nodes/commit-new", {
    local_temp_node_id: input.localID,
    parent_ids: input.parentIDs,
    staged_payload: {
      title: input.title,
      kind: input.kind,
      content: input.content,
      summary: input.summary,
      hypothesis: input.hypothesis,
      insights: input.insights ?? [],
      no_artifacts_reason: input.reason,
      repo_context: input.context,
    },
  })
  if (!res.ok) throw new BackendHttpError(res.status, await res.text().catch(() => ""))
  const data = await res.json()
  return { node_id: nodeIdOf(data), raw: data }
}

// ── stable repo-identity dedupe key ──────────────────────────────────────
// Keys off REPO IDENTITY, not the raw opened folder:
//   `repo:<host>/<owner>/<name>` when a git remote exists (portable across
//   clones/machines), else `local-folder:<realpath>` of the git repo ROOT
//   (callers pass the resolved top-level, so a subfolder of a remote-less repo
//   still collapses to one project). Non-git folders pass their own path and
//   get a stable per-folder key (backward compatible). Atlas namespaces this
//   internally (`atlas-project-dedupe:` + key, per owner) so there are no
//   cross-user collisions. Keep this shape stable — it is the upsert key.
export function computeDedupeKey(directory: string, repoUrl: string | null): string {
  if (repoUrl) {
    try {
      const u = new URL(repoUrl)
      const segments = u.pathname
        .replace(/^\/+/, "")
        .replace(/\.git$/, "")
        .split("/")
      const owner = segments.shift()
      const name = segments.join("/")
      if (owner && name) return `repo:${u.hostname}/${owner}/${name}`
    } catch {}
  }
  try {
    return `local-folder:${realpathSync(directory)}`
  } catch {
    return `local-folder:${directory}`
  }
}

// ── per-folder project resolution (scopes the canvas to the OPENED folder) ──
// The /api/agent/projects payload keys the id as `project_id` (NOT `node_id`),
// so use a project-aware extractor — `nodeIdOf` would miss it and return null.
function projectIdOf(p: any): string | null {
  return p?.project_id ?? p?.id ?? p?.node_id ?? null
}

// ── local project pin (.openscience/project.json) ─────────────────────────────
// Written by `openscience project init` / `project merge` and by a successful
// resolve. Read FIRST so a linked repo shows its graph instantly (and offline)
// without re-hitting the API — closing the gap where the pin was written but
// never honoured. Lives at the repo root next to .git.
export interface ProjectPin {
  project_id: string
  /** The dedupe key this project was resolved for; absent in legacy pins. */
  dedupe_key?: string
}

function readProjectPin(root: string): ProjectPin | null {
  // legacy `.synsci/` pins predate the OpenScience rename; still honored
  for (const dir of [".openscience", ".synsci"]) {
    try {
      const raw = readFileSync(join(root, dir, "project.json"), "utf8")
      const j = JSON.parse(raw)
      if (typeof j?.project_id === "string" && j.project_id)
        return { project_id: j.project_id, dedupe_key: typeof j?.dedupe_key === "string" ? j.dedupe_key : undefined }
    } catch {}
  }
  return null
}

/** Trust a pin only when it carries no dedupe key (legacy/back-compat) or its
 *  key matches the repo's freshly-computed key. A pin whose key differs belongs
 *  to a DIFFERENT repo identity (e.g. the remote was re-pointed, or a stale
 *  `.openscience/` was copied in) and must not shadow — or block find-or-create
 *  of — the correct project. */
export function pinMatchesKey(pin: ProjectPin, key: string): boolean {
  return !pin.dedupe_key || pin.dedupe_key === key
}

function writeProjectPin(root: string, projectId: string, key: string): void {
  try {
    mkdirSync(join(root, ".openscience"), { recursive: true })
    writeFileSync(
      join(root, ".openscience", "project.json"),
      JSON.stringify({ project_id: projectId, dedupe_key: key, resolved_at: new Date().toISOString() }, null, 2) + "\n",
    )
  } catch {
    // best-effort — a read-only checkout still works, just without the cache
  }
}

// Find-only: the repo's dedupe-key → its Atlas project root id (null when
// unlinked/offline). Honours the local pin first, then the API; caches an API
// hit back to the pin. The directory is the folder the SPA has open (query
// param), NOT the serve launch dir.
async function resolveProjectId(directory: string): Promise<string | null> {
  if (!directory) return null
  try {
    // Root to the git repo top-level so a subfolder / a clone at a different
    // path resolves to the SAME project + graph as the repo itself.
    const root = await repoRoot(directory)
    const ctx = await repoContext(root)
    const key = computeDedupeKey(root, ctx.repo_url)
    // Honour the local pin first (instant + offline) — but ONLY when it was
    // resolved for THIS repo identity, so a stale pin can't shadow the right
    // project (or block find-or-create from ever creating it).
    const pin = readProjectPin(root)
    if (pin && pinMatchesKey(pin, key)) return pin.project_id
    const res = await atlas("GET", `/api/agent/projects?dedupe_key=${encodeURIComponent(key)}`)
    if (!res.ok) return null
    const data = await res.json()
    const existing = Array.isArray(data?.projects) ? data.projects[0] : undefined
    const id = projectIdOf(existing)
    if (id) writeProjectPin(root, id, key)
    return id
  } catch {
    return null
  }
}

// ── graph-init failure classification ────────────────────────────────────
// `project init` used to collapse EVERY failure (no session, DNS failure,
// revoked key, no plan, backend 4xx/5xx) into `null` → one misleading
// "check login and plan" message. Classify instead, so the CLI and the
// initialize-atlas-graph skill can tell the user the actual fix.

export type InitProjectFailureKind =
  | "unauthenticated" // no session, or the backend rejected the key (401/403)
  | "unreachable" // network/DNS error or 5xx — the service couldn't be reached
  | "plan" // authenticated, but no active Atlas plan (402 / plan-coded 4xx)
  | "backend" // any other backend answer — pass its message through

export interface InitProjectFailure {
  kind: InitProjectFailureKind
  /** HTTP status when the backend answered; absent for network-level failures. */
  status?: number
  /** Backend-provided detail (or the network error), safe to show the user. */
  message?: string
  /** The managed base URL the request targeted — which backend auth points at. */
  host: string
}

export interface InitProjectResult {
  projectId: string | null
  /** Present iff projectId is null. */
  failure?: InitProjectFailure
}

/** Pull a human-readable detail out of a backend error body (FastAPI shapes:
 *  `{detail: "..."}` or `{detail: {code, message, ...}}`), else the raw text. */
function backendMessage(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body)
    const detail = parsed?.detail
    if (typeof detail === "string") return detail
    if (typeof detail?.message === "string" && detail.message) return detail.message
    if (typeof parsed?.message === "string" && parsed.message) return parsed.message
  } catch {}
  const trimmed = body.trim()
  return trimmed ? trimmed.slice(0, 300) : undefined
}

/** Classify a non-2xx backend answer. Mirrors the backend contract: 401/403 =
 *  key rejected; 402 (`plan_quota_exhausted` / `collaboration_gated`) = plan
 *  gating; 5xx = service not reachable/healthy; anything else passes through. */
export function classifyInitFailure(status: number, body: string): InitProjectFailure {
  const message = backendMessage(body)
  const host = API_BASE
  if (status === 401 || status === 403) return { kind: "unauthenticated", status, message, host }
  const planCoded = /plan_quota_exhausted|collaboration_gated/.test(body)
  const planWorded = /\b(plan|subscription)\b/i.test(message ?? "")
  if (status === 402 || (status >= 400 && status < 500 && (planCoded || planWorded)))
    return { kind: "plan", status, message, host }
  if (status >= 500) return { kind: "unreachable", status, message, host }
  return { kind: "backend", status, message, host }
}

function failureFromError(e: unknown): InitProjectFailure {
  if (e instanceof BackendHttpError) return classifyInitFailure(e.status, e.body)
  if (e instanceof Error && e.message === "unauthenticated") return { kind: "unauthenticated", host: API_BASE }
  const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : ""
  const message = e instanceof Error ? `${e.message}${cause}` : String(e)
  return { kind: "unreachable", message, host: API_BASE }
}

// Lower rank = more actionable for the user; ties keep the primary attempt's
// failure, except a primary 404 ("projects endpoint not deployed") defers to
// the proven commit-new fallback's failure.
const FAILURE_RANK: Record<InitProjectFailureKind, number> = {
  unauthenticated: 0,
  plan: 1,
  unreachable: 2,
  backend: 3,
}

function pickFailure(
  primary: InitProjectFailure | undefined,
  fallback: InitProjectFailure | undefined,
): InitProjectFailure {
  if (!primary) return fallback ?? { kind: "backend", host: API_BASE }
  if (!fallback) return primary
  if (primary.kind === "backend" && primary.status === 404) return fallback
  if (FAILURE_RANK[fallback.kind] < FAILURE_RANK[primary.kind]) return fallback
  return primary
}

// Find-or-create the repo's project root — the "initialize graph" action, shared
// by the web bridge (POST /project/init) and the `openscience project init` CLI so
// both take the exact same, dedupe-consistent path. Primary create is the
// projects endpoint; on any failure it falls back to a dedupe-tagged ROOT NODE
// via the proven commit-new endpoint (the same call the canvas uses), so init
// still succeeds even if the projects endpoint is unavailable. Always writes the
// pin on success. Exported for the CLI command.
export async function initProject(directory: string): Promise<string | null> {
  return (await initProjectDetailed(directory)).projectId
}

/** Like initProject, but never throws and reports WHY init failed so callers
 *  can print an actionable message instead of a blanket "check login/plan". */
export async function initProjectDetailed(directory: string): Promise<InitProjectResult> {
  if (!directory)
    return { projectId: null, failure: { kind: "backend", message: "no directory provided", host: API_BASE } }
  // Fail fast offline: no managed session means no request can succeed —
  // don't turn a missing `openscience login` into a network error.
  if (!(await token())) return { projectId: null, failure: { kind: "unauthenticated", host: API_BASE } }
  const existing = await resolveProjectId(directory)
  if (existing) return { projectId: existing }
  const root = await repoRoot(directory)
  const ctx = await repoContext(root)
  const key = computeDedupeKey(root, ctx.repo_url)
  const name = root.split("/").filter(Boolean).pop() || "project"

  // Primary: the projects find-or-create endpoint.
  let primaryFailure: InitProjectFailure | undefined
  try {
    const res = await atlas("POST", "/api/agent/projects", {
      title: name,
      dedupe_key: key,
      repo_url: ctx.repo_url ?? undefined,
      branch_name: ctx.branch_name ?? undefined,
    })
    if (res.ok) {
      const id = projectIdOf(await res.json())
      if (id) {
        writeProjectPin(root, id, key)
        return { projectId: id }
      }
      primaryFailure = { kind: "backend", message: "projects endpoint returned no project id", host: API_BASE }
    } else {
      primaryFailure = classifyInitFailure(res.status, await res.text().catch(() => ""))
      log.warn("projects endpoint init failed, falling back to root node", { status: res.status })
    }
  } catch (e) {
    primaryFailure = failureFromError(e)
    log.warn("projects endpoint init errored, falling back to root node", {
      error: e instanceof Error ? e.message : String(e),
    })
  }

  // Fallback: create a dedupe-tagged root node via commit-new (proven path).
  // `external_transcript_ref` carries the dedupe key so `project merge` and a
  // future resolve can rediscover this root.
  let fallbackFailure: InitProjectFailure | undefined
  try {
    const { node_id } = await commitNew({
      localID: `local-project-${stubNodeId(key)}`,
      parentIDs: [],
      title: `Project: ${name}`,
      kind: "insight",
      summary: `Atlas research-graph root for ${name}.`,
      hypothesis: "",
      content: "",
      reason: "Initialized as this repo's Atlas research-graph root.",
      context: { ...ctx, external_transcript_ref: `atlas-project-dedupe:${key}` },
    })
    if (node_id) {
      writeProjectPin(root, node_id, key)
      return { projectId: node_id }
    }
    fallbackFailure = { kind: "backend", message: "commit-new returned no node id", host: API_BASE }
  } catch (e) {
    fallbackFailure = failureFromError(e)
    log.warn("root-node init fallback failed", { error: e instanceof Error ? e.message : String(e) })
  }
  return { projectId: null, failure: pickFailure(primaryFailure, fallbackFailure) }
}

export const AtlasBridgeRoutes = lazy(() =>
  new Hono()
    .get("/nodes", async (c) => {
      try {
        const res = await atlas("GET", "/api/v1/nodes")
        if (!res.ok) return c.json(EMPTY_NODES)
        return c.json(await res.json())
      } catch {
        return c.json(EMPTY_NODES)
      }
    })
    // List the user's graphs (= root nodes). The canvas shows one graph at a
    // time, picked from this list, instead of dumping every node together.
    .get("/graphs", async (c) => {
      try {
        const res = await atlas("GET", "/api/v1/nodes?root_only=true")
        if (!res.ok) return c.json(EMPTY_NODES)
        return c.json(await res.json())
      } catch {
        return c.json(EMPTY_NODES)
      }
    })
    // Full subgraph (nodes) for a single graph/root, matching Atlas web's
    // per-graph view. Returns { anchor_node_id, root_node_ids, nodes, node_count }.
    .get("/graphs/:id/tree", async (c) => {
      const id = c.req.param("id")
      try {
        const res = await atlas("GET", `/api/v1/nodes/${encodeURIComponent(id)}/tree?projection=full`)
        if (!res.ok) return c.json({ nodes: [], node_count: 0 })
        return c.json(await res.json())
      } catch {
        return c.json({ nodes: [], node_count: 0 })
      }
    })
    .post("/nodes", async (c) => {
      const body = await c.req.json().catch(() => ({}) as any)
      const title = String(body?.title ?? "Untitled node")
      try {
        return c.json(
          await commitNew({
            localID: `local-node-${stubNodeId(title)}`,
            parentIDs: [],
            title,
            kind: "insight",
            summary: "",
            hypothesis: "",
            content: "",
            reason: "Created from OpenScience web.",
            context: await repoContext(process.cwd()),
          }),
        )
      } catch {
        return c.json({ node_id: stubNodeId(title), raw: null })
      }
    })
    // Proxy a node's real artifacts/evidence so the detail drawer shows the
    // run's outputs. Falls back to empty on auth/backend failure (like /nodes).
    .get("/nodes/:id/artifacts", async (c) => {
      const id = c.req.param("id")
      try {
        const res = await atlas("GET", `/api/v1/nodes/${encodeURIComponent(id)}/artifacts`)
        if (!res.ok) return c.json(EMPTY_ARTIFACTS)
        return c.json(await res.json())
      } catch {
        return c.json(EMPTY_ARTIFACTS)
      }
    })
    .get("/github/status", async (c) => {
      try {
        const res = await atlas("GET", "/api/v1/auth/github/status")
        return c.json(res.ok ? await res.json() : EMPTY_GITHUB)
      } catch {
        return c.json(EMPTY_GITHUB)
      }
    })
    .post("/github/refresh", async (c) => {
      try {
        const res = await atlas("POST", "/api/v1/auth/github/refresh-repos", {})
        return c.json(res.ok ? await res.json() : EMPTY_GITHUB)
      } catch {
        return c.json(EMPTY_GITHUB)
      }
    })
    .post("/github/disconnect", async (c) => {
      try {
        const res = await atlas("DELETE", "/api/v1/auth/github/disconnect")
        return c.json(res.ok ? await res.json() : EMPTY_GITHUB)
      } catch {
        return c.json(EMPTY_GITHUB)
      }
    })
    // Resolve / init the OPENED folder's project root, so the canvas scopes to
    // the folder the SPA has open (not the serve launch dir).
    .get("/project", async (c) => c.json({ project_id: await resolveProjectId(c.req.query("directory") || "") }))
    .post("/project/init", async (c) => {
      const result = await initProjectDetailed(c.req.query("directory") || "")
      // Additive shape: the SPA reads project_id; error/message/host let it
      // (and any curl-debugging user) see WHY init failed instead of a bare null.
      return c.json({
        project_id: result.projectId,
        ...(result.failure
          ? {
              error: result.failure.kind,
              status: result.failure.status,
              message: result.failure.message,
              host: result.failure.host,
            }
          : {}),
      })
    })
    // Quiet 200 for any other thesis path the SPA probes.
    .all("/*", (c) => c.json({}, 200)),
)

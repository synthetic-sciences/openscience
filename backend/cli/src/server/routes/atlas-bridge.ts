/**
 * Bridge for `/api/atlas/*` → the Atlas graph backend.
 *
 * The OpenScience web canvas (node list) and project/session sync proxy
 * through here to the Atlas REST API (`API_BASE/api/v1/*`), authenticated
 * with the user's stored `thk_` key (`OpenScience.getSession()`). This is the
 * same backend + token the CLI already uses for sync/skills/billing, and
 * the same contract the `atlas` CLI binary speaks (`nodes:list`,
 * `nodes:commit-new`, `auth/github/*`).
 *
 * Reads and mutations both preserve failure semantics. A signed-out or
 * unreachable Atlas account must not look like a legitimately empty graph.
 */
import { Hono } from "hono"
import crypto from "crypto"
import { realpathSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { lazy } from "../../util/lazy"
import { OpenScience, API_BASE } from "../../openscience"
import { Log } from "../../util/log"
import { NamedError } from "@synsci/util/error"
import { projectSelection } from "../project-selection"
import { GitOutput } from "../../util/git-output"

const log = Log.create({ service: "atlas-bridge" })

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
  return (await GitOutput.text(args, cwd)) ?? ""
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

export interface StageNodeInput {
  title: string
  directory?: string
  projectID?: string
  parentID: string
}

class StageNodeInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "StageNodeInputError"
  }
}

/** Validate the browser payload before doing any git or Atlas work. */
export function parseStageNodeInput(body: unknown): StageNodeInput {
  const value = body && typeof body === "object" ? (body as Record<string, unknown>) : {}
  const title = typeof value.title === "string" ? value.title.trim() : ""
  const directory = typeof value.directory === "string" ? value.directory.trim() : ""
  const projectID =
    typeof value.projectID === "string"
      ? value.projectID.trim()
      : typeof value.project === "string"
        ? value.project.trim()
        : ""
  const parentID = typeof value.parent_id === "string" ? value.parent_id.trim() : ""
  if (!title) throw new StageNodeInputError("title is required")
  if (!parentID) throw new StageNodeInputError("parent_id is required")
  return {
    title,
    ...(directory ? { directory } : {}),
    ...(projectID ? { projectID } : {}),
    parentID,
  }
}

/** Create a real staged child in Atlas, rooted in the repository the SPA has
 * open. The previous bridge used commit-new (so "stage" actually committed),
 * dropped the parent edge, captured process.cwd(), and fabricated an id on
 * failure. Keep the lifecycle, topology, and code context truthful instead. */
async function stageNode(input: StageNodeInput & { directory: string }): Promise<unknown> {
  const root = await repoRoot(input.directory)
  const context = await repoContext(root)
  const res = await atlas("POST", "/api/nodes/stage-create", {
    title: input.title,
    summary: "",
    content: "",
    kind: "insight",
    parent_ids: [input.parentID],
    ...context,
  })
  if (!res.ok) throw new BackendHttpError(res.status, await res.text().catch(() => ""))
  const data = await res.json()
  if (!nodeIdOf(data)) throw new Error("Synthetic Sciences returned no node id")
  return data
}

function mutationError(error: unknown): { status: number; detail: string } {
  if (error instanceof NamedError) throw error
  if (error instanceof StageNodeInputError) return { status: 400, detail: error.message }
  if (error instanceof BackendHttpError) {
    return {
      status: error.status,
      detail: backendMessage(error.body) ?? `Synthetic Sciences request failed with HTTP ${error.status}`,
    }
  }
  if (error instanceof Error && error.message === "unauthenticated") {
    return { status: 401, detail: "Sign in to Synthetic Sciences before changing the graph." }
  }
  return {
    status: 502,
    detail: error instanceof Error ? error.message : "Synthetic Sciences is unavailable",
  }
}

function readError(error: unknown): { status: number; detail: string } {
  if (error instanceof NamedError) throw error
  if (error instanceof BackendHttpError) {
    return {
      status: error.status,
      detail: backendMessage(error.body) ?? `Synthetic Sciences request failed with HTTP ${error.status}`,
    }
  }
  if (error instanceof Error && error.message === "unauthenticated") {
    return { status: 401, detail: "Sign in to Synthetic Sciences to load the graph." }
  }
  return {
    status: 502,
    detail: error instanceof Error ? error.message : "Synthetic Sciences is unavailable",
  }
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
// The projects payload keys the id as `project_id` (NOT `node_id`), so use a
// project-aware extractor — `nodeIdOf` would miss it and return null.
function projectIdOf(p: any): string | null {
  return p?.project_id ?? p?.id ?? p?.node_id ?? null
}

/** Current Atlas exposes the deduping project contract at `/api/v1/projects`.
 * Fall back to the retired `/api/agent/projects` route only when an older
 * deployment proves the v1 route is absent; real v1 errors must stay visible. */
async function projectRequest(method: "GET" | "POST", suffix = "", body?: unknown): Promise<Response> {
  const current = await atlas(method, `/api/v1/projects${suffix}`, body)
  if (current.status !== 404 && current.status !== 405) return current
  return atlas(method, `/api/agent/projects${suffix}`, body)
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

function writeProjectPin(root: string, projectId: string, key: string): boolean {
  try {
    mkdirSync(join(root, ".openscience"), { recursive: true })
    writeFileSync(
      join(root, ".openscience", "project.json"),
      JSON.stringify({ project_id: projectId, dedupe_key: key, resolved_at: new Date().toISOString() }, null, 2) + "\n",
    )
    return true
  } catch {
    // best-effort — a read-only checkout still works, just without the cache
    return false
  }
}

export interface ProjectMergeResult {
  canonical_id: string
  absorbed?: string[]
  reparented_edges?: number
  deleted_nodes?: number
  backfilled_dedupe_key?: string | null
}

/** Collapse user-selected duplicate roots through the server-owned merge
 * transaction. Current v1 is authoritative; an older Atlas deployment is
 * tried only when 404/405 proves that route family is absent. */
export async function mergeProjectRoots(canonicalId: string, duplicateIds: string[]): Promise<ProjectMergeResult> {
  const res = await projectRequest("POST", "/merge", {
    canonical_id: canonicalId,
    duplicate_ids: duplicateIds,
  })
  if (!res.ok) throw new BackendHttpError(res.status, await res.text().catch(() => ""))
  const result = (await res.json()) as Partial<ProjectMergeResult>
  if (result.canonical_id !== canonicalId) {
    throw new Error("projects merge endpoint returned the wrong canonical project id")
  }
  return result as ProjectMergeResult
}

/** Merge first, then persist the local repo pin. A failed/ambiguous server
 * response must never make a local pin conceal roots that were not merged. */
export async function mergeProjectRootsAndPin(
  root: string,
  key: string,
  canonicalId: string,
  duplicateIds: string[],
): Promise<{ merge: ProjectMergeResult; pinned: boolean }> {
  const merge = await mergeProjectRoots(canonicalId, duplicateIds)
  return { merge, pinned: writeProjectPin(root, canonicalId, key) }
}

// Find-only: the repo's dedupe-key → its Atlas project root id (null only when
// the backend confirms it is unlinked). Honours the local pin first, then the API; caches an API
// hit back to the pin. The directory is the folder the SPA has open (query
// param), NOT the serve launch dir.
async function resolveProjectId(directory: string): Promise<string | null> {
  if (!directory) return null
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
  const res = await projectRequest("GET", `?dedupe_key=${encodeURIComponent(key)}`)
  if (!res.ok) throw new BackendHttpError(res.status, await res.text().catch(() => ""))
  const data = await res.json()
  const existing = Array.isArray(data?.projects) ? data.projects[0] : undefined
  const id = projectIdOf(existing)
  if (id) writeProjectPin(root, id, key)
  return id
}

// ── graph-init failure classification ────────────────────────────────────
// `project init` used to collapse EVERY failure (no session, DNS failure,
// revoked key, access rejection, backend 4xx/5xx) into `null` → one misleading
// "check login" message. Classify instead, so every local caller can tell the
// user the actual fix.

export type InitProjectFailureKind =
  | "unauthenticated" // no session, or the backend rejected the key (401/403)
  | "unreachable" // network/DNS error or 5xx — the service couldn't be reached
  | "access" // authenticated, but the service denied graph access (402 / legacy plan-coded 4xx)
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

/** Classify a non-2xx backend answer. Mirrors the compatibility contract:
 * 401/403 = key rejected; 402 or a legacy plan-coded answer = account access
 * denied; 5xx = service not reachable/healthy; anything else passes through. */
export function classifyInitFailure(status: number, body: string): InitProjectFailure {
  const message = backendMessage(body)
  const host = API_BASE
  if (status === 401 || status === 403) return { kind: "unauthenticated", status, message, host }
  const legacyAccessCode = /plan_quota_exhausted|collaboration_gated/.test(body)
  const legacyAccessWording = /\b(plan|subscription)\b/i.test(message ?? "")
  if (status === 402 || (status >= 400 && status < 500 && (legacyAccessCode || legacyAccessWording)))
    return { kind: "access", status, host }
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

// Find-or-create the repo's project root — the "initialize graph" action, shared
// by the web bridge (POST /project/init) and the `openscience project init` CLI so
// both take the exact same, server-atomic dedupe path. Project creation must
// never fall back to generic node creation: a lost response there could mint a
// duplicate root because node commit does not own the dedupe constraint.
// Always writes the pin on success. Exported for the CLI command.
export async function initProject(directory: string): Promise<string | null> {
  return (await initProjectDetailed(directory)).projectId
}

/** Like initProject, but never throws and reports WHY init failed so callers
 *  can print an actionable message instead of a blanket "check login". */
export async function initProjectDetailed(directory: string): Promise<InitProjectResult> {
  if (!directory)
    return { projectId: null, failure: { kind: "backend", message: "no directory provided", host: API_BASE } }
  // Fail fast offline: no managed session means no request can succeed —
  // don't turn a missing `openscience login` into a network error.
  if (!(await token())) return { projectId: null, failure: { kind: "unauthenticated", host: API_BASE } }
  // Resolution is a useful fast path, not a prerequisite for the idempotent
  // find-or-create call below. Preserve its failure for logs, then keep going:
  // a temporarily unavailable GET endpoint must not crash this never-throw API.
  try {
    const existing = await resolveProjectId(directory)
    if (existing) return { projectId: existing }
  } catch (e) {
    log.warn("project lookup failed before init, continuing with find-or-create", {
      error: e instanceof Error ? e.message : String(e),
    })
  }
  const root = await repoRoot(directory)
  const ctx = await repoContext(root)
  const key = computeDedupeKey(root, ctx.repo_url)
  const name = root.split("/").filter(Boolean).pop() || "project"

  // The projects endpoint is the sole find-or-create authority.
  try {
    const res = await projectRequest("POST", "", {
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
      return {
        projectId: null,
        failure: { kind: "backend", message: "projects endpoint returned no project id", host: API_BASE },
      }
    } else {
      const failure = classifyInitFailure(res.status, await res.text().catch(() => ""))
      log.warn("projects endpoint init failed", { status: res.status })
      return { projectId: null, failure }
    }
  } catch (e) {
    const failure = failureFromError(e)
    log.warn("projects endpoint init errored", {
      error: e instanceof Error ? e.message : String(e),
    })
    return { projectId: null, failure }
  }
}

export const AtlasBridgeRoutes = lazy(() =>
  new Hono()
    .get("/nodes", async (c) => {
      try {
        const res = await atlas("GET", "/api/v1/nodes")
        if (!res.ok) throw new BackendHttpError(res.status, await res.text().catch(() => ""))
        return c.json(await res.json())
      } catch (error) {
        const failure = readError(error)
        return c.json({ detail: failure.detail }, failure.status as any)
      }
    })
    // List the user's graphs (= root nodes). The canvas shows one graph at a
    // time, picked from this list, instead of dumping every node together.
    .get("/graphs", async (c) => {
      try {
        const res = await atlas("GET", "/api/v1/nodes?root_only=true")
        if (!res.ok) throw new BackendHttpError(res.status, await res.text().catch(() => ""))
        return c.json(await res.json())
      } catch (error) {
        const failure = readError(error)
        return c.json({ detail: failure.detail }, failure.status as any)
      }
    })
    // Full subgraph (nodes) for a single graph/root, matching Atlas web's
    // per-graph view. Returns { anchor_node_id, root_node_ids, nodes, node_count }.
    .get("/graphs/:id/tree", async (c) => {
      const id = c.req.param("id")
      try {
        const res = await atlas("GET", `/api/v1/nodes/${encodeURIComponent(id)}/tree?projection=full`)
        if (!res.ok) throw new BackendHttpError(res.status, await res.text().catch(() => ""))
        return c.json(await res.json())
      } catch (error) {
        const failure = readError(error)
        return c.json({ detail: failure.detail }, failure.status as any)
      }
    })
    .post("/nodes", async (c) => {
      try {
        const input = parseStageNodeInput(await c.req.json().catch(() => null))
        const selected = await projectSelection(c, {
          projectID: input.projectID,
          directory: input.directory,
        })
        if (!selected.directory) throw new StageNodeInputError("directory is required")
        return c.json(
          await stageNode({
            ...input,
            directory: selected.directory,
          }),
          201,
        )
      } catch (error) {
        const failure = mutationError(error)
        return c.json({ detail: failure.detail }, failure.status as any)
      }
    })
    // Proxy a node's real artifacts/evidence so the detail drawer shows the
    // run's outputs without conflating a failed request with "no artifacts".
    .get("/nodes/:id/artifacts", async (c) => {
      const id = c.req.param("id")
      try {
        const res = await atlas("GET", `/api/v1/nodes/${encodeURIComponent(id)}/artifacts`)
        if (!res.ok) throw new BackendHttpError(res.status, await res.text().catch(() => ""))
        return c.json(await res.json())
      } catch (error) {
        const failure = readError(error)
        return c.json({ detail: failure.detail }, failure.status as any)
      }
    })
    .get("/github/status", async (c) => {
      try {
        const res = await atlas("GET", "/api/v1/auth/github/status")
        if (!res.ok) throw new BackendHttpError(res.status, await res.text().catch(() => ""))
        return c.json(await res.json())
      } catch (error) {
        const failure = readError(error)
        return c.json({ detail: failure.detail }, failure.status as any)
      }
    })
    .post("/github/refresh", async (c) => {
      try {
        const res = await atlas("POST", "/api/v1/auth/github/refresh-repos", {})
        if (!res.ok) throw new BackendHttpError(res.status, await res.text().catch(() => ""))
        return c.json(await res.json())
      } catch (error) {
        const failure = mutationError(error)
        return c.json({ detail: failure.detail }, failure.status as any)
      }
    })
    .post("/github/disconnect", async (c) => {
      try {
        const res = await atlas("DELETE", "/api/v1/auth/github/disconnect")
        if (!res.ok) throw new BackendHttpError(res.status, await res.text().catch(() => ""))
        return c.json(await res.json())
      } catch (error) {
        const failure = mutationError(error)
        return c.json({ detail: failure.detail }, failure.status as any)
      }
    })
    // Resolve / init the OPENED folder's project root, so the canvas scopes to
    // the folder the SPA has open (not the serve launch dir).
    .get("/project", async (c) => {
      try {
        const selected = await projectSelection(c)
        return c.json({ project_id: await resolveProjectId(selected.directory ?? "") })
      } catch (error) {
        const failure = readError(error)
        return c.json({ detail: failure.detail }, failure.status as any)
      }
    })
    .post("/project/init", async (c) => {
      const selected = await projectSelection(c)
      const result = await initProjectDetailed(selected.directory ?? "")
      const payload = {
        project_id: result.projectId,
        ...(result.failure
          ? {
              error: result.failure.kind,
              status: result.failure.status,
              message: result.failure.message,
              host: result.failure.host,
            }
          : {}),
      }
      if (!result.failure) return c.json(payload)

      const status =
        result.failure.status ??
        (result.failure.kind === "unauthenticated"
          ? 401
          : result.failure.kind === "access"
            ? 402
            : result.failure.kind === "backend" && result.failure.message === "no directory provided"
              ? 400
              : 502)
      const detail =
        result.failure.message ??
        (result.failure.kind === "unauthenticated"
          ? "Sign in to Synthetic Sciences before initializing the project graph."
          : result.failure.kind === "access"
            ? "This account does not currently have access to initialize the project graph."
            : result.failure.kind === "unreachable"
              ? `Synthetic Sciences is unavailable at ${result.failure.host}.`
              : "Synthetic Sciences could not initialize the project graph.")
      return c.json({ ...payload, detail }, status as any)
    })
    .all("/*", (c) => c.json({ detail: "Synthetic Sciences bridge route not found" }, 404)),
)

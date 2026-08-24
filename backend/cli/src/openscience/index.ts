import path from "path"
import os from "os"
import fs from "fs/promises"
import { existsSync, readFileSync } from "fs"
import { randomUUID, createHash } from "crypto"
import { Global } from "../global"
import { DataRootBarrier } from "../global/data-root-barrier"
import { Log } from "../util/log"
import { Lock } from "../util/lock"
import { Env } from "../env"
import { Auth } from "../auth"
import {
  isSyncedEnvAllowed,
  BYOK_LLM_ENV_KEYS,
  SYNCED_SERVICE_ENV_KEYS,
  managedOpenRouterBaseURL,
} from "./synced-env-policy"
import { isAtlasManagedKey } from "../credentials/managed-key"
import { BILLING_URL, DEFAULT_MANAGED_API_BASE, MANAGED_API_BASE } from "../endpoints"
import { CredentialLifecycle } from "../credentials/lifecycle"
import { ToolOutputPath } from "../tool/tool-output-path"
import { GlobalBus } from "../bus/global"
import { Event as ServerEvent } from "../server/event"

const log = Log.create({ service: "openscience" })

// Synthetic Sciences is the unified backend for OpenScience auth, BYOK, and
// billing. The base URL resolves through the shared endpoints module (neutral public
// default + SYNSC_API_BASE / MANAGED_API_BASE / ATLAS_BASE_URL override), so
// self-hosters and dev stacks can repoint the client without code changes.
const DEFAULT_API_BASE = DEFAULT_MANAGED_API_BASE
export const API_BASE = MANAGED_API_BASE

// Make it loud when the CLI is talking to a non-prod backend so we
// don't accidentally test against prod or vice versa. The visible hint
// uses UI.Style so it (a) inherits the project-wide ANSI color gate
// (NO_COLOR / TERM=dumb / piped output → plain text) and (b) only
// renders when both stdout AND stderr are TTYs. Piping to a log file
// no longer drops a one-line dev banner into structured output.
// User-facing URL the CLI prints during `openscience login`. Defaults
// to the Synthetic Sciences dashboard's /cli route — wallet, key management,
// and account controls live there. SYNSC_AUTH_URL overrides (e.g. point at a
// staging frontend or the old auth.syntheticsciences.ai surface).
const VERIFICATION_PAGE = process.env.SYNSC_AUTH_URL?.replace(/\/+$/, "") || "https://app.syntheticsciences.ai/cli"

const syncedSecretValues = new Map<string, string>()

// User-owned (BYOK) secret values — api keys from auth.json and provider env
// vars the user set in their own shell. Cached synchronously so redactSecrets()
// (a hot path in bash output streaming) can mask them without an async read.
const byokSecretValues = new Set<string>()
const TOKEN_SECRET_PATTERNS = [
  /\b(?:thk[_-]|sk-|sk_|gsk_|hf_|nvapi-|ghp_|gho_|ghu_|ghs_|github_pat_|xox[baprs]-)[A-Za-z0-9._-]{8,}\b/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
]
const QUOTED_SECRET =
  /(\b(?:[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|authorization)\b\s*[:=]\s*)(["'])(.*?)\2/gi
const BARE_SECRET =
  /(\b(?:[A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)|api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password|authorization)\b\s*[:=]\s*)((?!Bearer\b)[^\s"'[,;}\]]{4,})/gi
const BEARER_SECRET = /(\bBearer\s+)[A-Za-z0-9._~+/-]{4,}=*/gi
const JWT_SECRET = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g
const PRIVATE_KEY_SECRET = /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/g
const SECRET_FIELD =
  /(^|[_-])(api[_-]?key|private[_-]?key|signing[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passphrase|credential|authorization|cookie|deletion[_-]?proof)($|[_-])|^(apiKey|privateKey|signingKey|accessToken|refreshToken|authToken|clientSecret|secretKey|deletionProof|access|refresh|key)$/i

function isManagedAtlasKey(value: string): boolean {
  return isAtlasManagedKey(value)
}

function isManagedOpenRouterProxy(value: string | undefined): boolean {
  if (!value) return false
  try {
    const url = new URL(value)
    const route = "/api/llm/proxy/openrouter"
    return url.pathname === route || url.pathname.endsWith(route) || url.pathname.includes(`${route}/`)
  } catch {
    return false
  }
}

function getSyncedConfigDir(): string {
  const config = process.env.OPENSCIENCE_CONFIG_DIR?.trim()
  if (config) return path.resolve(config)
  // Use XDG config dir (user-writable) for synced config from dashboard
  // This avoids needing root/admin permissions unlike /Library/Application Support
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(xdg, "openscience")
}

const syncedGcpFilename = "atlas-gcp-service-account.json"

// Seed the synced-secret set from the on-disk snapshot at import. preload-env.ts
// replays synced-env.json into process.env at boot but never seeded this set, so
// on a fresh process where no in-process sync runs (the common steady state, when
// the dashboard version is unchanged) the set stayed empty — and a disk-replayed
// synced secret that isn't a thk_ value was neither stripped from subprocess env
// nor masked by redactSecrets(). Synchronous + best-effort so the hot sync paths
// (redactSecrets) have the values available without an async read.
;(() => {
  try {
    const raw = readFileSync(path.join(getSyncedConfigDir(), "synced-env.json"), "utf-8")
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string" && value) syncedSecretValues.set(key, value)
      }
    }
  } catch {
    /* no snapshot on disk — nothing to seed */
  }
})()

/** Env vars that are safe to pass to subprocesses */
const SAFE_ENV_PREFIXES = ["PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "LC_", "TMPDIR", "XDG_", "EDITOR", "VISUAL"]
const KERNEL_RUNTIME_KEYS = new Set([
  "TMP",
  "TEMP",
  "PYTHONPATH",
  "PYTHONHOME",
  "VIRTUAL_ENV",
  "CONDA_PREFIX",
  "CONDA_DEFAULT_ENV",
  "R_HOME",
  "R_LIBS",
  "R_LIBS_USER",
  "LD_LIBRARY_PATH",
  "DYLD_LIBRARY_PATH",
  "SYSTEMROOT",
  "WINDIR",
  "PATHEXT",
  "COMSPEC",
])
const SAFE_SYNCED_KEYS = new Set([
  ...BYOK_LLM_ENV_KEYS,
  ...SYNCED_SERVICE_ENV_KEYS,
  // Misc CLI runtime markers
  "OPENSCIENCE_RUNTIME",
])

// Modal credentials belong to its trusted adapter and never enter
// agent-controlled shells, including when supplied by an explicit export.
const CONTROL_PLANE_ENV_KEYS = new Set(["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"])

/**
 * Persistent CLI auth session.
 *
 * Holds the long-lived ``thk_*`` API key issued by the Atlas device-code
 * flow. Atlas API keys carry a 1-year TTL and are revoked by deletion
 * rather than expiry, so we don't track refresh tokens or expiry locally
 * — a 401 on any request signals "key revoked or expired, re-auth".
 */
interface OpenScienceSession {
  /** Atlas-issued ``thk_<uuid>.<secret>`` Bearer token. */
  api_key: string
  /** Atlas user_id (UUID). Stored for diagnostics; not used for auth. */
  user_id: string
  /** Friendly device label this session was registered under. */
  device_name?: string
  /** Last-seen ``/api/cli/sync/version`` value. Background refresh fires
   *  when the server returns a higher value. */
  cached_v?: number
  /** Epoch-ms timestamp of the last version probe. Used to gate rapid-
   *  fire probes to at most once per VERSION_PROBE_TTL_MS. */
  last_check_ts?: number
}

type SyncedServiceReason =
  | "missing_key"
  | "no_credits"
  | "ineligible_plan"
  | "proxy_disabled"
  | "managed_key_unconfigured"
  | "managed_via_openrouter"

interface SyncedService {
  connected: boolean
  /** Present only when `connected` is false. Explains why the provider
   *  could not be connected so the CLI can print an actionable message. */
  reason?: SyncedServiceReason
  env?: Record<string, string>
  metadata?: Record<string, string>
}

interface SyncResponse {
  user: {
    user_id?: string
    email?: string | null
    display_name?: string | null
    github_username?: string | null
    subscription_status?: string | null
    subscription_plan?: string | null
  }
  services: Record<string, SyncedService>
  config?: {
    enabled_providers?: string[]
    provider?: Record<string, { whitelist?: string[] }>
    model?: string
  }
}

export type AccountProfile = SyncResponse["user"]

export interface ResearchEntitlements {
  plan?: string | null
  catalog_version?: string | null
  status?: string | null
  hosted_research?: { enabled?: boolean; concurrency?: number }
  managed_search?: {
    enabled?: boolean
    available?: boolean
    limit?: number
    used?: number
    reserved?: number
    remaining?: number
    reset_at?: string | null
    allowance?: {
      limit?: number
      used?: number
      reserved?: number
      remaining?: number
      reset_at?: string | null
    }
  }
  capabilities?: {
    proxy_settlement_authoritative?: boolean
    cli_usage_financial?: boolean
    telemetry_schema_version?: number
  }
}

/** Accept both the initial Synthetic Sciences entitlement shape (`available` plus a
 * nested `allowance`) and the rollout aliases (`enabled` plus flat counts).
 * Consumers see one flat contract while mixed-version clients and servers
 * coexist. */
export function normalizeResearchEntitlements(value: ResearchEntitlements): ResearchEntitlements {
  const search = value.managed_search
  if (!search) return value
  return {
    ...value,
    managed_search: {
      ...(search.allowance ?? {}),
      ...search,
      // During rollout some backend builds used `enabled` for provider
      // readiness, even on Free. `available` is the account-level decision
      // whenever present; only older responses fall back to `enabled`.
      enabled: search.available ?? search.enabled ?? false,
    },
  }
}

export interface ResearchSearchInput {
  query: string
  source: "web" | "research" | "news" | "developer"
  mode: "fast" | "balanced" | "deep"
  limit: number
  content: "snippets" | "top"
  include_domains?: string[]
  exclude_domains?: string[]
  published_after?: string
  published_before?: string
}

/**
 * Returns an actionable one-liner for a disconnected provider based on the
 * reason code returned by the backend sync endpoint.
 */
function describeReason(provider: string, reason: SyncedServiceReason | undefined): string {
  switch (reason) {
    case "missing_key":
      return `${provider}: no account is connected — add one in Settings → Models or choose Credits.`
    case "no_credits":
      return `${provider}: Credits are empty - top up at https://app.syntheticsciences.ai/billing.`
    case "ineligible_plan":
      return `${provider}: refresh your account and reconnect the key — provider accounts never require Ace.`
    case "proxy_disabled":
      return `${provider}: Ace is disabled on this deployment — connect a provider account instead.`
    case "managed_key_unconfigured":
      return `${provider}: Ace is unavailable on this deployment — connect a provider account instead.`
    case "managed_via_openrouter":
      return `${provider}: wallet access to ${provider} models routes through the openrouter provider — pick them there, or add your own ${provider} key for direct access.`
    default:
      return `${provider}: not connected.`
  }
}

/**
 * Thrown when the backend rejects a usage report because the user is
 * out of wallet credits. Halts
 * the session so the agent loop doesn't keep racking up calls the
 * user can't pay for. Caught at the session boundary; surfaced to the
 * user as "Insufficient credits - top up at app.syntheticsciences.ai/billing".
 */
export class InsufficientCreditsError extends Error {
  constructor(message: string = `Credits are empty. Add credits at ${BILLING_URL} or switch back to your own keys.`) {
    super(message)
    this.name = "InsufficientCreditsError"
  }
}

export namespace OpenScience {
  let cachedProfile: AccountProfile | null | undefined
  let cachedEntitlements: ResearchEntitlements | undefined
  let cachedEntitlementsAt = 0
  let cachedEntitlementsAccount: string | undefined
  let cachedEntitlementsFailureAt = 0
  let cachedEntitlementsFailureAccount: string | undefined
  let entitlementsGeneration = 0
  let entitlementsRequest: { account: string; promise: Promise<ResearchEntitlements | null> } | undefined
  const ENTITLEMENTS_CACHE_TTL_MS = 30_000
  const ENTITLEMENTS_FAILURE_TTL_MS = 30_000
  const ENTITLEMENTS_FETCH_TIMEOUT_MS = 1_500
  /** Report a non-production API override after the CLI has initialized its
   * log sink. Keeping this out of module initialization is important: runtime
   * launchers and library consumers import OpenScience inside child processes,
   * and import-time diagnostics would become command stderr or provenance. */
  export function reportApiBaseOverride(): void {
    if (API_BASE === DEFAULT_API_BASE) return
    log.info("openscience.api_base.override", { api_base: API_BASE })
    if (!process.stderr.isTTY) return
    const { UI } = require("../cli/ui") as typeof import("../cli/ui")
    process.stderr.write(
      `${UI.Style.TEXT_DIM}[openscience] API base: ${API_BASE} (override via SYNSC_API_BASE)${UI.Style.TEXT_NORMAL}\n`,
    )
  }

  const filepath = path.join(Global.Path.data, "openscience-session.json")

  /** Friendly device label sent to the backend. Surfaced in the
   *  user's Devices list so they can identify which machine each row
   *  belongs to. */
  export function deviceName(): string {
    const host = (() => {
      try {
        return os.hostname().split(".")[0]
      } catch {
        return "device"
      }
    })()
    return `openscience · ${process.platform} · ${host}`
  }

  // Bound every Atlas client call. A slow/unresponsive backend must never hang
  // the caller: the per-command sync-version probe and `openscience project init`
  // both go through Atlas fetches, and with the agent's bash tool also unbounded a
  // hang wedged whole sessions for >60 min. Overridable via OPENSCIENCE_ATLAS_TIMEOUT_MS.
  const ATLAS_FETCH_TIMEOUT_MS = Number(process.env["OPENSCIENCE_ATLAS_TIMEOUT_MS"]) || 60_000
  // Skill index/content fetches run on the GET /skill request path, and each only
  // *enriches* a list that also comes from disk cache + bundled skills. A slow or
  // unreachable backend must degrade fast (fall back to cached/empty) instead of
  // wedging the request for the full Atlas timeout — the reporter in #138 saw a
  // single /skill take 62s because these inherited the 60s default. Bound tighter.
  const SKILL_FETCH_TIMEOUT_MS = Number(process.env["OPENSCIENCE_SKILL_TIMEOUT_MS"]) || 8_000
  function atlasFetch(input: string, init: RequestInit = {}, timeoutMs = ATLAS_FETCH_TIMEOUT_MS): Promise<Response> {
    // Combine (don't replace) a caller's signal with the timeout, so passing an
    // abort signal never silently drops the hang guard this function exists for.
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
    return fetch(input, { ...init, signal })
  }

  let rejectedSessionClear: { apiKey: string; promise: Promise<void> } | undefined

  /** Clear a revoked account exactly once, but only if the rejected request
   * still belongs to the active local session. A late 401 from account A must
   * never sign out a newly authenticated account B. */
  async function clearRejectedSession(apiKey: string): Promise<void> {
    if (rejectedSessionClear?.apiKey === apiKey) return rejectedSessionClear.promise
    const promise = (async () => {
      // The match is checked inside the credential mutation lease. Checking it
      // here and calling an unconditional clear created a TOCTOU window where
      // a newly saved account could be deleted by an old request's late 401.
      const cleared = await clearSession(apiKey)
      if (!cleared) return
      log.info("authenticated control-plane request rejected the local session; clearing")
      // clearSession invalidates account/search state and publishes the
      // cross-process credential revision. Provider state is process-local, so
      // drop it explicitly before telling the workspace to remount its gate.
      const { Provider } = await import("../provider/provider")
      Provider.invalidate()
      GlobalBus.emit("event", {
        directory: "global",
        payload: { type: ServerEvent.Disposed.type, properties: {} },
      })
    })()
    rejectedSessionClear = { apiKey, promise }
    try {
      await promise
    } finally {
      if (rejectedSessionClear?.promise === promise) rejectedSessionClear = undefined
    }
  }

  /** Authenticated Atlas control-plane request. A definitive 401 means this
   * device key was revoked or expired, so clear only that matching session.
   * Network failures, 5xx responses, and 403 policy/consent responses remain
   * fail-open and leave the local session usable offline. */
  async function authenticatedAtlasFetch(
    session: OpenScienceSession,
    input: string,
    init: RequestInit = {},
    timeoutMs = ATLAS_FETCH_TIMEOUT_MS,
  ): Promise<Response> {
    const headers = new Headers(init.headers)
    headers.set("Authorization", `Bearer ${session.api_key}`)
    const response = await atlasFetch(input, { ...init, headers }, timeoutMs)
    if (response.status === 401) await clearRejectedSession(session.api_key)
    else await retryPendingTelemetryConsent().catch(() => false)
    return response
  }

  export async function getSession(): Promise<OpenScienceSession | null> {
    // A missing file is a genuine logout → null, silently. Distinguish it from a
    // read/parse error below so a torn file / EMFILE / permission blip isn't
    // silently mis-read as "signed out" (which flips the billing gate to BYOK
    // and diverts usage to the unauthenticated queue for an authed user).
    if (!existsSync(filepath)) return null
    try {
      const file = Bun.file(filepath)
      const data = (await file.json()) as Partial<OpenScienceSession> & { access_token?: string }
      // Forward-compat: pre-atlas sessions stored the token under
      // ``access_token``. Those tokens are no longer valid against the
      // new backend — drop them so the next request triggers re-auth.
      if (!data.api_key) {
        if (data.access_token) {
          log.info("dropping legacy session (pre-atlas token)")
        }
        return null
      }
      return {
        api_key: data.api_key,
        user_id: data.user_id || "",
        device_name: data.device_name,
        // Sync bookkeeping. Dropping these made refreshIfStale's TTL and
        // version dedupe dead code: every message fired a version probe
        // plus a full background sync, and updateSession (getSession +
        // spread + save) erased whichever field it wasn't patching.
        cached_v: data.cached_v,
        last_check_ts: data.last_check_ts,
      }
    } catch (e) {
      // The file exists but couldn't be read/parsed — NOT a logout. Return null
      // so callers stay simple, but surface it so the transient failure is
      // diagnosable rather than a silent, mis-billed "signed out".
      log.warn("could not read session file (treating as signed out)", {
        error: e instanceof Error ? e.message : String(e),
      })
      return null
    }
  }

  /**
   * Read the account summary without applying the credential payload returned
   * by Atlas. Settings uses this for display only. Calling syncServices() from
   * a GET handler published a credential revision and disposed every active
   * project instance merely because General was opened.
   */
  export async function getProfile(): Promise<AccountProfile | null> {
    const session = await getSession()
    if (!session) return null
    return authenticatedAtlasFetch(session, `${API_BASE}/api/cli/sync`, {
      headers: { Authorization: `Bearer ${session.api_key}` },
    })
      .then(async (response) => {
        if (!response.ok) return null
        const data = (await response.json()) as SyncResponse
        cachedProfile = data.user
        return data.user
      })
      .catch((error) => {
        log.warn("account profile read failed", { error: error instanceof Error ? error.message : String(error) })
        return null
      })
  }

  async function writeSession(session: OpenScienceSession) {
    // Atomic temp+rename so a crash or a concurrent reader never sees a torn
    // session file (which getSession would mis-read as a logout).
    await atomicWrite(filepath, JSON.stringify(session, null, 2), { mode: 0o600 })
  }

  export async function saveSession(session: OpenScienceSession) {
    cachedProfile = undefined
    invalidateResearchEntitlements()
    await CredentialLifecycle.mutate("managed-session.set", async () => {
      const previous = await getSession()
      const replacingCredential = previous?.api_key !== session.api_key
      const changingSubject = previous?.user_id !== session.user_id
      if (previous && (replacingCredential || changingSubject)) {
        // Give account A's still-present credential the first chance to finish
        // its opt-out. If it is offline or revoked, the telemetry state already
        // holds a fixed-target deletion capability, so replacing the account
        // cannot orphan the purge or replay it against account B.
        await retryPendingTelemetryConsent().catch(() => false)
      }
      if (replacingCredential) {
        // A pasted key can replace an account without an explicit logout. Tear
        // down account A's complete credential snapshot before publishing B's
        // session, so a failed B sync can never fall back to A's keys/files/env.
        await clearSyncedCredentialArtifacts()
        await dropUsageQueue()
        await resetTelemetryAccountSession()
      } else if (previous && changingSubject && !(await preserveTelemetryConsentForSession(session))) {
        // A legacy key-only session and its canonical user-id session are the
        // same account. Copy the privacy setting before changing the durable
        // identity so a crash cannot silently restore the default-on state.
        throw new Error("OpenScience could not safely preserve the current data-use setting. Try again.")
      }
      await writeSession(session)
    })
    // Authentication is the first point at which cloud trace sharing can be
    // attributed safely. Initialize the default-on account setting after the
    // durable device credential is present; backend availability never blocks
    // login and the trace client will sync when connectivity returns.
    await import("@/telemetry/outbound")
      .then(({ OutboundTelemetry }) => OutboundTelemetry.initializeAccount())
      .catch((error) => log.warn("could not initialize account trace state", { error: String(error) }))
  }

  /** Merge-update the persisted session. Fetches current session, spreads
   *  the patch on top, and writes back. No-ops when unauthenticated. Serialized
   *  under a lock so two concurrent patches (e.g. an interactive last_check_ts
   *  update racing a background cached_v update) can't lose each other's field
   *  in the read-modify-write. */
  async function updateSession(patch: Partial<OpenScienceSession>): Promise<void> {
    await CredentialLifecycle.serialized(async () => {
      using _ = await Lock.write(filepath)
      const session = await getSession()
      if (!session) return
      // Sync bookkeeping is not credential material; publishing a credential
      // revision for every TTL timestamp would unnecessarily stop live children.
      await atomicWrite(filepath, JSON.stringify({ ...session, ...patch }, null, 2), { mode: 0o600 })
    })
  }

  /** TTL gate for the cheap version probe. */
  const VERSION_PROBE_TTL_MS = 10_000
  let pendingRefresh: Promise<void> | undefined

  /**
   * Fire-and-forget BYOK refresh triggered at most once per
   * VERSION_PROBE_TTL_MS per process. When the server-side sync version
   * has changed since the last probe, runs `syncServices()` in the
   * background so the new env vars land for the NEXT user message while
   * the current one continues with the existing provider config.
   */
  export async function refreshIfStale(): Promise<void> {
    const session = await getSession()
    if (!session) return

    const now = Date.now()
    const last = session.last_check_ts ?? 0
    if (now - last < VERSION_PROBE_TTL_MS) return

    let v: number | null = null
    try {
      const res = await authenticatedAtlasFetch(session, `${API_BASE}/api/cli/sync/version`, {
        headers: { Authorization: `Bearer ${session.api_key}` },
      })
      if (!res.ok) return // fail open — keep current env
      const body = await res.json()
      // Coerce numeric strings too: a backend/proxy that returns {"v":"5"} would
      // otherwise leave v=null forever, so cached_v never updates and the CLI
      // keeps deferring the background sync for the TTL — dashboard changes never
      // land, with no error surfaced.
      const raw = body?.v
      const num = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN
      v = Number.isFinite(num) ? num : null
    } catch {
      return // network failure → use current env, retry next message
    }

    // Always stamp the probe time so we don't hammer the server.
    await updateSession({ last_check_ts: now })
    if (v === null) return
    if (v === session.cached_v) return

    // Version changed — fire full sync in background. Current message
    // continues with the existing env; new env applies to the NEXT message.
    void (async () => {
      try {
        // The current turn has already constructed its provider SDK from the
        // previous snapshot. Publishing the cross-process revision is still
        // required, but reconciling it locally would run the instance revoker,
        // dispose SessionPrompt state, and abort the turn that scheduled this
        // refresh. Apply the new snapshot for the next turn without revoking
        // this process's in-flight work.
        await syncServices({ reconcileLocal: false })
        await updateSession({ cached_v: v as number })
        // Force provider SDK to rebuild from the new env on the next call.
        const provider = await import("../provider/provider")
        provider.Provider.invalidate?.()
      } catch (e) {
        log.warn("background BYOK refresh failed", { error: e instanceof Error ? e.message : String(e) })
      }
    })()
  }

  /** Start the best-effort version probe without putting its network and disk
   *  latency on the provider request's critical path. Concurrent sessions share
   *  the same probe; refreshIfStale's persisted TTL handles later calls. */
  export function scheduleRefresh(): Promise<void> {
    if (pendingRefresh) return pendingRefresh
    const refresh = refreshIfStale().catch((error) => {
      log.warn("scheduled BYOK refresh failed", { error: error instanceof Error ? error.message : String(error) })
    })
    const request = refresh.then(() => {
      if (pendingRefresh === request) pendingRefresh = undefined
    })
    pendingRefresh = request
    return request
  }

  /** Read the on-disk synced-env snapshot (what preload-env.ts replayed into
   *  process.env at boot). Returns an empty map when missing or corrupt. */
  async function readSyncedSnapshot(): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    try {
      const raw = await fs.readFile(path.join(getSyncedConfigDir(), "synced-env.json"), "utf-8")
      const parsed: unknown = JSON.parse(raw)
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return result
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string") result.set(key, value)
      }
    } catch {}
    return result
  }

  /** Drop a synced env var from the live process, but only when its current
   *  value is still the one sync injected — an explicit shell export wins. */
  function unsetSyncedVar(key: string, value: string) {
    if (process.env[key] !== value) return
    delete process.env[key]
    try {
      Env.remove(key)
    } catch {
      /* Instance not initialized — process.env delete is enough */
    }
  }

  /** Reconcile this process with the credential snapshot another server wrote. */
  export async function reloadSyncedEnv(): Promise<void> {
    const fresh = await readSyncedSnapshot()
    const previous = new Map(syncedSecretValues)
    for (const [key, value] of previous.entries()) {
      if (fresh.has(key)) continue
      unsetSyncedVar(key, value)
    }
    syncedSecretValues.clear()
    for (const [key, value] of fresh.entries()) {
      if (!isSyncedEnvAllowed(key, value)) continue
      const current = process.env[key]
      const ownsSlot = !current || previous.get(key) === current || current === value
      if (ownsSlot) {
        process.env[key] = value
        try {
          Env.set(key, value)
        } catch {
          /* Instance not initialized */
        }
      }
      syncedSecretValues.set(key, value)
    }
  }

  /** Whether one live environment slot came from the latest account sync.
   * Provider discovery uses this to keep dashboard credentials distinct from
   * unrelated variables inherited from the launching shell. */
  export function isSyncedEnv(key: string, value: string): boolean {
    return syncedSecretValues.get(key) === value
  }

  /** Delete queued usage rows. They were produced under the signed-out
   *  account's key; flushing them after a different account logs in would
   *  bill that account for someone else's usage. */
  async function dropUsageQueue(): Promise<void> {
    try {
      const raw = await fs.readFile(pendingQueuePath, "utf-8")
      const rows = raw.split("\n").filter(Boolean).length
      await fs.unlink(pendingQueuePath)
      if (rows) log.info("dropped queued usage on sign-out so it cannot bill a different account", { rows })
    } catch {
      /* no queue — nothing to drop */
    }
  }

  /** Purge account-scoped traces and rotate their local installation identity.
   * This is deliberately dynamic to keep the OpenScience <-> telemetry module
   * cycle lazy at startup. */
  async function resetTelemetryAccountSession(): Promise<void> {
    await import("@/telemetry/outbound").then(({ OutboundTelemetry }) => OutboundTelemetry.resetAccountSession())
  }

  /** Retry a pending account-bound consent write while the matching session
   * credential is still active. The telemetry module verifies the subject and
   * token again under its cross-process lease. */
  async function retryPendingTelemetryConsent(): Promise<boolean> {
    return import("@/telemetry/outbound").then(({ OutboundTelemetry }) => OutboundTelemetry.retryPendingConsent())
  }

  /** Carry consent across a key-only -> canonical account-id migration while
   * the old session is still active and verifiable. */
  async function preserveTelemetryConsentForSession(session: OpenScienceSession): Promise<boolean> {
    return import("@/telemetry/outbound").then(({ OutboundTelemetry }) =>
      OutboundTelemetry.preserveConsentForSession(session),
    )
  }

  /** Remove every credential artifact owned by the last dashboard sync while
   * preserving unrelated shell exports. The caller holds CredentialLifecycle's
   * cross-process mutation lease. */
  async function clearSyncedCredentialArtifacts(): Promise<void> {
    const synced = await readSyncedSnapshot()
    for (const [key, value] of syncedSecretValues.entries()) synced.set(key, value)
    for (const name of ["synced-env.json", "openscience-synced.json", syncedGcpFilename]) {
      await fs.unlink(path.join(getSyncedConfigDir(), name)).catch(() => undefined)
    }
    for (const [key, value] of synced.entries()) unsetSyncedVar(key, value)
    syncedSecretValues.clear()
  }

  /**
   * Sign out locally: remove the session file and every credential artifact
   * the sync path created. Without this, `synced-env.json` is replayed into
   * process.env on every boot (preload-env.ts) and the still-valid managed
   * key keeps debiting the signed-out account's wallet. Covers both explicit
   * logout and the 401-triggered clear. Best-effort; never throws.
   */
  export async function clearSession(expectedApiKey?: string): Promise<boolean> {
    const clear = async () => {
      // Remove the synced credential artifacts FIRST, then delete the session file
      // LAST. A crash after unlinking the session but before removing
      // synced-env.json would otherwise leave preload-env.ts replaying the managed
      // key into process.env on the next boot — the signed-out account's wallet
      // kept being debited, the exact thing this function exists to prevent.
      await clearSyncedCredentialArtifacts()
      await dropUsageQueue()
      await resetTelemetryAccountSession()
      cachedProfile = undefined
      invalidateResearchEntitlements()
      invalidateBalance()
      // Session file last, once the managed-key-replaying artifacts are gone.
      try {
        await fs.unlink(filepath)
      } catch {}
      return true
    }
    const cleared =
      expectedApiKey === undefined
        ? await CredentialLifecycle.mutate("managed-session.clear", clear)
        : (
            await CredentialLifecycle.mutateIf(
              "managed-session.clear",
              async () => (await getSession())?.api_key === expectedApiKey,
              clear,
            )
          ).applied
    // The raw account credential is gone before this request runs. A pending
    // opt-out can therefore carry only its fixed-target deletion capability,
    // including after a server 401 revoked the original key.
    if (cleared) await retryPendingTelemetryConsent().catch(() => false)
    return cleared
  }

  /**
   * Best-effort server-side revocation of THIS device's key, for logout paths.
   * The session stores only the raw api_key (never its key_id), so the device
   * is identified by a unique `key_prefix` match against the devices list —
   * when zero or several devices match, we skip rather than guess. Call
   * BEFORE clearSession(); returns whether the key was revoked.
   */
  export async function revokeCurrentDevice(): Promise<boolean> {
    try {
      const session = await getSession()
      if (!session) return false
      const devices = await listDevices()
      if (!devices) return false
      const matches = devices.filter(
        (d) => d.key_prefix.length > "thk_".length && session.api_key.startsWith(d.key_prefix),
      )
      if (matches.length !== 1) return false
      return await revokeDevice(matches[0].key_id)
    } catch {
      return false
    }
  }

  export async function isAuthenticated(): Promise<boolean> {
    const session = await getSession()
    return session !== null
  }

  /** User-facing dashboard page where keys + billing live. Printed as the
   *  fallback when a browser/loopback login can't be used (headless/CI). */
  export function authPageUrl(): string {
    return VERIFICATION_PAGE
  }

  /** Minimal pages shown in the browser after it redirects back to our
   *  loopback callback. Inlined so login carries no asset dependencies. */
  const CALLBACK_SUCCESS_HTML =
    "<!doctype html><meta charset=utf-8><title>OpenScience</title>" +
    '<body style="font-family:system-ui,sans-serif;background:#0b0b12;color:#eee;display:grid;place-items:center;height:100vh;margin:0">' +
    "<div style=text-align:center><h1 style=color:#4ade80>Login complete</h1>" +
    "<p style=color:#9aa>You're signed in to the OpenScience CLI. You can close this tab.</p></div>" +
    "<script>setTimeout(()=>window.close(),1500)</script>"

  const CALLBACK_ERROR_HTML =
    "<!doctype html><meta charset=utf-8><title>OpenScience</title>" +
    '<body style="font-family:system-ui,sans-serif;background:#0b0b12;color:#eee;display:grid;place-items:center;height:100vh;margin:0">' +
    "<div style=text-align:center><h1 style=color:#f87171>Login failed</h1>" +
    "<p style=color:#9aa>The callback could not be verified. Return to your terminal and try again.</p></div>"

  /** Spin up an ephemeral loopback server that waits for the browser to
   *  redirect back with the approved exchange token. Uses a random port, a
   *  ``/callback`` path, and a strict ``state`` check to defeat CSRF. */
  function startCallbackServer(expectedState: string): {
    port: number
    done: Promise<{ exchange_token: string }>
    stop: () => void
  } {
    let resolve!: (value: { exchange_token: string }) => void
    let reject!: (error: Error) => void
    const done = new Promise<{ exchange_token: string }>((res, rej) => {
      resolve = res
      reject = rej
    })
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname !== "/callback") return new Response("Not found", { status: 404 })
        const state = url.searchParams.get("state") ?? ""
        const token = url.searchParams.get("exchange_token") ?? ""
        if (state !== expectedState || !token) {
          reject(new Error("Browser login failed: callback state mismatch."))
          return new Response(CALLBACK_ERROR_HTML, {
            status: 400,
            headers: { "Content-Type": "text/html" },
          })
        }
        resolve({ exchange_token: token })
        return new Response(CALLBACK_SUCCESS_HTML, {
          headers: { "Content-Type": "text/html" },
        })
      },
    })
    return { port: server.port!, done, stop: () => server.stop(true) }
  }

  /** Build a readable error from a failed login HTTP call. The retired
   *  endpoints answer 426 — translate that into an upgrade nudge. */
  async function loginError(res: Response, phase: string): Promise<string> {
    if (res.status === 426) {
      return "This OpenScience version is out of date. Run `openscience upgrade` (or `npm i -g @synsci/openscience@latest`) and try again."
    }
    const detail = await res.text().catch(() => "")
    const trimmed = detail.trim().slice(0, 200)
    return `Login ${phase} failed: HTTP ${res.status}${trimmed ? ` — ${trimmed}` : ""}`
  }

  /** Browser login: open the approval URL, capture the redirect on a
   *  loopback server, then exchange it for a long-lived ``thk_`` key.
   *  Endpoints: ``POST /api/v1/auth/cli/browser/{start,redeem}``. */
  export async function browserLogin(opts?: {
    onApprovalUrl?: (url: string) => void
    timeoutMs?: number
  }): Promise<OpenScienceSession> {
    const state = randomUUID()
    const name = deviceName()
    const callback = startCallbackServer(state)
    const redirectUri = `http://127.0.0.1:${callback.port}/callback`

    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const startRes = await atlasFetch(`${API_BASE}/api/v1/auth/cli/browser/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ state, redirect_uri: redirectUri, name }),
      })
      if (!startRes.ok) throw new Error(await loginError(startRes, "start"))
      const started = await startRes.json()
      const approvalUrl: string | undefined = started.approval_url
      if (!approvalUrl) throw new Error("Login start did not return an approval URL.")

      opts?.onApprovalUrl?.(approvalUrl)

      const timeoutMs = opts?.timeoutMs ?? 300_000
      const result = await Promise.race([
        callback.done,
        new Promise<never>((_, rej) => {
          timer = setTimeout(() => rej(new Error("Timed out waiting for browser authorization.")), timeoutMs)
        }),
      ])

      const redeemRes = await atlasFetch(`${API_BASE}/api/v1/auth/cli/browser/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          state,
          exchange_token: result.exchange_token,
          redirect_uri: redirectUri,
        }),
      })
      if (!redeemRes.ok) throw new Error(await loginError(redeemRes, "redeem"))
      const redeemed = await redeemRes.json()
      const key = redeemed.api_key || redeemed.key
      if (!key) throw new Error("Login did not return an API key.")

      const session: OpenScienceSession = {
        api_key: key,
        user_id: redeemed.user?.id || redeemed.user_id || "",
        device_name: name,
      }
      await saveSession(session)
      return session
    } finally {
      if (timer) clearTimeout(timer)
      callback.stop()
    }
  }

  /** Headless / CI login: validate a pasted ``thk_`` key and persist it.
   *  Used when no local browser + loopback callback is available. */
  export async function loginWithKey(rawKey: string): Promise<OpenScienceSession> {
    const key = rawKey.trim()
    if (!key.startsWith("thk_")) {
      throw new Error("Expected an API key starting with `thk_`.")
    }
    const res = await atlasFetch(`${API_BASE}/api/cli/balance`, {
      headers: { Authorization: `Bearer ${key}` },
    })
    if (res.status === 401 || res.status === 403) {
      throw new Error("That key was rejected. Double-check it and try again.")
    }
    if (!res.ok) {
      throw new Error(`Could not validate key: HTTP ${res.status}`)
    }
    // Balance is the compatibility validation endpoint. A best-effort sync
    // read additionally gives modern Gateway deployments' canonical user id,
    // avoiding legacy empty-id sessions while preserving older deployments.
    const profile = await atlasFetch(`${API_BASE}/api/cli/sync`, {
      headers: { Authorization: `Bearer ${key}` },
    })
      .then(async (response) => (response.ok ? ((await response.json()) as SyncResponse) : undefined))
      .catch(() => undefined)
    const session: OpenScienceSession = {
      api_key: key,
      user_id: profile?.user?.user_id || "",
      device_name: deviceName(),
    }
    await saveSession(session)
    return session
  }

  /** Write a file atomically (temp + rename) so a crash mid-write can never
   *  leave a torn file — a torn synced-env.json silently drops managed keys, and
   *  a torn openscience-synced.json throws during config load and bricks the CLI
   *  until it's removed by hand. */
  async function atomicWrite(filepath: string, content: string, options?: { mode?: number }): Promise<void> {
    await using operation = await DataRootBarrier.enter(filepath)
    // Unique per call (not just per PID): two concurrent syncs in the SAME
    // process (e.g. a per-request /sync and the processor's background sync)
    // would otherwise write the identical temp path, interleave, and publish a
    // torn file or fail the rename.
    const tmp = `${filepath}.${process.pid}.${randomUUID()}.tmp`
    await fs.mkdir(path.dirname(filepath), { recursive: true })
    try {
      const handle = await fs.open(tmp, "wx", options?.mode ?? 0o600)
      await handle
        .writeFile(content, "utf8")
        .then(() =>
          options?.mode !== undefined && process.platform !== "win32" ? handle.chmod(options.mode) : undefined,
        )
        .then(() => handle.sync())
        .finally(() => handle.close())
      await fs.rename(tmp, filepath)
      const directory = await fs.open(path.dirname(filepath), "r").catch(() => undefined)
      await directory?.sync().catch(() => undefined)
      await directory?.close().catch(() => undefined)
    } catch (error) {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
      throw error
    }
  }

  /** Fetch all connected service credentials and inject as env vars. */
  export async function syncServices(options: { reconcileLocal?: boolean } = {}): Promise<{
    user: SyncResponse["user"]
    credentials: number
  } | null> {
    const session = await getSession()
    if (!session) return null

    try {
      const res = await authenticatedAtlasFetch(session, `${API_BASE}/api/cli/sync`, {
        headers: { Authorization: `Bearer ${session.api_key}` },
      })

      if (!res.ok) {
        if (res.status === 401) return null
        if (res.status === 403) {
          // 403s also come from WAFs and rate limiters, not just key
          // revocation. Destroying the session on one silently signed the
          // user out; keep it and let the next sync retry. A genuinely
          // revoked key comes back as 401.
          log.warn("sync got 403, keeping session")
          return null
        }
        if (res.status === 402) {
          // Legacy Atlas deployments can report wallet eligibility here. Keep
          // the valid session: local and dashboard-saved BYOK remain free.
          log.warn("Synthetic Sciences wallet unavailable - BYOK remains available without wallet billing")
          return null
        }
        log.warn("sync failed", { status: res.status })
        return null
      }

      const data: SyncResponse = await res.json()
      cachedProfile = data.user
      // Count distinct credential VALUES, ignoring *_BASE_URL routing config.
      // Many providers broadcast the same managed thk_* under several env-var
      // names (ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY / ...) —
      // those are one credential, not four.

      // Rebuild the synced snapshot from THIS response only. Accumulating
      // across syncs meant a provider disconnected (or a key rotated) on the
      // dashboard stayed live in the CLI forever.
      const fresh = new Map<string, string>()
      for (const [, svc] of Object.entries(data.services)) {
        if (svc.connected && svc.env) {
          for (const [key, value] of Object.entries(svc.env)) {
            if (value) fresh.set(key, value)
          }
        }
      }

      return await CredentialLifecycle.mutate(
        "managed-services.sync",
        async () => {
          const current = await getSession()
          if (!current || current.api_key !== session.api_key) {
            throw new Error("Managed session changed while services were syncing; discarded the stale response")
          }
          // Retired releases materialized an Atlas-delivered GCP service account.
          // Account sync no longer distributes any compute credential, so remove
          // that legacy artifact and filter the response before applying it.
          const gcpFile = path.join(getSyncedConfigDir(), syncedGcpFilename)
          await fs.unlink(gcpFile).catch(() => {})

          // Keep user-owned provider keys and the narrow OpenRouter managed route.
          // The policy rejects account-synced compute credentials, direct-provider
          // proxy tokens, and untrusted provider base URLs before anything is
          // applied or persisted.
          for (const [key, value] of [...fresh.entries()]) {
            if (!isSyncedEnvAllowed(key, value)) fresh.delete(key)
          }

          // Older Atlas sync responses can carry only OPENROUTER_API_KEY=thk_*.
          // Managed OpenRouter must also carry the Atlas proxy baseURL; otherwise
          // provider init correctly refuses to send a wallet token to public
          // openrouter.ai and the UI shows ProviderInitError.
          const openrouterKey = fresh.get("OPENROUTER_API_KEY")
          if (isManagedAtlasKey(openrouterKey ?? "") && !fresh.has("OPENROUTER_BASE_URL")) {
            fresh.set("OPENROUTER_BASE_URL", managedOpenRouterBaseURL())
          }

          // Count distinct APPLIED credential values (post-filter, ignoring routing
          // *_BASE_URL vars) so the returned total reflects what the CLI honours —
          // never the credentials that were dropped above.
          const credentials = new Set(
            [...fresh.entries()].filter(([key]) => !key.endsWith("_BASE_URL")).map(([, value]) => value),
          ).size

          // Unset previously-synced vars that are absent from the new response —
          // mirrors the ownedKeys cleanup in server/routes/settings/credentials.ts.
          // "Previously synced" is the union of this process's map and the on-disk
          // snapshot preload-env.ts replayed at boot; a var is only removed when
          // its live value still matches, so shell exports survive.
          const previous = await readSyncedSnapshot()
          for (const [key, value] of syncedSecretValues.entries()) previous.set(key, value)
          for (const [key, value] of previous.entries()) {
            if (fresh.has(key)) continue
            unsetSyncedVar(key, value)
          }
          syncedSecretValues.clear()
          for (const [key, value] of fresh.entries()) {
            // Respect precedence: never clobber a user's own shell export or BYOK
            // value. Only write the synced value when the slot is empty or already
            // holds a previously-synced value — mirroring preload-env.ts's "shell
            // exports win". Without this, a background sync could overwrite an
            // exported ANTHROPIC_API_KEY with a managed thk_ key mid-session,
            // silently turning a free BYOK call into a billed managed one.
            const current = process.env[key]
            const ownsSlot = !current || previous.get(key) === current || current === value
            if (ownsSlot) {
              try {
                Env.set(key, value)
              } catch {
                /* Instance not initialized */
              }
              process.env[key] = value
            }
            // Track the synced value regardless (for redaction + later cleanup). A
            // shadowing shell export is left untouched by the unset pass above, which
            // only removes a var whose live value still equals the synced one.
            syncedSecretValues.set(key, value)
          }

          // Write model lockdown config to managed config dir (highest priority config layer)
          if (data.config) {
            try {
              const managedDir = getSyncedConfigDir()
              await fs.mkdir(managedDir, { recursive: true })
              await atomicWrite(
                path.join(managedDir, "openscience-synced.json"),
                JSON.stringify({ $schema: "https://syntheticsciences.ai/config.json", ...data.config }, null, 2),
                { mode: 0o600 },
              )
              log.info("wrote managed config", { dir: managedDir })
            } catch (e) {
              log.warn("failed to write managed config", { error: e instanceof Error ? e.message : String(e) })
            }
          }

          // Persist the synced env to disk so the NEXT CLI invocation can
          // load it synchronously at module init (./preload-env.ts) — before
          // any provider SDK reads process.env. Without this, the first call
          // in a fresh process races: SDKs initialize empty, sync populates
          // process.env too late.
          try {
            const managedDir = getSyncedConfigDir()
            await fs.mkdir(managedDir, { recursive: true })
            const envSnapshot: Record<string, string> = {}
            for (const [k, v] of fresh.entries()) {
              envSnapshot[k] = v
            }
            await atomicWrite(path.join(managedDir, "synced-env.json"), JSON.stringify(envSnapshot, null, 2), {
              mode: 0o600,
            })
          } catch (e) {
            log.warn("failed to persist synced env", { error: e instanceof Error ? e.message : String(e) })
          }

          log.info("synced services", {
            services: Object.entries(data.services)
              .filter(([, s]) => s.connected)
              .map(([id]) => id),
            credentials,
          })

          // Log disconnected providers that have a reason so users can diagnose
          // BYOK/managed issues without opening the dashboard.
          for (const [id, svc] of Object.entries(data.services)) {
            if (!svc.connected && svc.reason) {
              log.warn(describeReason(id, svc.reason))
            }
          }

          // Compatibility only: older releases stored the third-party install
          // ledger in Atlas. Import those records once after a successful login,
          // then keep all skill state local forever.
          void import("../skill/migrate")
            .then((module) => module.SkillMigration.run())
            .catch((error) => log.warn("legacy skill migration failed", { error: String(error) }))

          return { user: data.user, credentials }
        },
        options,
      )
    } catch (e) {
      log.warn("sync error", { error: e instanceof Error ? e.message : String(e) })
      return null
    }
  }

  /** Provider env var names whose values are user-owned secrets worth masking
   *  when they leak into command output. Shares the single BYOK-provider source
   *  of truth with the sync blocklist (synced-env-policy.ts) so a key the user
   *  exported in their shell is redacted the same as a synced one. */
  const BYOK_ENV_KEYS = BYOK_LLM_ENV_KEYS

  /** Populate the BYOK secret cache from auth.json (api-type keys) and the
   *  user's provider env vars. Best-effort + idempotent; safe to call often.
   *  Managed thk_* values are excluded (they are already redacted via the
   *  synced set and are never the user's own credential). */
  export async function refreshByokSecrets(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    try {
      const auth = await Auth.all().catch(() => ({}) as Record<string, Auth.Info>)
      for (const info of Object.values(auth)) {
        const values =
          info.type === "api"
            ? [info.key]
            : info.type === "oauth"
              ? [info.access, info.refresh]
              : [info.key, info.token]
        for (const value of values) {
          if (!value || isManagedAtlasKey(value)) continue
          byokSecretValues.add(value)
        }
      }
    } catch {
      /* ignore */
    }
    for (const key of BYOK_ENV_KEYS) {
      const value = env[key]
      if (!value || isManagedAtlasKey(value)) continue
      byokSecretValues.add(value)
    }
  }

  /** Register externally-sourced secret values (e.g. the decrypted service
   *  credentials from settings ▸ Credentials) so they are masked in subprocess
   *  output exactly like BYOK/managed keys. Short and managed (thk_*) values are
   *  ignored. Idempotent — safe to call on every credential save. */
  export function registerSecretValues(values: Iterable<string>): void {
    for (const value of values) {
      if (!value || value.length < 4 || isManagedAtlasKey(value)) continue
      byokSecretValues.add(value)
    }
  }

  /** Mask every known managed + BYOK secret value in arbitrary text. Sync so it
   *  can run inline on streamed subprocess output. Call refreshByokSecrets()
   *  ahead of a subprocess run to seed the BYOK cache. */
  export function redactSecrets(text: string): string {
    let result = text
    for (const value of syncedSecretValues.values()) {
      if (value.length < 4) continue
      result = result.replaceAll(value, "[REDACTED]")
    }
    for (const value of byokSecretValues) {
      if (value.length < 4) continue
      result = result.replaceAll(value, "[REDACTED]")
    }
    for (const pattern of TOKEN_SECRET_PATTERNS) result = result.replace(pattern, "[REDACTED]")
    result = result.replace(PRIVATE_KEY_SECRET, "[REDACTED]")
    result = result.replace(JWT_SECRET, "[REDACTED]")
    result = result.replace(BEARER_SECRET, "$1[REDACTED]")
    result = result.replace(QUOTED_SECRET, "$1$2[REDACTED]$2")
    result = result.replace(BARE_SECRET, "$1[REDACTED]")
    return result
  }

  /** Redact a JSON-shaped value, including plain values stored under credential-
   *  shaped keys, using the currently seeded secret cache. */
  export function redactSensitive<T>(value: T): T {
    const visit = (item: unknown, key?: string): unknown => {
      if (typeof item === "string") return key && SECRET_FIELD.test(key) ? "[REDACTED]" : redactSecrets(item)
      if (Array.isArray(item)) return item.map((entry) => visit(entry))
      if (!item || typeof item !== "object") return item
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>).map(([name, entry]) => [name, visit(entry, name)]),
      )
    }
    return visit(value) as T
  }

  /** Refresh known BYOK values, then redact a JSON-shaped value. Persistence
   *  boundaries should use this entry point before serializing. */
  export async function scrubSecrets<T>(value: T): Promise<T> {
    await refreshByokSecrets()
    return redactSensitive(value)
  }

  /** Whether a value is a managed Atlas proxy token (thk_*). Managed calls are
   *  the only ones that debit Credits. */
  export function isManagedKeyValue(value: string | undefined): boolean {
    return typeof value === "string" && isManagedAtlasKey(value)
  }

  /** Whether an env var name was populated by the dashboard sync (managed). */
  export function isSyncedSecretKey(key: string): boolean {
    return syncedSecretValues.has(key)
  }

  /** Whether a value matches a dashboard-synced (managed) secret. */
  export function isSyncedSecretValue(value: string | undefined): boolean {
    if (!value) return false
    for (const v of syncedSecretValues.values()) if (v === value) return true
    return false
  }

  /** Filter env vars for subprocesses — exclude managed Atlas proxy tokens. */
  export function normalizeByokRouting(env: Record<string, string>): Record<string, string> {
    const result = { ...env }
    if (
      result.OPENROUTER_API_KEY &&
      !isManagedAtlasKey(result.OPENROUTER_API_KEY) &&
      isManagedOpenRouterProxy(result.OPENROUTER_BASE_URL)
    ) {
      result.OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
    }
    return result
  }

  export function filterEnvForSubprocess(env: NodeJS.ProcessEnv): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) {
      if (!value) continue
      if (CONTROL_PLANE_ENV_KEYS.has(key)) continue
      if (isManagedAtlasKey(value)) continue
      // Entries ending in `_` (LC_, XDG_) are true prefixes; the rest are exact
      // names. Treating all as prefixes let HOME match HOMEBREW_GITHUB_API_TOKEN,
      // USER match USERPROFILE, etc. — over-broad passthrough.
      const isSafe =
        SAFE_ENV_PREFIXES.some((p) => (p.endsWith("_") ? key.startsWith(p) : key === p)) || SAFE_SYNCED_KEYS.has(key)
      if (isSafe || !syncedSecretValues.has(key)) {
        result[key] = value
      }
    }
    // A user-owned key may already be present in the process while an earlier
    // managed sync left the Atlas proxy base URL beside it. Never send BYOK to
    // that Credits-backed route. Preserve explicit non-Atlas gateways.
    return normalizeByokRouting(result)
  }

  /** Minimal environment for arbitrary notebook/R code. Kernels need language
   * runtime discovery and locale/temp configuration, not the user's shell
   * credentials. Provider, Atlas, cloud, and ad-hoc secret vars stay on the
   * OpenScience host and can only enter a kernel through an explicit start env. */
  export function filterEnvForKernel(env: NodeJS.ProcessEnv): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) {
      if (!value) continue
      const runtime =
        SAFE_ENV_PREFIXES.some((prefix) => (prefix.endsWith("_") ? key.startsWith(prefix) : key === prefix)) ||
        KERNEL_RUNTIME_KEYS.has(key)
      if (runtime) result[key] = value
    }
    return result
  }

  export function kernelEnv(env: NodeJS.ProcessEnv = process.env) {
    return {
      ...filterEnvForKernel(env),
      // A denied ~/.gitconfig is a hard error in Git (unlike a missing file).
      // Arbitrary kernels must not read host Git credentials/config, so point
      // Git at an inert explicit config instead of widening the read policy.
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_TERMINAL_PROMPT: "0",
    }
  }

  /** Host credential files that an OS-sandboxed kernel must not read. Atlas
   * access is intentionally provided by the native host broker instead. */
  export function kernelSensitivePaths() {
    const home = os.homedir()
    return [
      filepath,
      path.join(Global.Path.data, "auth.json"),
      path.join(Global.Path.data, "credentials.json"),
      path.join(Global.Path.data, "credentials.key"),
      path.join(Global.Path.data, "gcp-service-account.json"),
      CredentialLifecycle.revisionPath(),
      path.join(Global.Path.data, "mcp-auth.json"),
      path.join(Global.Path.data, "file-trash"),
      // Exact truncated outputs are broker capabilities. Mask the entire
      // enclave inside arbitrary subprocesses so a historical broad parent
      // grant cannot expose or mutate another session's files.
      ToolOutputPath.root,
      path.join(getSyncedConfigDir(), "synced-env.json"),
      path.join(getSyncedConfigDir(), syncedGcpFilename),
      process.env.ATLAS_CLI_CONFIG_PATH || path.join(home, ".config", "atlas-cli", "config.json"),
      path.join(home, ".ssh"),
      path.join(home, ".aws"),
      path.join(home, ".azure"),
      path.join(home, ".kaggle"),
      path.join(home, ".docker"),
      path.join(home, ".config", "gcloud"),
      path.join(home, ".config", "gh"),
      path.join(home, ".config", "huggingface"),
      path.join(home, ".config", "pip", "pip.conf"),
      path.join(home, ".config", "rclone", "rclone.conf"),
      path.join(home, ".netrc"),
      path.join(home, ".git-credentials"),
      path.join(home, ".npmrc"),
      path.join(home, ".pypirc"),
    ]
  }

  /** Provider IDs (as stored in auth.json) whose user-owned BYOK keys are safe
   *  to expose to skill subprocesses, mapped to the env var(s) the scripts
   *  read. These are keys the user explicitly added with `openscience login` —
   *  unlike the shared managed keys, which stay stripped. */
  const BYOK_SUBPROCESS_PROVIDERS: Record<string, { keys: string[]; baseUrl?: string; publicBaseUrl?: string }> = {
    openai: {
      keys: ["OPENAI_API_KEY"],
      baseUrl: "OPENAI_BASE_URL",
      publicBaseUrl: "https://api.openai.com/v1",
    },
    anthropic: {
      keys: ["ANTHROPIC_API_KEY"],
      baseUrl: "ANTHROPIC_BASE_URL",
      publicBaseUrl: "https://api.anthropic.com/v1",
    },
    google: {
      keys: ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY"],
      baseUrl: "GOOGLE_GENERATIVE_AI_BASE_URL",
      publicBaseUrl: "https://generativelanguage.googleapis.com/v1beta",
    },
    xai: {
      keys: ["XAI_API_KEY"],
      baseUrl: "XAI_BASE_URL",
      publicBaseUrl: "https://api.x.ai/v1",
    },
    meta: { keys: ["META_MODEL_API_KEY"] },
    openrouter: {
      keys: ["OPENROUTER_API_KEY"],
      baseUrl: "OPENROUTER_BASE_URL",
      publicBaseUrl: "https://openrouter.ai/api/v1",
    },
    togetherai: {
      keys: ["TOGETHER_API_KEY"],
      baseUrl: "TOGETHER_BASE_URL",
      publicBaseUrl: "https://api.together.xyz/v1",
    },
    together: {
      keys: ["TOGETHER_API_KEY"],
      baseUrl: "TOGETHER_BASE_URL",
      publicBaseUrl: "https://api.together.xyz/v1",
    },
    groq: {
      keys: ["GROQ_API_KEY"],
      baseUrl: "GROQ_BASE_URL",
      publicBaseUrl: "https://api.groq.com/openai/v1",
    },
    "fireworks-ai": {
      keys: ["FIREWORKS_API_KEY"],
      baseUrl: "FIREWORKS_BASE_URL",
      publicBaseUrl: "https://api.fireworks.ai/inference/v1",
    },
    fireworks: {
      keys: ["FIREWORKS_API_KEY"],
      baseUrl: "FIREWORKS_BASE_URL",
      publicBaseUrl: "https://api.fireworks.ai/inference/v1",
    },
    mistral: {
      keys: ["MISTRAL_API_KEY"],
      baseUrl: "MISTRAL_BASE_URL",
      publicBaseUrl: "https://api.mistral.ai/v1",
    },
    deepseek: {
      keys: ["DEEPSEEK_API_KEY"],
      baseUrl: "DEEPSEEK_BASE_URL",
      publicBaseUrl: "https://api.deepseek.com",
    },
    cerebras: {
      keys: ["CEREBRAS_API_KEY"],
      baseUrl: "CEREBRAS_BASE_URL",
      publicBaseUrl: "https://api.cerebras.ai/v1",
    },
    perplexity: {
      keys: ["PERPLEXITY_API_KEY"],
      baseUrl: "PERPLEXITY_BASE_URL",
      publicBaseUrl: "https://api.perplexity.ai",
    },
  }

  /** Merge user-owned (BYOK) provider keys from auth.json into a subprocess env.
   *  Pure + synchronous so it stays unit-testable. Skips managed `thk_*` keys
   *  and never overrides a value already present (shell export or synced var).
   *  When a BYOK key is injected for a provider with a base-url var, the base
   *  url is pinned to the public endpoint so the key authenticates against the
   *  right host rather than a managed proxy. */
  export function mergeByokEnv(base: Record<string, string>, auth: Record<string, Auth.Info>): Record<string, string> {
    const result = { ...base }
    for (const [providerID, info] of Object.entries(auth)) {
      if (info.type !== "api") continue
      if (isManagedAtlasKey(info.key)) continue
      const spec = BYOK_SUBPROCESS_PROVIDERS[providerID]
      if (!spec) continue
      if (spec.keys.some((key) => result[key])) continue
      for (const key of spec.keys) result[key] = info.key
      if (spec.baseUrl && spec.publicBaseUrl) result[spec.baseUrl] = spec.publicBaseUrl
    }
    return normalizeByokRouting(result)
  }

  /** Subprocess env = sanitized base env + any user-owned BYOK provider keys
   *  from auth.json. Lets skill scripts (e.g. nano-banana image generation)
   *  use a key the user connected with `openscience login`, without leaking the
   *  shared managed keys. */
  export async function subprocessEnv(env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> {
    // This is the credential-bearing child-process choke point. It blocks while
    // another server is rotating a store and reconciles a committed revision
    // before taking the environment snapshot below.
    await CredentialLifecycle.ensureFresh()
    const base = filterEnvForSubprocess(env)
    const auth = await Auth.all().catch(() => ({}) as Record<string, Auth.Info>)
    return {
      ...mergeByokEnv(base, auth),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_TERMINAL_PROMPT: "0",
    }
  }

  /** Build and consume a credential-bearing child environment while the
   * durable credential mutation lease is held. The callback must spawn and
   * durably register its child before returning. */
  export function withSubprocessEnv<T>(
    env: NodeJS.ProcessEnv,
    action: (snapshot: Record<string, string>) => T | Promise<T>,
  ): Promise<T> {
    return CredentialLifecycle.admit(async () => action(await subprocessEnv(env)))
  }

  // Default thread/worker caps for scientific Python kernels. Without these,
  // BLAS (OpenBLAS/MKL/Accelerate), numba, and joblib/loky each fan out to one
  // worker PER CORE by default. On a large dataset a single densifying op (e.g.
  // scanpy regress_out with n_jobs=-1) then spawns N full-dataset copies at once,
  // each tens of GB — the machine swaps to death (#102). Cap each to a small,
  // safe default and only fill a var the user/agent hasn't already set, so an
  // explicit override still wins.
  export function pythonThreadCapEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const cap = String(Math.max(1, Math.min(4, os.cpus().length)))
    const vars = [
      "OMP_NUM_THREADS",
      "OPENBLAS_NUM_THREADS",
      "MKL_NUM_THREADS",
      "VECLIB_MAXIMUM_THREADS",
      "NUMEXPR_NUM_THREADS",
      "NUMBA_NUM_THREADS",
      "LOKY_MAX_CPU_COUNT",
    ]
    return Object.fromEntries(vars.filter((v) => !env[v]).map((v) => [v, cap]))
  }

  /** Credit balance cache */
  let cachedBalance: { value: number; at: number } | null = null
  let pendingBalance: Promise<number | null> | undefined
  let balanceRevision = 0
  const BALANCE_CACHE_TTL = 30 * 1000

  function publishBalance(value: number) {
    balanceRevision++
    pendingBalance = undefined
    cachedBalance = { value, at: Date.now() }
  }

  /** Drop the cached balance so the next getBalance() refetches. Called when
   *  the wallet gate blocks, so a top-up is visible on the next attempt
   *  instead of after the cache TTL. */
  export function invalidateBalance() {
    balanceRevision++
    pendingBalance = undefined
    cachedBalance = null
  }

  /** Get current credit balance (cached for 30s).
   *  Returns the balance in USD, or null when it can't be determined (no
   *  session, API failure). null is distinct from a real negative balance —
   *  the old -1 sentinel collided with an overdraft of exactly -$1. */
  export async function getBalance(): Promise<number | null> {
    if (cachedBalance && Date.now() - cachedBalance.at < BALANCE_CACHE_TTL) {
      return cachedBalance.value
    }
    if (pendingBalance) return pendingBalance
    const revision = balanceRevision
    const request = (async () => {
      const session = await getSession()
      if (!session) return null
      try {
        const res = await authenticatedAtlasFetch(session, `${API_BASE}/api/cli/balance`, {
          headers: { Authorization: `Bearer ${session.api_key}` },
        })
        if (!res.ok) return null
        const data = await res.json()
        const usd =
          typeof data.balance_usd === "number"
            ? data.balance_usd
            : typeof data.balance_cents === "number"
              ? data.balance_cents / 100
              : null
        if (usd === null) return null
        if (revision !== balanceRevision) return cachedBalance?.value ?? null
        cachedBalance = { value: usd, at: Date.now() }
        return usd
      } catch {
        return null
      }
    })()
    pendingBalance = request
    void request.finally(() => {
      if (pendingBalance === request) pendingBalance = undefined
    })
    return request
  }

  /** Drop managed-search capability state after an account transition or a
   * backend rejection. The next execution performs a bounded entitlement read;
   * it never touches the wallet or dispatches a search. */
  export function invalidateResearchEntitlements() {
    cachedEntitlements = undefined
    cachedEntitlementsAt = 0
    cachedEntitlementsAccount = undefined
    cachedEntitlementsFailureAt = 0
    cachedEntitlementsFailureAccount = undefined
    entitlementsRequest = undefined
    entitlementsGeneration++
  }

  /** Authenticated users may attempt enhanced search. The server is the sole
   * settlement authority: it charges wallet Credits or rejects the request,
   * after which the tool falls back to basic search when available. */
  export async function resolveManagedSearchEntitlement(): Promise<boolean> {
    return !!(await getSession())
  }

  /** Read the legacy search capability payload for compatibility diagnostics.
   * Local routing never treats its plan ids or counters as billing authority. */
  export async function getResearchEntitlements(): Promise<ResearchEntitlements | null> {
    const session = await getSession()
    if (!session) return null
    return readResearchEntitlements(session)
  }

  async function readResearchEntitlements(session: OpenScienceSession): Promise<ResearchEntitlements | null> {
    const account = accountTag(session)
    if (
      cachedEntitlementsFailureAccount === account &&
      Date.now() - cachedEntitlementsFailureAt < ENTITLEMENTS_FAILURE_TTL_MS
    ) {
      return null
    }
    if (entitlementsRequest?.account === account) return entitlementsRequest.promise
    const generation = entitlementsGeneration
    const pending = (async () => {
      try {
        const res = await authenticatedAtlasFetch(
          session,
          `${API_BASE}/api/v1/entitlements`,
          { headers: { Authorization: `Bearer ${session.api_key}`, Accept: "application/json" } },
          ENTITLEMENTS_FETCH_TIMEOUT_MS,
        )
        if (!res.ok) {
          if (generation === entitlementsGeneration) {
            cachedEntitlementsFailureAt = Date.now()
            cachedEntitlementsFailureAccount = account
          }
          return null
        }
        const value = normalizeResearchEntitlements((await res.json()) as ResearchEntitlements)
        if (generation === entitlementsGeneration) {
          cachedEntitlements = value
          cachedEntitlementsAt = Date.now()
          cachedEntitlementsAccount = account
          cachedEntitlementsFailureAt = 0
          cachedEntitlementsFailureAccount = undefined
        }
        if (
          generation === entitlementsGeneration &&
          value.capabilities?.proxy_settlement_authoritative === true &&
          value.capabilities.cli_usage_financial === false
        ) {
          await rememberUsageCutover(session)
        }
        return value
      } catch (error) {
        if (generation === entitlementsGeneration) {
          cachedEntitlementsFailureAt = Date.now()
          cachedEntitlementsFailureAccount = account
        }
        log.warn("research entitlement read failed", {
          error: error instanceof Error ? error.message : String(error),
        })
        return null
      }
    })()
    entitlementsRequest = { account, promise: pending }
    try {
      return await pending
    } finally {
      if (entitlementsRequest?.promise === pending) entitlementsRequest = undefined
    }
  }

  /** One top-level Synthetic Sciences search dispatch. The service atomically
   * prices and debits the same Ace wallet used by credit-backed model calls. */
  export async function dispatchResearchSearch(
    input: ResearchSearchInput,
    operationID: string,
    signal: AbortSignal,
  ): Promise<{ status: number; body: unknown } | null> {
    const session = await getSession()
    if (!session) return null
    const bodyText = JSON.stringify({ ...input, operation_id: operationID })
    // A transport failure can happen after Atlas has already settled Wallet
    // usage but before the response reaches this process. Replay once with the
    // exact durable operation key so Atlas returns the authoritative result
    // instead of silently charging for an abandoned enhanced-search response.
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await authenticatedAtlasFetch(
          session,
          `${API_BASE}/api/v1/research/search`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${session.api_key}`,
              "Content-Type": "application/json",
              Accept: "application/json",
              "Idempotency-Key": operationID,
            },
            body: bodyText,
            signal,
          },
          35_000,
        )
        const text = await res.text()
        const body = text
          ? (() => {
              try {
                return JSON.parse(text) as unknown
              } catch {
                return {
                  detail: {
                    code: "search_unavailable",
                    message: `Synthetic Sciences search returned HTTP ${res.status}`,
                  },
                }
              }
            })()
          : {}
        if (attempt === 0 && res.status >= 500) {
          log.warn("Synthetic Sciences research search returned a retryable server response", {
            status: res.status,
            operationID,
          })
          continue
        }
        return { status: res.status, body }
      } catch (error) {
        if (signal.aborted) throw error
        log.warn("Synthetic Sciences research search transport failed", {
          attempt: attempt + 1,
          retrying: attempt === 0,
          operationID,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
    return null
  }

  /** Invalidate balance cache (call after usage report) */
  export function invalidateBalanceCache() {
    invalidateBalance()
  }

  type UsageParams = {
    service: string
    event_type: string
    model?: string
    tokens_used: number
    metadata?: Record<string, unknown>
  }

  const pendingQueuePath = path.join(Global.Path.data, "usage-queue.jsonl")
  const usageCapabilityPath = path.join(Global.Path.data, "usage-capabilities.json")

  /** Stable per-account tag stored with a queued usage row so a later flush can't
   *  bill a DIFFERENT account for it. user_id when known, else a short hash of the
   *  api_key (never the raw key, which must not sit in the queue file). */
  function accountTag(session: OpenScienceSession): string {
    if (session.user_id) return session.user_id
    return "k:" + createHash("sha256").update(session.api_key).digest("hex").slice(0, 16)
  }

  type UsageCapabilities = {
    schema_version: 1
    accounts: Record<string, { nonfinancial: true; observed_at: string }>
  }

  function isNonfinancialAcknowledgement(data: unknown): boolean {
    if (!data || typeof data !== "object" || Array.isArray(data)) return false
    const value = data as Record<string, unknown>
    return value.financial === false && value.billing_authority === "gateway_proxy"
  }

  async function readUsageCapabilities(): Promise<UsageCapabilities> {
    try {
      const value = (await Bun.file(usageCapabilityPath).json()) as Partial<UsageCapabilities>
      if (value.schema_version !== 1 || !value.accounts || typeof value.accounts !== "object") {
        return { schema_version: 1, accounts: {} }
      }
      return { schema_version: 1, accounts: value.accounts }
    } catch {
      return { schema_version: 1, accounts: {} }
    }
  }

  async function rememberUsageCutover(session: OpenScienceSession): Promise<void> {
    const current = await readUsageCapabilities()
    current.accounts[accountTag(session)] = { nonfinancial: true, observed_at: new Date().toISOString() }
    await atomicWrite(usageCapabilityPath, JSON.stringify(current, null, 2), { mode: 0o600 }).catch((error) =>
      log.warn("could not persist usage cutover capability", {
        error: error instanceof Error ? error.message : String(error),
      }),
    )
  }

  async function usageCutoverReady(session: OpenScienceSession): Promise<boolean> {
    if (
      cachedEntitlements?.capabilities?.proxy_settlement_authoritative === true &&
      cachedEntitlements.capabilities.cli_usage_financial === false
    ) {
      return true
    }
    const value = await readUsageCapabilities()
    return value.accounts[accountTag(session)]?.nonfinancial === true
  }

  /** Whether a queued row tagged `rowAccount` may be flushed under `currentAccount`.
   *  A row with no tag is legacy/accountless → best-effort send under the current
   *  account; a row tagged for a DIFFERENT account is never sent (kept until that
   *  account is active). Pure + exported for tests. */
  export function shouldFlushForAccount(rowAccount: string | undefined, currentAccount: string): boolean {
    return !rowAccount || rowAccount === currentAccount
  }

  async function persistToQueue(params: UsageParams, account?: string) {
    try {
      await using operation = await DataRootBarrier.enter(pendingQueuePath)
      // Serialize against flushPendingUsage so an append can't land between
      // the flusher's read and its final rewrite (which would delete it).
      using _ = await Lock.write(pendingQueuePath)
      const row = account ? { ...params, __account: account } : params
      await fs.appendFile(pendingQueuePath, JSON.stringify(row) + "\n")
      log.info("usage queued for retry", { service: params.service })
    } catch (e) {
      log.warn("failed to persist usage to queue", { error: e instanceof Error ? e.message : String(e) })
    }
  }

  async function sendReport(
    params: UsageParams,
    session: OpenScienceSession,
  ): Promise<{ ok: boolean; permanent: boolean; data?: any; modelBlocked?: boolean }> {
    try {
      const res = await authenticatedAtlasFetch(session, `${API_BASE}/api/cli/usage`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.api_key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(params),
      })
      if (res.ok) {
        const data = await res.json()
        log.info("usage reported", {
          service: params.service,
          model: params.model,
          tokens: params.tokens_used,
          cost: data.estimated_cost_usd,
        })
        if (data.model_blocked && !isNonfinancialAcknowledgement(data)) {
          return { ok: false, permanent: true, modelBlocked: true, data }
        }
        return { ok: true, permanent: false, data }
      }
      // 402 = insufficient wallet balance. Halt the session and surface it as
      // modelBlocked
      // so the processor throws InsufficientCreditsError.
      if (res.status === 402) {
        let body: any = {}
        try {
          body = await res.json()
        } catch {
          /* keep {} */
        }
        if (body?.error === "insufficient_balance") {
          const need = ((body.required_cents ?? 0) as number) / 100
          const have = ((body.available_cents ?? 0) as number) / 100
          log.warn(
            `Insufficient balance for this call — need $${need.toFixed(2)}, ` +
              `have $${have.toFixed(2)} available. Top up at ` +
              `${BILLING_URL} or switch to a provider account.`,
          )
        } else {
          log.warn("usage report 402 — wallet credits unavailable")
        }
        return { ok: false, permanent: true, modelBlocked: true }
      }
      const permanent = res.status >= 400 && res.status < 500
      log.warn("usage report failed", { status: res.status, permanent })
      return { ok: false, permanent }
    } catch (e) {
      log.warn("usage report error", { error: e instanceof Error ? e.message : String(e) })
      return { ok: false, permanent: false }
    }
  }

  /** Report service usage for billing (called after training jobs complete).
   *  On transient failure, persists to a local queue for retry on next startup. */
  export async function reportUsage(
    params: UsageParams,
  ): Promise<{ recorded: boolean; event_id?: string; estimated_cost_usd?: number; modelBlocked?: boolean } | null> {
    const session = await getSession()
    if (!session) {
      log.warn("cannot report usage: not authenticated")
      await persistToQueue(params)
      return null
    }
    const cutover = await usageCutoverReady(session)
    const result = await sendReport(params, session)
    const acknowledged = result.ok && isNonfinancialAcknowledgement(result.data)
    if (acknowledged) await rememberUsageCutover(session)
    // Once the server explicitly names the managed proxy as billing authority,
    // this compatibility acknowledgement can neither halt a completed model
    // step nor enter a billing retry loop. Until then, preserve the legacy
    // queue/modelBlocked behavior exactly.
    if (cutover || acknowledged) {
      if (!result.ok) return null
      return { ...result.data, modelBlocked: false }
    }
    // Update balance cache from server response, or invalidate so next check is fresh
    if (result.ok && result.data?.remaining_balance_cents !== undefined) {
      publishBalance(result.data.remaining_balance_cents / 100)
    } else {
      invalidateBalanceCache()
    }
    if (result.ok) {
      return result.data
    }
    if ("modelBlocked" in result && result.modelBlocked) {
      return { recorded: false, modelBlocked: true }
    }
    if (!result.permanent) {
      await persistToQueue(params, accountTag(session))
    }
    return null
  }

  /** Retry any queued usage reports from previous failures (called at startup).
   *  Holds the queue lock across the whole read → send → rewrite cycle so a
   *  concurrent flush in this process can't double-send, and the rewrite
   *  drops only the lines actually read so an append landing mid-flush
   *  survives. Best-effort: never throws. */
  export async function flushPendingUsage(): Promise<void> {
    try {
      await using operation = await DataRootBarrier.enter(pendingQueuePath)
      using _ = await Lock.write(pendingQueuePath)
      const raw = await fs.readFile(pendingQueuePath, "utf-8").catch(() => "")
      const lines = raw.split("\n").filter(Boolean)
      if (!lines.length) return

      const session = await getSession()
      if (!session) return
      const currentAccount = accountTag(session)
      const cutover = await usageCutoverReady(session)

      const retry: string[] = []
      for (const line of lines) {
        try {
          const { __account, ...params } = JSON.parse(line) as UsageParams & { __account?: string }
          // Never bill the active account for usage another account generated —
          // keep it queued until that account is the one flushing.
          if (!shouldFlushForAccount(__account, currentAccount)) {
            retry.push(line)
            continue
          }
          // Historical rows were billing retries. They must never be replayed
          // after this account's server has advertised the nonfinancial cutover.
          if (cutover || (await usageCutoverReady(session))) continue
          const result = await sendReport(params, session)
          if (result.ok && isNonfinancialAcknowledgement(result.data)) {
            await rememberUsageCutover(session)
            continue
          }
          if (!result.ok && !result.permanent) {
            retry.push(line)
          }
        } catch {
          // malformed line, drop it
        }
      }

      // Re-read before rewriting: another process may have appended while
      // reports were sending. Remove only the lines read above (counted, so
      // a report queued twice is removed exactly twice) and keep the rest.
      const consumed = new Map<string, number>()
      for (const line of lines) consumed.set(line, (consumed.get(line) ?? 0) + 1)
      const current = await fs.readFile(pendingQueuePath, "utf-8").catch(() => "")
      const appended = current
        .split("\n")
        .filter(Boolean)
        .filter((line) => {
          const count = consumed.get(line) ?? 0
          if (!count) return true
          consumed.set(line, count - 1)
          return false
        })

      const remaining = [...retry, ...appended]
      if (remaining.length) {
        await fs.writeFile(pendingQueuePath, remaining.join("\n") + "\n")
        return
      }
      await fs.unlink(pendingQueuePath).catch(() => {})
    } catch (e) {
      log.warn("usage queue flush failed", { error: e instanceof Error ? e.message : String(e) })
    }
  }

  // === Devices ===

  export interface DeviceInfo {
    key_id: string
    name: string
    key_prefix: string
    created_at: string
    last_used_at: string | null
    expires_at: string | null
  }

  /** List authenticated devices for the current user. */
  export async function listDevices(): Promise<DeviceInfo[] | null> {
    const session = await getSession()
    if (!session) return null
    try {
      const res = await authenticatedAtlasFetch(session, `${API_BASE}/api/cli/devices`, {
        headers: { Authorization: `Bearer ${session.api_key}` },
      })
      if (!res.ok) {
        log.warn("failed to list devices", { status: res.status })
        return null
      }
      return (await res.json()) as DeviceInfo[]
    } catch (e) {
      log.warn("list devices error", { error: e instanceof Error ? e.message : String(e) })
      return null
    }
  }

  /** Revoke a device (its api_key is revoked server-side). */
  export async function revokeDevice(keyId: string): Promise<boolean> {
    const session = await getSession()
    if (!session) return false
    try {
      const res = await authenticatedAtlasFetch(session, `${API_BASE}/api/cli/devices/${encodeURIComponent(keyId)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${session.api_key}` },
      })
      return res.ok || res.status === 204
    } catch (e) {
      log.warn("revoke device error", { error: e instanceof Error ? e.message : String(e) })
      return false
    }
  }

  // === Wallet / credits ===

  export interface Credits {
    /** Purchased Wallet balance. Promotional credits are reported separately. */
    balanceUsd: number
    balanceCents: number
    /** @deprecated Use balanceCents. */
    cliBalanceCents: number
    /** Total amount currently available for server-side spend, including promotions. */
    spendableBalanceCents: number
    promotionalBalanceCents: number
    cycleCreditsRemainingCents: number
    /** Null when lifetime-spend metadata is unavailable. */
    lifetimeSpentCents: number | null
  }

  /** Resolve the canonical wallet while accepting older Atlas responses. */
  export function walletCents(d: {
    cli_balance_cents?: number
    unified_balance_cents?: number
    balance_cents?: number
  }): number {
    return d.balance_cents ?? d.cli_balance_cents ?? d.unified_balance_cents ?? 0
  }

  export async function getCredits(): Promise<Credits | null> {
    const session = await getSession()
    if (!session) return null
    try {
      let currentWallet = true
      let res = await authenticatedAtlasFetch(session, `${API_BASE}/api/v1/wallet`, {
        headers: { Authorization: `Bearer ${session.api_key}` },
      })
      if (res.status === 404 || res.status === 405) {
        currentWallet = false
        res = await authenticatedAtlasFetch(session, `${API_BASE}/api/credits`, {
          headers: { Authorization: `Bearer ${session.api_key}` },
        })
      }
      if (!res.ok) return null
      const d = (await res.json()) as {
        unified_balance_cents?: number
        balance_cents?: number
        cli_balance_cents?: number
        purchased_cents?: number
        purchased_credits_cents?: number
        promotional_cents?: number
        cycle_credits_remaining_cents?: number
        lifetime_spent_cents?: number
      }
      // Current Wallet funding buckets are authoritative. During a rolling
      // deploy, lifetime spend may still live only on the preserved credits
      // endpoint; merge that display-only field without overriding balances.
      let lifetimeSpent = d.lifetime_spent_cents ?? null
      if (currentWallet && lifetimeSpent === null) {
        try {
          const metadata = await authenticatedAtlasFetch(session, `${API_BASE}/api/credits`, {
            headers: { Authorization: `Bearer ${session.api_key}` },
          })
          if (metadata.ok) {
            const legacy = (await metadata.json()) as { lifetime_spent_cents?: number }
            lifetimeSpent = legacy.lifetime_spent_cents ?? null
          }
        } catch (error) {
          log.warn("Wallet lifetime-spend metadata read failed", {
            error: error instanceof Error ? error.message : String(error),
          })
        }
      }
      const spendable = walletCents(d)
      const promotional = d.promotional_cents ?? d.cycle_credits_remaining_cents ?? 0
      const purchased = d.purchased_cents ?? d.purchased_credits_cents ?? spendable - promotional
      return {
        balanceUsd: purchased / 100,
        balanceCents: purchased,
        cliBalanceCents: purchased,
        spendableBalanceCents: spendable,
        promotionalBalanceCents: promotional,
        cycleCreditsRemainingCents: promotional,
        lifetimeSpentCents: lifetimeSpent,
      }
    } catch (e) {
      log.warn("getCredits error", { error: e instanceof Error ? e.message : String(e) })
      return null
    }
  }

  export interface Transaction {
    id: string
    amountCents: number
    source: string
    description: string
    createdAt: string
  }

  export async function getTransactions(limit = 20): Promise<Transaction[] | null> {
    const session = await getSession()
    if (!session) return null
    try {
      const res = await authenticatedAtlasFetch(session, `${API_BASE}/api/credits/transactions`, {
        headers: { Authorization: `Bearer ${session.api_key}` },
      })
      if (!res.ok) return null
      const body = (await res.json()) as
        | Array<Record<string, unknown>>
        | { transactions?: Array<Record<string, unknown>> }
      const rows = Array.isArray(body) ? body : (body.transactions ?? [])
      return rows.slice(0, limit).map((r) => ({
        id: String(r["id"] ?? ""),
        amountCents: Number(r["amount_cents"] ?? 0),
        source: String(r["source"] ?? ""),
        description: String(r["description"] ?? ""),
        createdAt: String(r["created_at"] ?? ""),
      }))
    } catch (e) {
      log.warn("getTransactions error", { error: e instanceof Error ? e.message : String(e) })
      return null
    }
  }

  // === Local model-access mode + server capability compatibility ===

  export interface BillingMode {
    mode: "byok" | "managed"
    balance_cents: number
    balance_usd: number
    managed_supported: boolean
  }

  interface CliAccess {
    cli_balance_cents?: number
    managed_supported?: boolean
  }

  interface BillingCompatibility {
    access?: CliAccess
    legacy?: BillingMode
    legacyEndpoint: "available" | "retired" | "unavailable"
  }

  // Legacy account-mode mirroring is deliberately serialized. Settings writes
  // are acknowledged from local Config immediately, while this tail preserves
  // click order across slow old Atlas deployments. The generation check also
  // coalesces work that has not reached its POST yet, so an older Credits click
  // can never finish after a newer Accounts/Automatic click and become the
  // server's final mode.
  let billingMirrorGeneration = 0
  let billingMirrorTail: Promise<void> = Promise.resolve()

  async function readBillingCompatibility(session: OpenScienceSession): Promise<BillingCompatibility> {
    const headers = { Authorization: `Bearer ${session.api_key}` }
    const [accessResult, legacyResult] = await Promise.allSettled([
      authenticatedAtlasFetch(session, `${API_BASE}/api/cli/access`, { headers }),
      authenticatedAtlasFetch(session, `${API_BASE}/api/cli/billing-mode`, { headers }),
    ])
    const accessResponse = accessResult.status === "fulfilled" ? accessResult.value : undefined
    const legacyResponse = legacyResult.status === "fulfilled" ? legacyResult.value : undefined
    const access = accessResponse?.ok ? ((await accessResponse.json()) as CliAccess) : undefined
    const legacy = legacyResponse?.ok ? ((await legacyResponse.json()) as BillingMode) : undefined
    const legacyEndpoint = legacy
      ? "available"
      : legacyResponse && (legacyResponse.status === 404 || legacyResponse.status === 405)
        ? "retired"
        : "unavailable"
    if (!access && accessResult.status === "rejected") {
      log.warn("model access capability read failed", {
        error: accessResult.reason instanceof Error ? accessResult.reason.message : String(accessResult.reason),
      })
    }
    return { access, legacy, legacyEndpoint }
  }

  function scheduleLegacyBillingMirror(
    session: OpenScienceSession,
    mode: "byok" | "managed",
    generation: number,
  ): void {
    billingMirrorTail = billingMirrorTail.then(async () => {
      if (generation !== billingMirrorGeneration) return
      try {
        const compatibility = await readBillingCompatibility(session)
        if (generation !== billingMirrorGeneration) return
        if (compatibility.legacyEndpoint === "available") {
          const res = await authenticatedAtlasFetch(session, `${API_BASE}/api/cli/billing-mode`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${session.api_key}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ mode }),
          })
          if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`)
          // A newer local choice is already queued. Let that choice become the
          // final legacy POST before refreshing synced account material.
          if (generation !== billingMirrorGeneration) return
          await syncServices().catch((error) =>
            log.warn("legacy model-access sync deferred", {
              error: error instanceof Error ? error.message : String(error),
            }),
          )
        } else if (compatibility.legacyEndpoint === "unavailable") {
          log.warn("legacy model-access mirror unavailable; local setting saved", { mode })
        }
      } catch (error) {
        log.warn("legacy model-access mirror deferred; local setting saved", {
          mode,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    })
  }

  /** Wait for already-scheduled compatibility mirroring. Local callers do not
   * need this; it exists for deterministic shutdown and regression tests. */
  export async function waitForBillingModeMirror(): Promise<void> {
    await billingMirrorTail
  }

  export async function getBillingMode(): Promise<BillingMode | null> {
    const session = await getSession()
    if (!session) return null
    const [{ Config }, access, credits] = await Promise.all([
      import("../config/config"),
      readBillingCompatibility(session),
      getCredits().catch(() => null),
    ])
    const configured = (await Config.getGlobal()).billing?.llm
    const fallback = access.legacy
    const balanceCents = credits?.balanceCents ?? fallback?.balance_cents ?? 0
    return {
      mode: configured === "managed" ? "managed" : configured === "byok" ? "byok" : (fallback?.mode ?? "byok"),
      balance_cents: balanceCents,
      balance_usd: balanceCents / 100,
      // Current Atlas publishes this on /access. A temporary capability-read
      // outage must not disable the local Credits choice; dispatch remains the
      // authoritative fail-closed boundary.
      managed_supported: access.access?.managed_supported ?? fallback?.managed_supported ?? true,
    }
  }

  export async function setBillingMode(
    mode: "byok" | "managed",
    localMode: "byok" | "managed" | null = mode,
  ): Promise<BillingMode | null> {
    // The setting controls this local runtime first. Persist and invalidate
    // before any network work so Accounts remains usable during an outage and
    // Credits never silently retains a stale own-key provider map.
    const { Config } = await import("../config/config")
    await Config.updateGlobal({ billing: { llm: localMode } })
    const { Provider } = await import("../provider/provider")
    Provider.invalidate()

    // Invalidate any older in-flight mirror even when this write happens while
    // signed out. Local Config remains the routing authority in every case.
    const mirrorGeneration = ++billingMirrorGeneration

    const session = await getSession()
    if (!session) return null

    // Compatibility mirroring is deliberately off the UI acknowledgement
    // path. A hanging retired endpoint must never keep Accounts unusable or a
    // saved local mode looking unsaved. The process-wide account refresh will
    // retry service synchronization later if this best-effort pass stalls.
    scheduleLegacyBillingMirror(session, mode, mirrorGeneration)
    return null
  }

  export interface LegacyInstalledSkillEntry {
    id: string
    namespace: string
    name: string
    description: string
    repo_url: string
    pinned_sha: string
    review_verdict: string
    review_meta: string | null
    installed_at: string
  }

  export async function fetchLegacyInstalledSkills(): Promise<LegacyInstalledSkillEntry[] | null> {
    const session = await getSession()
    if (!session) return null
    try {
      const res = await authenticatedAtlasFetch(
        session,
        `${API_BASE}/api/cli/installed-skills`,
        { headers: { Authorization: `Bearer ${session.api_key}` } },
        SKILL_FETCH_TIMEOUT_MS,
      )
      if (!res.ok) {
        log.warn("failed to export legacy installed skills", { status: res.status })
        return null
      }
      return await res.json()
    } catch (e) {
      log.warn("legacy installed skills export error", { error: e instanceof Error ? e.message : String(e) })
      return null
    }
  }
}

CredentialLifecycle.onRefresh(() => OpenScience.reloadSyncedEnv())

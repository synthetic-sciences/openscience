import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import z from "zod"
import { Auth } from "@/auth"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { CredentialLifecycle } from "@/credentials/lifecycle"
import { isAtlasManagedKey, isWorkspaceKey } from "@/credentials/managed-key"
import { CredentialOverlay } from "@/credentials/overlay"
import { Global } from "@/global"
import { DataRootBarrier } from "@/global/data-root-barrier"
import { ToolOutputPath } from "@/tool/tool-output-path"
import { Lock } from "@/util/lock"
import { Log } from "@/util/log"
import { BILLING_URL, managedApiBase } from "@/endpoints"
import {
  BYOK_LLM_BASE_URL_KEYS,
  BYOK_LLM_ENV_KEYS,
  LOCAL_COMPUTE_CLI_ENV_KEYS,
  SYNCED_SERVICE_ENV_KEYS,
} from "./synced-env-policy"
import { WorkspaceCredentials } from "./workspace-credentials"

const log = Log.create({ service: "openscience" })

function apiBase(): string {
  return managedApiBase()
}

export interface OpenScienceSession {
  api_key: string
  user_id: string
  device_name?: string
  organization_id?: string
  workspace_locked?: boolean
}

export interface FundingOrganization {
  organization_id: string
  name: string
  slug: string
  is_personal: boolean
  status: string
  role: string
  membership_status: string
  funding_available: boolean
  effective_permissions: string[]
}

export interface FundingSnapshot {
  readonly api_key: string
  readonly user_id: string
  readonly account: string
  readonly organization_id?: string
  readonly workspace_locked?: boolean
}

export interface FundingContext {
  type: "personal" | "organization"
  organization_id?: string
  available: boolean
  locked: boolean
  organizations: FundingOrganization[]
}

export interface AccountProfile {
  user_id?: string
  email?: string | null
  display_name?: string | null
  github_username?: string | null
  [key: string]: unknown
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

export class FundingContextError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "FundingContextError"
  }
}

const knownSecrets = new Set<string>()

const TOKEN_SECRET_PATTERNS = [
  /odp_v2\.[a-f0-9]{10,138}\.[a-f0-9]{32}\.[a-f0-9]{32}\.[a-f0-9]{64}/gi,
  /\b(?:thk[_-]|osk_|sk-|sk_|gsk_|hf_|nvapi-|ghp_|gho_|ghu_|ghs_|github_pat_|xox[baprs]-)[A-Za-z0-9._-]{8,}\b/g,
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

const SAFE_ENV_KEYS = new Set([
  ...BYOK_LLM_ENV_KEYS,
  ...BYOK_LLM_BASE_URL_KEYS,
  ...SYNCED_SERVICE_ENV_KEYS,
  "OPENSCIENCE_RUNTIME",
])
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
const CONTROL_PLANE_ENV_KEYS = new Set(["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", ...LOCAL_COMPUTE_CLI_ENV_KEYS])
const CONTROL_PLANE_ENV_PREFIXES = ["OPENSCIENCE_DESKTOP_UPDATE_", "OPENSCIENCE_DESKTOP_PARENT_"]

const managedProxyPath = (value: unknown) => {
  if (typeof value !== "string") return false
  try {
    let pathname = new URL(value).pathname
    for (let pass = 0; pass < 3 && pathname.includes("%"); pass++) {
      const next = decodeURIComponent(pathname)
      if (next === pathname) break
      pathname = next
    }
    return /\/api\/llm\/proxy(?:\/|$)/.test(pathname.replace(/\/+/g, "/"))
  } catch {
    return false
  }
}

const BYOK_SUBPROCESS_PROVIDERS: Record<string, { keys: string[]; baseUrl?: string; publicBaseUrl?: string }> = {
  openai: { keys: ["OPENAI_API_KEY"], baseUrl: "OPENAI_BASE_URL", publicBaseUrl: "https://api.openai.com/v1" },
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
  xai: { keys: ["XAI_API_KEY"], baseUrl: "XAI_BASE_URL", publicBaseUrl: "https://api.x.ai/v1" },
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
  groq: { keys: ["GROQ_API_KEY"], baseUrl: "GROQ_BASE_URL", publicBaseUrl: "https://api.groq.com/openai/v1" },
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
  mistral: { keys: ["MISTRAL_API_KEY"], baseUrl: "MISTRAL_BASE_URL", publicBaseUrl: "https://api.mistral.ai/v1" },
  deepseek: { keys: ["DEEPSEEK_API_KEY"], baseUrl: "DEEPSEEK_BASE_URL", publicBaseUrl: "https://api.deepseek.com" },
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

export class InsufficientCreditsError extends Error {
  constructor(message = `Credits are empty. Add credits at ${BILLING_URL} or switch back to your own keys.`) {
    super(message)
    this.name = "InsufficientCreditsError"
  }
}

const SESSION_PATH = path.join(Global.Path.data, "openscience-session.json")
const SCOPE_PATH = path.join(Global.Path.data, "openscience-workspace-scope.json")
const SNAPSHOT_PATH = path.join(Global.Path.data, "openscience-account-snapshot.json")
// A persisted account summary younger than this is served as current; an
// older one is served at once and refreshed in the background.
const ACCOUNT_SNAPSHOT_TTL_MS = 30_000
// After a failed refresh the stored summary is served without a new attempt
// for this long, so a down account service is not hammered by every open panel.
const ACCOUNT_RETRY_MS = 5_000
// A stale summary younger than this is served as it is instead of starting
// another refresh. A spend marks the summary stale, and with a settings panel
// open every managed response would otherwise become three account reads
// (status, entitlement, wallet); the next read after the interval refreshes it.
const ACCOUNT_REFRESH_MIN_MS = 5_000
const FUNDING_PROTOCOL = "1"
const FUNDING_PROTOCOL_HEADER = "OpenScience-Funding-Protocol"
const FUNDING_CONTEXT_HEADER = "OpenScience-Funding-Context"
const ATLAS_FETCH_TIMEOUT_MS = Number(process.env.OPENSCIENCE_ATLAS_TIMEOUT_MS) || 60_000
const DEVICE_REVOKE_TIMEOUT_MS = 5_000
// Resolved per call so `SYNSC_AUTH_URL` and the managed-base overrides apply as
// the process environment stands, not as it stood at import.
function verificationPage(): string {
  return process.env.SYNSC_AUTH_URL?.replace(/\/+$/, "") || `${apiBase()}/cli`
}

interface WorkspaceScope {
  protocol: 1
  key_fingerprint: string
  organization_id?: string
  workspace_locked: true
}

interface AuthStatusResponse {
  user?: AccountProfile
  organizations?: unknown
  available_organizations?: unknown
  api_key?: { organization_id?: unknown; workspace_locked?: unknown }
  funding_context?: { type?: "personal" | "organization"; organization_id?: string; locked?: boolean }
}

interface AuthStatus {
  organizations: FundingOrganization[]
  pinned?: string
  locked: boolean
  context?: AuthStatusResponse["funding_context"]
  user?: AccountProfile
}

function isAccountKey(value: unknown): value is string {
  return typeof value === "string" && (value.startsWith("thk_") || value.startsWith("osk_"))
}

function isLegacyUnscoped(session: Pick<OpenScienceSession, "api_key" | "organization_id" | "workspace_locked">) {
  return session.api_key.startsWith("thk_") && !session.organization_id && session.workspace_locked !== true
}

function validOrganizationID(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

function loginOrganizationID(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined
  if (validOrganizationID(value)) return value
  throw new Error("Login returned an invalid organization id.")
}

function keyFingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex")
}

function accountTag(session: Pick<OpenScienceSession, "api_key" | "user_id">): string {
  return session.user_id || `k:${keyFingerprint(session.api_key).slice(0, 16)}`
}

function contextTag(session: Pick<OpenScienceSession, "api_key" | "user_id" | "organization_id">): string {
  return `${accountTag(session)}\0${session.organization_id ? `organization:${session.organization_id}` : "personal"}`
}

// One outbound account read per (kind, key, funding context) at a time. A
// managed turn, the settings panels and credential sync all check the same
// account; while one read is in flight the others join it instead of
// repeating the request.
interface Flight<T> {
  promise: Promise<T>
  controller: AbortController
  waiting: number
  settled: boolean
}
const flights = new Map<string, Flight<unknown>>()

function flightKey(
  kind: string,
  session: Pick<OpenScienceSession, "api_key" | "user_id" | "organization_id" | "workspace_locked">,
): string {
  return [
    kind,
    keyFingerprint(session.api_key),
    session.user_id,
    session.organization_id ?? "personal",
    session.workspace_locked ? "locked" : "open",
  ].join("\0")
}

/** Join the in-flight read for `key`, starting it when there is none. The
 * read runs under its own signal; a caller's signal only detaches that
 * caller, and the read is cancelled once every caller has detached, so an
 * abandoned panel never leaves account requests running. */
function share<T>(key: string, start: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) return Promise.reject(signal.reason)
  const flight = (flights.get(key) as Flight<T> | undefined) ?? launch(key, start)
  flight.waiting++
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      flight.waiting--
      if (flight.waiting === 0 && !flight.settled) {
        flight.controller.abort(signal?.reason)
        // A caller arriving before the cancelled read settles starts its
        // own instead of inheriting this cancellation.
        if (flights.get(key) === flight) flights.delete(key)
      }
      reject(signal?.reason)
    }
    signal?.addEventListener("abort", abort, { once: true })
    flight.promise.then(resolve, reject).finally(() => {
      if (signal?.aborted) return
      signal?.removeEventListener("abort", abort)
      flight.waiting--
    })
  })
}

function launch<T>(key: string, start: (signal: AbortSignal) => Promise<T>): Flight<T> {
  const controller = new AbortController()
  const flight: Flight<T> = { controller, waiting: 0, settled: false, promise: start(controller.signal) }
  flight.promise
    .finally(() => {
      flight.settled = true
      if (flights.get(key) === flight) flights.delete(key)
    })
    .catch(() => undefined)
  flights.set(key, flight)
  return flight
}

async function atomicWrite(filepath: string, content: string, mode = 0o600): Promise<void> {
  await using operation = await DataRootBarrier.enter(filepath)
  const temp = `${filepath}.${process.pid}.${randomUUID()}.tmp`
  await fs.mkdir(path.dirname(filepath), { recursive: true })
  try {
    const handle = await fs.open(temp, "wx", mode)
    await handle
      .writeFile(content, "utf8")
      .then(() => (process.platform === "win32" ? undefined : handle.chmod(mode)))
      .then(() => handle.sync())
      .finally(() => handle.close())
    await fs.rename(temp, filepath)
    const directory = await fs.open(path.dirname(filepath), "r").catch(() => undefined)
    await directory?.sync().catch(() => undefined)
    await directory?.close().catch(() => undefined)
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined)
    throw error
  }
}

function atlasFetch(input: string, init: RequestInit = {}, timeoutMs = ATLAS_FETCH_TIMEOUT_MS): Promise<Response> {
  const timeout = AbortSignal.timeout(timeoutMs)
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout
  return fetch(input, { ...init, signal })
}

async function readWorkspaceScope(key: string): Promise<WorkspaceScope | null | undefined> {
  if (!existsSync(SCOPE_PATH)) return undefined
  try {
    const value = (await Bun.file(SCOPE_PATH).json()) as Partial<WorkspaceScope>
    if (value.protocol !== 1 || value.workspace_locked !== true) return null
    if (value.key_fingerprint !== keyFingerprint(key)) return undefined
    if (value.organization_id !== undefined && !validOrganizationID(value.organization_id)) return null
    return {
      protocol: 1,
      key_fingerprint: value.key_fingerprint,
      ...(value.organization_id ? { organization_id: value.organization_id } : {}),
      workspace_locked: true,
    }
  } catch {
    return null
  }
}

async function writeWorkspaceScope(session: OpenScienceSession): Promise<void> {
  if (!session.workspace_locked) {
    if (isWorkspaceKey(session.api_key))
      throw new FundingContextError("Workspace credentials require an immutable workspace.")
    await fs.rm(SCOPE_PATH, { force: true }).catch(() => undefined)
    return
  }
  if (isWorkspaceKey(session.api_key) && !session.organization_id) {
    throw new FundingContextError("A workspace credential is missing its workspace id.")
  }
  await atomicWrite(
    SCOPE_PATH,
    JSON.stringify(
      {
        protocol: 1,
        key_fingerprint: keyFingerprint(session.api_key),
        ...(session.organization_id ? { organization_id: session.organization_id } : {}),
        workspace_locked: true,
      } satisfies WorkspaceScope,
      null,
      2,
    ),
  )
}

function organizations(value: unknown): FundingOrganization[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return []
    const row = item as Record<string, unknown>
    const id = typeof row.organization_id === "string" ? row.organization_id : row.id
    if (!validOrganizationID(id) || typeof row.name !== "string" || !row.name.trim()) return []
    return [
      {
        organization_id: id,
        name: row.name,
        slug: typeof row.slug === "string" ? row.slug : "",
        is_personal: row.is_personal === true,
        status: typeof row.status === "string" ? row.status : "active",
        role: typeof row.role === "string" ? row.role : "member",
        membership_status: typeof row.membership_status === "string" ? row.membership_status : "active",
        funding_available: row.funding_available === true,
        effective_permissions: Array.isArray(row.effective_permissions)
          ? row.effective_permissions.filter((value): value is string => typeof value === "string")
          : row.effective_permissions && typeof row.effective_permissions === "object"
            ? Object.entries(row.effective_permissions).flatMap(([name, allowed]) => (allowed === true ? [name] : []))
            : [],
      },
    ]
  })
}

function organizationAvailable(row: FundingOrganization | undefined): boolean {
  return (
    !!row &&
    row.status === "active" &&
    row.membership_status === "active" &&
    row.funding_available &&
    row.effective_permissions.includes("use_shared_wallet")
  )
}

async function accountAtlasFetch(
  session: Pick<OpenScienceSession, "api_key" | "organization_id">,
  input: string,
  init: RequestInit = {},
  funding = false,
  timeoutMs = ATLAS_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const headers = new Headers(init.headers)
  headers.set("Authorization", `Bearer ${session.api_key}`)
  headers.delete("X-Organization-ID")
  headers.delete(FUNDING_PROTOCOL_HEADER)
  if (funding) {
    headers.set(FUNDING_PROTOCOL_HEADER, FUNDING_PROTOCOL)
    if (session.organization_id) headers.set("X-Organization-ID", session.organization_id)
  }
  const response = await atlasFetch(input, { ...init, headers }, timeoutMs)
  if (response.status === 401) void OpenScience.clearSession(session.api_key).catch(() => undefined)
  return response
}

async function authenticatedAtlasFetch(
  session: OpenScienceSession,
  input: string,
  init: RequestInit = {},
  timeoutMs = ATLAS_FETCH_TIMEOUT_MS,
): Promise<Response> {
  return accountAtlasFetch(session, input, init, false, timeoutMs)
}

async function fundedAtlasFetch(
  session: FundingSnapshot | OpenScienceSession,
  input: string,
  init: RequestInit = {},
  timeoutMs = ATLAS_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const response = await accountAtlasFetch(session, input, init, true, timeoutMs)
  return OpenScience.validateFundingResponse(response, session)
}

async function revokeSessionDevice(
  session: OpenScienceSession,
  timeoutMs = DEVICE_REVOKE_TIMEOUT_MS,
): Promise<boolean> {
  try {
    const response = await authenticatedAtlasFetch(
      session,
      `${apiBase()}/api/cli/devices/current`,
      { method: "DELETE" },
      timeoutMs,
    )
    return response.status === 204
  } catch {
    return false
  }
}

export namespace OpenScience {
  let loginWarning: string | undefined

  export function getLoginWarning(): string | undefined {
    return loginWarning
  }

  export async function getSession(): Promise<OpenScienceSession | null> {
    if (!existsSync(SESSION_PATH)) return null
    try {
      const data = (await Bun.file(SESSION_PATH).json()) as Partial<OpenScienceSession>
      if (!isAccountKey(data.api_key)) return null
      const persistedOrganizationID = loginOrganizationID(data.organization_id)
      const scope = await readWorkspaceScope(data.api_key)
      if (scope === null) throw new FundingContextError("The saved workspace scope is invalid. Sign in again.")
      const organizationID = scope ? scope.organization_id : persistedOrganizationID
      const locked = scope?.workspace_locked === true || data.workspace_locked === true
      return {
        api_key: data.api_key,
        user_id: typeof data.user_id === "string" ? data.user_id : "",
        device_name: typeof data.device_name === "string" ? data.device_name : undefined,
        ...(organizationID ? { organization_id: organizationID } : {}),
        ...(locked ? { workspace_locked: true } : {}),
      }
    } catch (error) {
      log.warn("could not read account session", { error: error instanceof Error ? error.message : String(error) })
      return null
    }
  }

  export async function saveSession(session: OpenScienceSession): Promise<void> {
    if (!isAccountKey(session.api_key)) throw new Error("Invalid OpenScience account key.")
    if (session.organization_id !== undefined && !validOrganizationID(session.organization_id)) {
      throw new Error("Invalid organization id.")
    }
    await CredentialLifecycle.mutate("managed-session.set", async () => {
      using _ = await Lock.write(SESSION_PATH)
      await writeWorkspaceScope(session)
      await atomicWrite(SESSION_PATH, JSON.stringify(session, null, 2))
      // A summary belongs to one account and funding context; never let a
      // newly connected account inherit the previous one's stored profile.
      await fs.rm(SNAPSHOT_PATH, { force: true }).catch(() => undefined)
    })
    invalidateBalance()
    const { Provider } = await import("@/provider/provider")
    Provider.invalidate()
  }

  /** Activate a newly proved device before retiring the previous one. A failed
   * first sync may leave the new credential usable offline, but an auth failure
   * that cleared it must never be reported as a successful login. */
  async function activateSession(session: OpenScienceSession): Promise<OpenScienceSession> {
    return CredentialLifecycle.serialized(async () => {
      loginWarning = undefined
      const previous = await getSession()
      await saveSession(session)
      await syncCredentials({ force: true })
      const current = await getSession()
      if (!current || current.api_key !== session.api_key) {
        await revokeSessionDevice(session)
        throw new Error("This device could not verify the new login. Sign in again.")
      }
      if (previous && previous.api_key !== current.api_key && !(await revokeSessionDevice(previous))) {
        loginWarning =
          "Signed in, but the previous device could not be revoked remotely. You can remove it from account settings."
      }
      return current
    })
  }

  /** Persist the immutable workspace proved by Atlas for sessions written by
   * an older client that discarded it. The comparison is repeated under both
   * credential and file locks so a slow response for account A cannot relabel
   * a newly connected account B. */
  async function reconcileSession(
    expected: OpenScienceSession,
    organizationID: string | undefined,
    userID: string,
  ): Promise<OpenScienceSession | null> {
    const matches = (current: OpenScienceSession | null) =>
      !!current &&
      current.api_key === expected.api_key &&
      current.user_id === expected.user_id &&
      current.organization_id === expected.organization_id &&
      current.workspace_locked === expected.workspace_locked
    const next = {
      ...expected,
      user_id: userID || expected.user_id,
      ...(organizationID ? { organization_id: organizationID } : {}),
      workspace_locked: true,
    }
    if (!organizationID) delete next.organization_id
    if (
      next.user_id === expected.user_id &&
      next.organization_id === expected.organization_id &&
      expected.workspace_locked === true
    ) {
      return expected
    }
    const result = await CredentialLifecycle.mutateIf(
      "managed-session.reconcile",
      async () => matches(await getSession()),
      async () => {
        using _ = await Lock.write(SESSION_PATH)
        const current = await getSession()
        if (!matches(current)) return null
        await writeWorkspaceScope(next)
        await atomicWrite(SESSION_PATH, JSON.stringify(next, null, 2))
        // The stored summary is bound to the funding context this rewrite
        // changes; drop it like saveSession does.
        await fs.rm(SNAPSHOT_PATH, { force: true }).catch(() => undefined)
        return next
      },
    )
    if (!result.applied || !result.value) return null
    invalidateBalance()
    const { Provider } = await import("@/provider/provider")
    Provider.invalidate()
    return result.value
  }

  export async function clearSession(expectedApiKey?: string): Promise<boolean> {
    const action = async () => {
      using _ = await Lock.write(SESSION_PATH)
      if (expectedApiKey && (await getSession())?.api_key !== expectedApiKey) return false
      await fs.rm(SESSION_PATH, { force: true })
      await fs.rm(SCOPE_PATH, { force: true })
      await fs.rm(SNAPSHOT_PATH, { force: true })
      await WorkspaceCredentials.clear()
      return true
    }
    const result = await CredentialLifecycle.mutate("managed-session.clear", action)
    if (result) {
      invalidateBalance()
      const { Provider } = await import("@/provider/provider")
      Provider.invalidate()
    }
    return result
  }

  export async function isAuthenticated(): Promise<boolean> {
    return (await getSession()) !== null
  }

  export function deviceName(): string {
    let host = "device"
    try {
      host = os.hostname().split(".")[0] || host
    } catch {}
    return `openscience · ${process.platform} · ${host}`
  }

  export function authPageUrl(): string {
    return verificationPage()
  }

  export async function getFundingSnapshot(): Promise<FundingSnapshot | null> {
    const session = await getSession()
    if (!session) return null
    return Object.freeze({
      api_key: session.api_key,
      user_id: session.user_id,
      account: accountTag(session),
      ...(session.organization_id ? { organization_id: session.organization_id } : {}),
      ...(session.workspace_locked ? { workspace_locked: true } : {}),
    })
  }

  /** The funding snapshot a managed request charges against. A scoped session
   * is served from the local session file with no account read; only a legacy
   * unscoped session still needs the status read to learn its workspace before
   * dispatch. Authorization is proved per request instead: the balance check
   * and every spend-capable response must echo this exact funding context. */
  export async function getRequestSnapshot(): Promise<FundingSnapshot | null> {
    const snapshot = await getFundingSnapshot()
    if (!snapshot) return null
    if (!isLegacyUnscoped(snapshot)) return snapshot
    return (await getReconciledFundingState())?.snapshot ?? null
  }

  export async function managedRequestSnapshot(
    apiKey?: string,
    snapshot?: FundingSnapshot | null,
  ): Promise<FundingSnapshot> {
    if (!apiKey || !isAtlasManagedKey(apiKey)) throw new FundingContextError("Expected an Atlas managed API key.")
    const selected = await (async () => {
      if (!snapshot) return (await getReconciledFundingState())?.snapshot
      if (!isLegacyUnscoped(snapshot)) return snapshot
      const state = await getReconciledFundingState()
      if (state?.snapshot.api_key !== snapshot.api_key) return
      return state.snapshot
    })()
    if (selected) {
      if (selected.api_key !== apiKey) {
        throw new FundingContextError("The connected account changed during managed inference. Retry it.")
      }
      const current = await getFundingSnapshot()
      if (!current && existsSync(SESSION_PATH)) {
        throw new FundingContextError("OpenScience could not safely read the selected funding account. Sign in again.")
      }
      if (
        current &&
        (current.api_key !== selected.api_key ||
          current.user_id !== selected.user_id ||
          current.organization_id !== selected.organization_id ||
          current.workspace_locked !== selected.workspace_locked)
      ) {
        throw new FundingContextError("The connected account changed during managed inference. Retry it.")
      }
      return selected
    }
    throw new FundingContextError("OpenScience could not safely read the selected funding account. Sign in again.")
  }

  export function fundingHeaders(snapshot: Pick<FundingSnapshot, "organization_id">): Record<string, string> {
    return {
      [FUNDING_PROTOCOL_HEADER]: FUNDING_PROTOCOL,
      ...(snapshot.organization_id ? { "X-Organization-ID": snapshot.organization_id } : {}),
    }
  }

  export async function validateFundingResponse(
    response: Response,
    snapshot?: Pick<FundingSnapshot, "api_key" | "organization_id">,
  ): Promise<Response> {
    if (!snapshot || !response.ok) return response
    const protocol = response.headers.get(FUNDING_PROTOCOL_HEADER)
    const context = response.headers.get(FUNDING_CONTEXT_HEADER)
    if (!snapshot.organization_id && protocol === FUNDING_PROTOCOL && context === "personal") return response
    if (
      snapshot.organization_id &&
      isAtlasManagedKey(snapshot.api_key) &&
      protocol === FUNDING_PROTOCOL &&
      context === `organization:${snapshot.organization_id}`
    ) {
      return response
    }
    await response.body?.cancel().catch(() => undefined)
    throw new FundingContextError("OpenScience could not verify the selected workspace with the gateway.")
  }

  export type SyncStatus = {
    state: "disconnected" | "syncing" | "ready" | "error"
    organization_id?: string
    synced_at?: number
    error?: string
  }
  const syncs = new Map<string, Promise<SyncStatus>>()
  const attempts = new Map<string, number>()
  let synced: SyncStatus = { state: "disconnected" }
  let syncTimer: ReturnType<typeof setInterval> | undefined
  /** Renewal cadence for the synced overlay. The grant lives
   * WorkspaceCredentials.TTL (5 min); a refresh every 4 min meant one failed
   * attempt (a saturated link during a large download, a transient 5xx) let
   * the grant lapse before the next tick. Refresh at under a third of the TTL
   * and retry a failure with short backoff, all inside one TTL. */
  export const SYNC_INTERVAL = 90_000
  export const SYNC_BACKOFF: readonly number[] = [5_000, 15_000, 30_000]

  export function credentialSyncStatus(): SyncStatus {
    return synced
  }

  export async function syncCredentials(options: { force?: boolean; timeoutMs?: number } = {}): Promise<SyncStatus> {
    const session = await getSession()
    if (!session) return (synced = { state: "disconnected" })
    const identity = WorkspaceCredentials.identity(session)
    const identities = new Set([identity])
    const pending = syncs.get(identity)
    if (pending) return pending
    if (!options.force && Date.now() - (attempts.get(identity) ?? 0) < 60_000) return synced
    attempts.set(identity, Date.now())
    const task = (async (): Promise<SyncStatus> => {
      synced = { state: "syncing" }
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const seen: { status?: number } = {}
      const request = (async () => {
        const response = await fetch(`${apiBase()}/api/cli/sync`, {
          headers: { Authorization: `Bearer ${session.api_key}`, ...fundingHeaders(session) },
          signal: controller.signal,
        })
        if (!response.ok) return { response }
        return { response, body: await response.json() }
      })()
      try {
        const result = await Promise.race([
          request,
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort()
              reject(new Error("Credential sync timed out. Retry when connected."))
            }, options.timeoutMs ?? 8_000)
          }),
        ])
        seen.status = result.response.status
        if (result.response.status === 401) {
          await clearSession(session.api_key)
          throw new Error("This device was disconnected. Sign in again.")
        }
        if (result.response.status === 403) {
          await CredentialLifecycle.mutateIf(
            "workspace-sync.denied",
            async () => {
              const current = await getSession()
              return !!current && WorkspaceCredentials.identity(current) === identity
            },
            () => WorkspaceCredentials.clear(),
          )
          throw new Error("Workspace credential access changed. Reconnect or choose an available workspace.")
        }
        if (!result.response.ok) throw new Error(`Credential sync unavailable (${result.response.status}). Try again.`)
        const data = WorkspaceCredentials.parse(result.body)
        if (
          result.response.headers.get(FUNDING_PROTOCOL_HEADER) !== FUNDING_PROTOCOL ||
          result.response.headers.get(FUNDING_CONTEXT_HEADER) !== `organization:${data.snapshot.organization_id}` ||
          (session.organization_id && session.organization_id !== data.snapshot.organization_id) ||
          (session.user_id && session.user_id !== data.user_id)
        ) {
          throw new FundingContextError("Credential sync could not verify the selected workspace. Sign in again.")
        }
        const scoped = await reconcileSession(session, data.snapshot.organization_id, data.user_id)
        if (!scoped) return synced
        const target = WorkspaceCredentials.identity(scoped)
        identities.add(target)
        attempts.set(target, attempts.get(identity) ?? Date.now())
        const matches = async () => {
          const current = await getSession()
          return !!current && WorkspaceCredentials.identity(current) === target
        }
        const applied = await CredentialLifecycle.update(async () => {
          if (!(await matches())) return
          const change = WorkspaceCredentials.change(await WorkspaceCredentials.read(), data.snapshot)
          return {
            reason:
              change === "unchanged"
                ? undefined
                : change === "renew"
                  ? "workspace-sync.renew"
                  : "workspace-sync.update",
            action: async () => {
              await WorkspaceCredentials.write(scoped, data.snapshot)
              return change
            },
          }
        })
        if (!applied.applied) return synced
        if (applied.value !== "unchanged") {
          await reloadSyncedEnv()
          const { Provider } = await import("@/provider/provider")
          Provider.invalidate()
        }
        if (!(await matches())) return synced
        return (synced = { state: "ready", organization_id: data.snapshot.organization_id, synced_at: Date.now() })
      } catch (error) {
        // A silent failure here is how a grant lapses unnoticed: name the
        // status and error class so the next expiry is diagnosable.
        log.warn("workspace credential sync failed", {
          status: seen.status,
          error: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error ? error.message : String(error),
          expires_at: WorkspaceCredentials.expiresAt(),
        })
        const current = await getSession()
        if (current && !identities.has(WorkspaceCredentials.identity(current))) return synced
        return (synced = {
          state: "error",
          error: error instanceof Error ? error.message : "Credential sync failed. Try again.",
        })
      } finally {
        if (timer) clearTimeout(timer)
        syncs.delete(identity)
      }
    })()
    syncs.set(identity, task)
    return task
  }

  function pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms).unref())
  }

  /** Refresh the synced overlay, retrying a failed attempt with short backoff
   * so one transient failure is retried well before the grant's TTL elapses.
   * An unforced first attempt inside syncCredentials' one-minute dedupe
   * window does not request anything and returns the current status; when
   * that status is a prior error, the forced retry chain starts from it.
   * Retries are always forced. */
  export async function scheduleRefresh(
    options: { backoff?: readonly number[]; force?: boolean } = {},
  ): Promise<SyncStatus> {
    const backoff = options.backoff ?? SYNC_BACKOFF
    const attempt = async (index: number, force: boolean): Promise<SyncStatus> => {
      const result = await syncCredentials({ force })
      if (result.state !== "error") return result
      const delay = backoff[index]
      const expires = WorkspaceCredentials.expiresAt()
      if (delay === undefined) {
        log.error("workspace credential refresh exhausted its retries", {
          error: result.error,
          attempts: index + 1,
          expires_at: expires,
        })
        return result
      }
      log.warn("workspace credential refresh failed; retrying", {
        error: result.error,
        retry_ms: delay,
        remaining: backoff.length - index - 1,
        expires_at: expires,
      })
      await pause(delay)
      return attempt(index + 1, true)
    }
    return attempt(0, options.force ?? false)
  }

  export function startCredentialSync(): void {
    if (syncTimer) return
    void scheduleRefresh()
    syncTimer = setInterval(() => void scheduleRefresh(), SYNC_INTERVAL)
    syncTimer.unref()
  }

  export async function reloadSyncedEnv(): Promise<void> {
    const { applyCredentialEnv } = await import("../server/routes/settings/credentials")
    await applyCredentialEnv({ strict: true })
  }

  const CALLBACK_SUCCESS_HTML =
    "<!doctype html><meta charset=utf-8><title>OpenScience</title>" +
    '<body style="font-family:system-ui,sans-serif;background:#0b0b12;color:#eee;display:grid;place-items:center;height:100vh;margin:0">' +
    '<div style="text-align:center"><h1>Device approved</h1><p>Return to OpenScience to finish connecting your workspace.</p></div>'
  const CALLBACK_ERROR_HTML =
    "<!doctype html><meta charset=utf-8><title>OpenScience</title>" +
    '<body style="font-family:system-ui,sans-serif;background:#0b0b12;color:#eee;display:grid;place-items:center;height:100vh;margin:0">' +
    '<div style="text-align:center"><h1>Login failed</h1><p>Return to OpenScience and try again.</p></div>'

  function startCallbackServer(expectedState: string) {
    let resolve!: (value: { exchange_token: string }) => void
    let reject!: (error: Error) => void
    const done = new Promise<{ exchange_token: string }>((res, rej) => {
      resolve = res
      reject = rej
    })
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname !== "/callback") return new Response("Not found", { status: 404 })
        const state = url.searchParams.get("state") ?? ""
        const token = url.searchParams.get("exchange_token") ?? ""
        if (state !== expectedState || !token) {
          reject(new Error("Browser login failed: callback state mismatch."))
          return new Response(CALLBACK_ERROR_HTML, { status: 400, headers: { "Content-Type": "text/html" } })
        }
        resolve({ exchange_token: token })
        return new Response(CALLBACK_SUCCESS_HTML, { headers: { "Content-Type": "text/html" } })
      },
    })
    return { port: server.port!, done, stop: () => server.stop(true) }
  }

  async function loginError(response: Response, phase: string): Promise<string> {
    if (response.status === 426) return "This OpenScience version is out of date. Update it and try again."
    const detail = (await response.text().catch(() => "")).trim().slice(0, 200)
    return `Login ${phase} failed: HTTP ${response.status}${detail ? ` — ${detail}` : ""}`
  }

  export async function browserLogin(opts?: {
    onApprovalUrl?: (url: string) => void
    timeoutMs?: number
    organizationID?: string
  }): Promise<OpenScienceSession> {
    const state = randomUUID()
    const name = deviceName()
    const callback = startCallbackServer(state)
    const redirectUri = `http://127.0.0.1:${callback.port}/callback`
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const start = await atlasFetch(`${apiBase()}/api/v1/auth/cli/browser/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          state,
          redirect_uri: redirectUri,
          name,
          ...(opts?.organizationID ? { organization_id: opts.organizationID } : {}),
        }),
      })
      if (!start.ok) throw new Error(await loginError(start, "start"))
      const started = (await start.json()) as { approval_url?: unknown }
      if (typeof started.approval_url !== "string" || !started.approval_url) {
        throw new Error("Login start did not return an approval URL.")
      }
      opts?.onApprovalUrl?.(started.approval_url)
      const result = await Promise.race([
        callback.done,
        new Promise<never>((_, rejectTimeout) => {
          timer = setTimeout(
            () => rejectTimeout(new Error("Timed out waiting for browser authorization.")),
            opts?.timeoutMs ?? 300_000,
          )
        }),
      ])
      const redeem = await atlasFetch(`${apiBase()}/api/v1/auth/cli/browser/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ state, exchange_token: result.exchange_token, redirect_uri: redirectUri }),
      })
      if (!redeem.ok) throw new Error(await loginError(redeem, "redeem"))
      const body = (await redeem.json()) as {
        api_key?: unknown
        key?: unknown
        organization_id?: unknown
        workspace_locked?: unknown
        user_id?: unknown
        user?: AccountProfile & { id?: unknown }
      }
      const key = body.api_key ?? body.key
      if (!isAccountKey(key)) throw new Error("Login did not return a valid OpenScience API key.")
      const organizationID = loginOrganizationID(body.organization_id)
      const identity = body.user?.user_id ?? body.user?.id ?? body.user_id
      const session: OpenScienceSession = {
        api_key: key,
        user_id: typeof identity === "string" ? identity : "",
        device_name: name,
        ...(organizationID ? { organization_id: organizationID } : {}),
        ...(body.workspace_locked === true || organizationID ? { workspace_locked: true } : {}),
      }
      return activateSession(session)
    } finally {
      if (timer) clearTimeout(timer)
      callback.stop()
    }
  }

  function readAuthStatus(
    session: FundingSnapshot | OpenScienceSession,
    signal?: AbortSignal,
  ): Promise<AuthStatus | null> {
    return share(flightKey("status", session), (flight) => fetchAuthStatus(session, flight), signal)
  }

  async function fetchAuthStatus(
    session: FundingSnapshot | OpenScienceSession,
    signal: AbortSignal,
  ): Promise<AuthStatus | null> {
    try {
      // Auth status is the sole legacy reconciliation read allowed to accept an
      // organization echo before the old unscoped session has been repaired.
      // Every spend-capable request uses validateFundingResponse's exact scope.
      const response = await accountAtlasFetch(
        session,
        `${apiBase()}/api/v1/auth/status`,
        { headers: { Accept: "application/json" }, signal },
        true,
      )
      if (!response.ok) return null
      const body = (await response.json()) as AuthStatusResponse
      const selected = body.funding_context?.type === "organization" ? body.funding_context.organization_id : undefined
      const pinned = loginOrganizationID(body.api_key?.organization_id ?? selected)
      if (body.api_key?.organization_id && selected && body.api_key.organization_id !== selected) return null
      if (body.funding_context?.type === "personal" && pinned) return null
      const legacy = isLegacyUnscoped(session)
      const user = typeof body.user?.user_id === "string" && body.user.user_id ? body.user.user_id : undefined
      if (session.user_id && user !== session.user_id) return null
      if (!legacy && (!session.user_id || !user || user !== session.user_id)) return null
      if (!legacy && pinned !== session.organization_id) return null
      if (!legacy && session.organization_id && selected !== session.organization_id) return null
      if (!legacy && !session.organization_id && body.funding_context?.type !== "personal") return null
      const expected = legacy
        ? pinned
          ? `organization:${pinned}`
          : "personal"
        : session.organization_id
          ? `organization:${session.organization_id}`
          : "personal"
      if (
        response.headers.get(FUNDING_PROTOCOL_HEADER) !== FUNDING_PROTOCOL ||
        response.headers.get(FUNDING_CONTEXT_HEADER) !== expected
      ) {
        return null
      }
      return {
        organizations: organizations(body.organizations ?? body.available_organizations),
        pinned,
        locked: body.api_key?.workspace_locked === true || body.funding_context?.locked === true || !!pinned,
        context: body.funding_context,
        user: body.user,
      }
    } catch {
      return null
    }
  }

  export async function loginWithKey(rawKey: string): Promise<OpenScienceSession> {
    const key = rawKey.trim()
    if (!isAccountKey(key)) throw new Error("Expected an OpenScience API key starting with `thk_` or `osk_`.")
    const probe = await atlasFetch(`${apiBase()}/api/cli/balance`, {
      headers: { Authorization: `Bearer ${key}`, [FUNDING_PROTOCOL_HEADER]: FUNDING_PROTOCOL },
    })
    if (probe.status === 401 || probe.status === 403)
      throw new Error("That key was rejected. Double-check it and try again.")
    if (!probe.ok) throw new Error(`Could not validate key: HTTP ${probe.status}`)

    const response = await atlasFetch(`${apiBase()}/api/v1/auth/status`, {
      headers: {
        Authorization: `Bearer ${key}`,
        Accept: "application/json",
        [FUNDING_PROTOCOL_HEADER]: FUNDING_PROTOCOL,
      },
    }).catch(() => undefined)
    const status = response?.ok ? ((await response.json()) as AuthStatusResponse) : undefined
    const selected =
      status?.funding_context?.type === "organization" ? status.funding_context.organization_id : undefined
    const organizationID = loginOrganizationID(status?.api_key?.organization_id ?? selected)
    const locked =
      status?.api_key?.workspace_locked === true || status?.funding_context?.locked === true || !!organizationID
    if (isWorkspaceKey(key) && (!locked || !organizationID)) {
      throw new Error("Couldn't verify this workspace key's organization. Check your connection and try again.")
    }
    const session: OpenScienceSession = {
      api_key: key,
      user_id: typeof status?.user?.user_id === "string" ? status.user.user_id : "",
      device_name: deviceName(),
      ...(organizationID ? { organization_id: organizationID } : {}),
      ...(locked ? { workspace_locked: true } : {}),
    }
    return activateSession(session)
  }

  export async function getProfile(
    snapshot?: FundingSnapshot,
    options: { signal?: AbortSignal } = {},
  ): Promise<AccountProfile | null> {
    const session = snapshot ?? (await getFundingSnapshot())
    if (!session) return null
    return (
      (await readAuthStatus(session, options.signal))?.user ?? (session.user_id ? { user_id: session.user_id } : null)
    )
  }

  async function fundingContext(snapshot: FundingSnapshot, status: AuthStatus | null): Promise<FundingContext> {
    if (status?.locked) {
      const current = await getSession()
      if (
        isLegacyUnscoped(snapshot) &&
        current?.api_key === snapshot.api_key &&
        current.user_id === snapshot.user_id &&
        current.organization_id === snapshot.organization_id &&
        current.workspace_locked === snapshot.workspace_locked
      ) {
        await reconcileSession(
          current,
          status.pinned,
          typeof status.user?.user_id === "string" ? status.user.user_id : "",
        )
      }
      if (!status.pinned) {
        return {
          type: "personal",
          available: !status.context || status.context.type === "personal",
          locked: true,
          organizations: status.organizations,
        }
      }
      const row = status.organizations.find((item) => item.organization_id === status.pinned)
      return {
        type: "organization",
        organization_id: status.pinned,
        available:
          organizationAvailable(row) &&
          status.context?.type === "organization" &&
          status.context.organization_id === status.pinned,
        locked: true,
        organizations: status.organizations,
      }
    }
    if (snapshot.organization_id) {
      const row = status?.organizations.find((item) => item.organization_id === snapshot.organization_id)
      const echoed = status?.context
      return {
        type: "organization",
        organization_id: snapshot.organization_id,
        available:
          organizationAvailable(row) &&
          echoed?.type === "organization" &&
          echoed.organization_id === snapshot.organization_id,
        locked: snapshot.workspace_locked === true || status?.locked === true,
        organizations: status?.organizations ?? [],
      }
    }
    return {
      type: "personal",
      available: !status?.context || status.context.type === "personal",
      locked: snapshot.workspace_locked === true || status?.locked === true,
      organizations: status?.organizations ?? [],
    }
  }

  export async function getFundingContext(
    operation?: FundingSnapshot,
    options: { signal?: AbortSignal } = {},
  ): Promise<FundingContext> {
    const snapshot = operation ?? (await getFundingSnapshot())
    if (!snapshot) return { type: "personal", available: true, locked: false, organizations: [] }
    return fundingContext(snapshot, await readAuthStatus(snapshot, options.signal))
  }

  export interface FundingState {
    snapshot: FundingSnapshot
    context: FundingContext
    /** The profile the status read returned, so summaries do not read it twice. */
    user?: AccountProfile
    /** Whether the status read succeeded and matched this session. */
    verified: boolean
  }

  export async function getReconciledFundingState(
    options: { signal?: AbortSignal } = {},
  ): Promise<FundingState | null> {
    const read = async (snapshot: FundingSnapshot, retries: number): Promise<FundingState | null> => {
      const status = await readAuthStatus(snapshot, options.signal)
      if (isLegacyUnscoped(snapshot) && !status) return null
      const context = await fundingContext(snapshot, status)
      const current = await getFundingSnapshot()
      if (!current) return null
      if (
        current.api_key === snapshot.api_key &&
        current.user_id === snapshot.user_id &&
        current.organization_id === snapshot.organization_id &&
        current.workspace_locked === snapshot.workspace_locked
      ) {
        return {
          snapshot: current,
          context,
          verified: status !== null,
          ...(status?.user ? { user: status.user } : {}),
        }
      }
      if (!retries) return null
      return read(current, retries - 1)
    }
    const snapshot = await getFundingSnapshot()
    if (!snapshot) return null
    return read(snapshot, 2)
  }

  export async function setFundingContext(organizationID: string | null): Promise<FundingContext> {
    const session = await getSession()
    if (!session) throw new FundingContextError("Sign in before choosing a funding account.")
    if (organizationID !== null && !validOrganizationID(organizationID))
      throw new FundingContextError("Invalid organization id.")
    const requested = organizationID ?? undefined
    if (session.workspace_locked && requested !== session.organization_id) {
      throw new FundingContextError("This sign-in is tied to one workspace. Sign in again to choose another account.")
    }
    if (requested && !isWorkspaceKey(session.api_key)) {
      throw new FundingContextError("Sign in again to create a workspace-scoped organization credential.")
    }
    if (session.workspace_locked) return getFundingContext()
    const status = requested ? await readAuthStatus((await getFundingSnapshot()) as FundingSnapshot) : null
    if (requested && !organizationAvailable(status?.organizations.find((item) => item.organization_id === requested))) {
      throw new FundingContextError("That organization is not available to the connected account.")
    }
    await saveSession({ ...session, organization_id: requested })
    await syncCredentials({ force: true })
    return getFundingContext()
  }

  export interface DeviceInfo {
    key_id: string
    name: string
    key_prefix: string
    created_at: string
    last_used_at: string | null
    expires_at: string | null
  }

  function deviceInfo(body: unknown): DeviceInfo | null {
    if (!body || typeof body !== "object" || Array.isArray(body)) return null
    const row = body as Record<string, unknown>
    if (
      typeof row.key_id !== "string" ||
      typeof row.name !== "string" ||
      typeof row.key_prefix !== "string" ||
      typeof row.created_at !== "string" ||
      (row.last_used_at !== null && typeof row.last_used_at !== "string") ||
      (row.expires_at !== null && typeof row.expires_at !== "string")
    ) {
      return null
    }
    return {
      key_id: row.key_id,
      name: row.name,
      key_prefix: row.key_prefix,
      created_at: row.created_at,
      last_used_at: row.last_used_at,
      expires_at: row.expires_at,
    }
  }

  export async function listDevices(): Promise<DeviceInfo[] | null> {
    const session = await getSession()
    if (!session) return null
    try {
      const response = await authenticatedAtlasFetch(session, `${apiBase()}/api/cli/devices/current`)
      if (!response.ok) return null
      const device = deviceInfo(await response.json())
      return device ? [device] : null
    } catch {
      return null
    }
  }

  export async function revokeDevice(keyID: string): Promise<boolean> {
    const session = await getSession()
    if (!session) return false
    try {
      const response = await authenticatedAtlasFetch(session, `${apiBase()}/api/cli/devices/current`)
      if (!response.ok) return false
      const device = deviceInfo(await response.json())
      if (!device || device.key_id !== keyID) return false
      if (!(await revokeSessionDevice(session))) return false
      return clearSession(session.api_key)
    } catch {
      return false
    }
  }

  export async function revokeCurrentDevice(timeoutMs = DEVICE_REVOKE_TIMEOUT_MS): Promise<boolean> {
    const session = await getSession()
    if (!session) return false
    return revokeSessionDevice(session, timeoutMs)
  }

  export async function refreshByokSecrets(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const auth = await Auth.all().catch(() => ({}) as Record<string, Auth.Info>)
    for (const info of Object.values(auth)) {
      const values =
        info.type === "api" ? [info.key] : info.type === "oauth" ? [info.access, info.refresh] : [info.key, info.token]
      for (const value of values) if (value && !isAtlasManagedKey(value)) knownSecrets.add(value)
    }
    for (const key of BYOK_LLM_ENV_KEYS) {
      const value = env[key]
      if (value && !isAtlasManagedKey(value)) knownSecrets.add(value)
    }
  }

  export function registerSecretValues(values: Iterable<string>): void {
    for (const value of values) if (value && value.length >= 4) knownSecrets.add(value)
  }

  export function redactSecrets(text: string): string {
    let result = text
    for (const pattern of TOKEN_SECRET_PATTERNS) result = result.replace(pattern, "[REDACTED]")
    result = result.replace(PRIVATE_KEY_SECRET, "[REDACTED]")
    result = result.replace(JWT_SECRET, "[REDACTED]")
    result = result.replace(BEARER_SECRET, "$1[REDACTED]")
    result = result.replace(QUOTED_SECRET, "$1$2[REDACTED]$2")
    result = result.replace(BARE_SECRET, "$1[REDACTED]")
    for (const value of knownSecrets) if (value.length >= 4) result = result.replaceAll(value, "[REDACTED]")
    return result
  }

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

  export async function scrubSecrets<T>(value: T): Promise<T> {
    await refreshByokSecrets()
    return redactSensitive(value)
  }

  export function isManagedKeyValue(value: string | undefined): boolean {
    return typeof value === "string" && isAtlasManagedKey(value)
  }

  export function isSyncedSecretKey(): boolean {
    return false
  }

  export function isSyncedSecretValue(): boolean {
    return false
  }

  export function normalizeByokRouting(env: Record<string, string>): Record<string, string> {
    const result = { ...env }
    for (const [key, value] of Object.entries(result)) {
      if (key.endsWith("_BASE_URL") && managedProxyPath(value)) delete result[key]
    }
    if (result.OPENROUTER_API_KEY && !isAtlasManagedKey(result.OPENROUTER_API_KEY) && !result.OPENROUTER_BASE_URL) {
      result.OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"
    }
    return result
  }

  export function filterControlPlaneEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) {
      if (!value || CONTROL_PLANE_ENV_KEYS.has(key)) continue
      if (CONTROL_PLANE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) continue
      result[key] = value
    }
    return result
  }

  export function filterEnvForSubprocess(env: NodeJS.ProcessEnv): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(filterControlPlaneEnv(env))) {
      if (isAtlasManagedKey(value) || managedProxyPath(value)) continue
      const safe = SAFE_ENV_PREFIXES.some((prefix) => (prefix.endsWith("_") ? key.startsWith(prefix) : key === prefix))
      if (safe || SAFE_ENV_KEYS.has(key)) result[key] = value
    }
    return normalizeByokRouting(result)
  }

  export function filterEnvForKernel(env: NodeJS.ProcessEnv): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(filterControlPlaneEnv(env))) {
      const runtime =
        SAFE_ENV_PREFIXES.some((prefix) => (prefix.endsWith("_") ? key.startsWith(prefix) : key === prefix)) ||
        KERNEL_RUNTIME_KEYS.has(key)
      if (runtime) result[key] = value
    }
    return result
  }

  /** Runtime-only environment for kernels, language servers, formatters, and
   * git helpers. filterEnvForKernel admits no provider or service credential
   * key, so a kernelEnv child never inherits the synchronized workspace
   * overlay and is registered in the credential process ledger without an
   * overlay stamp. Callers that need the overlay use withSubprocessEnv, which
   * reports it. */
  export function kernelEnv(env: NodeJS.ProcessEnv = process.env, overlay: NodeJS.ProcessEnv = {}) {
    return filterControlPlaneEnv({
      ...filterEnvForKernel(env),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_TERMINAL_PROMPT: "0",
      ...overlay,
    })
  }

  export function kernelSensitivePaths() {
    const home = os.homedir()
    return [
      path.join(Global.Path.data, "openscience-session.json"),
      path.join(Global.Path.data, "openscience-workspace-scope.json"),
      SNAPSHOT_PATH,
      path.join(Global.Path.data, "auth.json"),
      path.join(Global.Path.data, "credentials.json"),
      path.join(Global.Path.data, "credentials.key"),
      WorkspaceCredentials.filepath,
      path.join(Global.Path.data, "gcp-service-account.json"),
      CredentialLifecycle.revisionPath(),
      path.join(Global.Path.data, "mcp-auth.json"),
      path.join(Global.Path.data, "file-trash"),
      ToolOutputPath.root,
      path.join(home, ".ssh"),
      path.join(home, ".aws"),
      path.join(home, ".azure"),
      path.join(home, ".kaggle"),
      path.join(home, ".docker"),
      path.join(home, ".config", "gcloud"),
      path.join(home, ".config", "gh"),
      path.join(home, ".config", "huggingface"),
      process.env.ATLAS_CLI_CONFIG_PATH || path.join(home, ".config", "atlas-cli", "config.json"),
      path.join(home, ".config", "pip", "pip.conf"),
      path.join(home, ".config", "rclone", "rclone.conf"),
      path.join(home, ".netrc"),
      path.join(home, ".git-credentials"),
      path.join(home, ".npmrc"),
      path.join(home, ".pypirc"),
    ]
  }

  export function mergeByokEnv(base: Record<string, string>, auth: Record<string, Auth.Info>): Record<string, string> {
    const result = { ...base }
    for (const [providerID, info] of Object.entries(auth)) {
      if (info.type !== "api" || isAtlasManagedKey(info.key)) continue
      const spec = BYOK_SUBPROCESS_PROVIDERS[providerID]
      if (!spec || spec.keys.some((key) => result[key])) continue
      for (const key of spec.keys) result[key] = info.key
      if (spec.baseUrl && spec.publicBaseUrl && !result[spec.baseUrl]) result[spec.baseUrl] = spec.publicBaseUrl
    }
    return normalizeByokRouting(result)
  }

  export interface SubprocessSnapshot {
    env: Record<string, string>
    /** Workspace whose synchronized credential overlay contributed at least
     * one value to `env`: a synced provider key merged from Auth, or a synced
     * service value that applyCredentialEnv injected into process.env. A
     * child spawned with this env inherits that overlay and must be stamped
     * with it in the credential process ledger. */
    overlay?: string
  }

  export async function subprocessSnapshot(env: NodeJS.ProcessEnv = process.env): Promise<SubprocessSnapshot> {
    await CredentialLifecycle.ensureFresh()
    const resolved = await Auth.resolve().catch((): Auth.Resolved => ({ auth: {} }))
    const merged = {
      ...mergeByokEnv(filterEnvForSubprocess(env), resolved.auth),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_TERMINAL_PROMPT: "0",
    }
    return { env: merged, overlay: inheritedOverlay(merged, resolved) }
  }

  /** Provenance, not value matching: a provider key counts only when Auth
   * resolved it from the workspace overlay and mergeByokEnv placed that exact
   * entry; a service value only when applyCredentialEnv recorded it as
   * account-sourced and it is still present verbatim. */
  function inheritedOverlay(env: Record<string, string>, resolved: Auth.Resolved): string | undefined {
    const service = CredentialOverlay.inherited(env)
    if (service) return service
    const synced = resolved.overlay
    if (!synced) return undefined
    const provider = [...synced.providers].some((id) => {
      const info = resolved.auth[id]
      const spec = BYOK_SUBPROCESS_PROVIDERS[id]
      return info?.type === "api" && !!spec && spec.keys.some((key) => env[key] === info.key)
    })
    return provider ? synced.organization : undefined
  }

  export async function subprocessEnv(env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> {
    return (await subprocessSnapshot(env)).env
  }

  /** Build the admitted subprocess environment and hand it to `action`
   * together with the overlay it carries. Every spawn site passes that
   * overlay explicitly to its ledger registration; nothing infers it from
   * process-wide state. */
  export function withSubprocessEnv<T>(
    env: NodeJS.ProcessEnv,
    action: (snapshot: Record<string, string>, overlay: string | undefined) => T | Promise<T>,
  ): Promise<T> {
    return CredentialLifecycle.admit(async () => {
      const snapshot = await subprocessSnapshot(env)
      return action(snapshot.env, snapshot.overlay)
    })
  }

  export function pythonThreadCapEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const cap = String(Math.max(1, Math.min(4, os.cpus().length)))
    const names = [
      "OMP_NUM_THREADS",
      "OPENBLAS_NUM_THREADS",
      "MKL_NUM_THREADS",
      "VECLIB_MAXIMUM_THREADS",
      "NUMEXPR_NUM_THREADS",
      "NUMBA_NUM_THREADS",
      "LOKY_MAX_CPU_COUNT",
    ]
    return Object.fromEntries(names.filter((name) => !env[name]).map((name) => [name, cap]))
  }

  let cachedBalance: { context: string; value: number; at: number } | null = null
  let pendingBalance: { context: string; promise: Promise<number | null> } | undefined
  let balanceRevision = 0
  const BALANCE_CACHE_TTL_MS = 30_000
  // A positive balance past the TTL is still served while a refresh runs in
  // the background, up to this age. A missing, non-positive or older value
  // blocks on the fetch so an empty wallet is noticed promptly.
  const BALANCE_STALE_MAX_MS = 5 * 60_000
  const BALANCE_FETCH_TIMEOUT_MS = 3_000

  /** Expire the cached balance after a spend or credential change. A positive
   * value is kept past its TTL so the next check serves it while a refresh runs
   * in the background (see getBalance); a non-positive value is dropped so the
   * next check blocks. The revision bump discards any in-flight result that
   * predates the spend. */
  export function invalidateBalance(): void {
    balanceRevision++
    pendingBalance = undefined
    // The stored account summary carries the same balance, so it is served
    // as stale (and refreshed in the background) from here on.
    accountStale = Date.now()
    if (!cachedBalance) return
    if (cachedBalance.value <= 0) {
      cachedBalance = null
      return
    }
    // Anchor to the original fetch so BALANCE_STALE_MAX_MS still bounds the
    // age of a served value when background refreshes keep failing.
    cachedBalance = { ...cachedBalance, at: Math.min(cachedBalance.at, Date.now() - BALANCE_CACHE_TTL_MS) }
  }

  export function invalidateBalanceCache(): void {
    invalidateBalance()
  }

  export async function getBalance(snapshot?: FundingSnapshot): Promise<number | null> {
    const session = snapshot ?? (await getReconciledFundingState())?.snapshot
    if (!session) return null
    const context = contextTag(session)
    const cached = cachedBalance?.context === context ? cachedBalance : null
    const age = cached ? Date.now() - cached.at : Infinity
    if (cached && age < BALANCE_CACHE_TTL_MS) return cached.value
    const stale = cached && cached.value > 0 && age < BALANCE_STALE_MAX_MS ? cached.value : undefined
    const request = pendingBalance?.context === context ? pendingBalance.promise : refreshBalance(session, context)
    if (stale !== undefined) return stale
    return request
  }

  function refreshBalance(session: FundingSnapshot, context: string) {
    const revision = balanceRevision
    const request = (async () => {
      try {
        const response = await fundedAtlasFetch(session, `${apiBase()}/api/cli/balance`, {}, BALANCE_FETCH_TIMEOUT_MS)
        if (!response.ok) return null
        const body = (await response.json()) as Record<string, unknown>
        const value =
          typeof body.effective_balance_usd === "number"
            ? body.effective_balance_usd
            : typeof body.effective_balance_cents === "number"
              ? body.effective_balance_cents / 100
              : typeof body.balance_usd === "number"
                ? body.balance_usd
                : typeof body.balance_cents === "number"
                  ? body.balance_cents / 100
                  : null
        if (revision !== balanceRevision) {
          return cachedBalance?.context === context ? cachedBalance.value : null
        }
        if (value !== null) cachedBalance = { context, value, at: Date.now() }
        return value
      } catch {
        return null
      }
    })()
    pendingBalance = { context, promise: request }
    void request.finally(() => {
      if (pendingBalance?.promise === request) pendingBalance = undefined
    })
    return request
  }

  export interface Credits {
    balanceUsd: number
    balanceRedacted?: boolean
    balanceCents: number
    cliBalanceCents: number
    spendableBalanceCents: number
    promotionalBalanceCents: number
    cycleCreditsRemainingCents: number
    lifetimeSpentCents: number | null
  }

  export function walletCents(value: {
    cli_balance_cents?: number
    unified_balance_cents?: number
    balance_cents?: number
  }): number {
    return value.balance_cents ?? value.cli_balance_cents ?? value.unified_balance_cents ?? 0
  }

  export async function getCredits(
    snapshot?: FundingSnapshot,
    options: { timeoutMs?: number; lifetimeSpent?: boolean; signal?: AbortSignal } = {},
  ): Promise<Credits | null> {
    const session = snapshot ?? (await getReconciledFundingState({ signal: options.signal }))?.snapshot
    if (!session) return null
    // The ledger metadata follow-up is part of the read's shape, so a summary
    // read and a full read are separate flights.
    return share(
      flightKey(`wallet:${options.lifetimeSpent === false ? "summary" : "full"}`, session),
      (flight) => fetchCredits(session, { ...options, signal: flight }),
      options.signal,
    )
  }

  async function fetchCredits(
    session: FundingSnapshot,
    options: { timeoutMs?: number; lifetimeSpent?: boolean; signal: AbortSignal },
  ): Promise<Credits | null> {
    const timeoutMs = options.timeoutMs ?? ATLAS_FETCH_TIMEOUT_MS
    const init = { signal: options.signal }
    try {
      let currentWallet = true
      let response = await fundedAtlasFetch(session, `${apiBase()}/api/v1/wallet`, init, timeoutMs)
      if (response.status === 404 || response.status === 405) {
        currentWallet = false
        response = await fundedAtlasFetch(session, `${apiBase()}/api/credits`, init, timeoutMs)
      }
      if (!response.ok) return null
      const body = (await response.json()) as {
        unified_balance_cents?: number
        balance_cents?: number
        cli_balance_cents?: number
        purchased_cents?: number
        purchased_credits_cents?: number
        promotional_cents?: number
        cycle_credits_remaining_cents?: number
        lifetime_spent_cents?: number
        redacted?: boolean
      }
      let lifetimeSpent = body.lifetime_spent_cents ?? null
      if (currentWallet && lifetimeSpent === null && options.lifetimeSpent !== false) {
        const metadata = await fundedAtlasFetch(session, `${apiBase()}/api/credits`, init, timeoutMs).catch(
          () => undefined,
        )
        if (metadata?.ok) {
          const legacy = (await metadata.json()) as { lifetime_spent_cents?: number }
          lifetimeSpent = legacy.lifetime_spent_cents ?? null
        }
      }
      const spendable = walletCents(body)
      const promotional = body.promotional_cents ?? body.cycle_credits_remaining_cents ?? 0
      const purchased = body.purchased_cents ?? body.purchased_credits_cents ?? spendable - promotional
      return {
        balanceUsd: purchased / 100,
        balanceRedacted: body.redacted === true,
        balanceCents: purchased,
        cliBalanceCents: purchased,
        spendableBalanceCents: spendable,
        promotionalBalanceCents: promotional,
        cycleCreditsRemainingCents: promotional,
        lifetimeSpentCents: lifetimeSpent,
      }
    } catch (error) {
      log.warn("wallet read failed", { error: error instanceof Error ? error.message : String(error) })
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

  export async function getTransactions(
    limit = 20,
    snapshot?: FundingSnapshot,
    signal?: AbortSignal,
  ): Promise<Transaction[] | null> {
    // A legacy unscoped session learns its workspace from the status read
    // (joining one already in flight) before any wallet endpoint sees it.
    const session =
      snapshot && !isLegacyUnscoped(snapshot) ? snapshot : (await getReconciledFundingState({ signal }))?.snapshot
    if (!session || (snapshot && session.api_key !== snapshot.api_key)) return null
    try {
      const response = await fundedAtlasFetch(session, `${apiBase()}/api/credits/transactions`, { signal })
      if (!response.ok) return null
      const body = (await response.json()) as
        Array<Record<string, unknown>> | { transactions?: Array<Record<string, unknown>> }
      const rows = Array.isArray(body) ? body : (body.transactions ?? [])
      return rows.slice(0, Math.max(0, limit)).map((row) => ({
        id: String(row.id ?? ""),
        amountCents: Number(row.amount_cents ?? 0),
        source: String(row.source ?? ""),
        description: String(row.description ?? ""),
        createdAt: String(row.created_at ?? ""),
      }))
    } catch {
      return null
    }
  }

  interface AccessRead {
    ok: boolean
    status?: number
    body?: {
      cli_balance_cents?: number
      managed_supported?: boolean
      managed_unlocked?: boolean
      ace_enabled?: boolean
      balance_redacted?: boolean
    }
  }

  /** The routing preference is local (config, stored keys, env), so it is
   * computed at read time and never taken from a stored account summary. */
  async function localBillingMode(
    config: Pick<typeof import("@/config/config").Config, "getGlobal">,
  ): Promise<BillingMode["mode"]> {
    const configured = (await config.getGlobal()).billing?.llm
    if (configured === "managed") return "managed"
    if (configured === "byok") return "byok"
    const openrouterAuth = await Auth.get("openrouter").catch(() => undefined)
    const storedOwnKey = openrouterAuth?.type === "api" && !isAtlasManagedKey(openrouterAuth.key)
    const envOpenRouterKey = process.env.OPENROUTER_API_KEY
    const envOwnKey = !!envOpenRouterKey && !isAtlasManagedKey(envOpenRouterKey)
    return storedOwnKey || envOwnKey ? "byok" : "managed"
  }

  /** The entitlement check, shared by every concurrent caller in one context. */
  function readAccess(session: FundingSnapshot, timeoutMs: number, signal?: AbortSignal): Promise<AccessRead> {
    return share(
      flightKey("access", session),
      async (flight) => {
        const response = await fundedAtlasFetch(
          session,
          `${apiBase()}/api/cli/access`,
          { signal: flight },
          timeoutMs,
        ).catch(() => undefined)
        if (!response) return { ok: false }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined)
          return { ok: false, status: response.status }
        }
        return { ok: true, status: response.status, body: (await response.json()) as AccessRead["body"] }
      },
      signal,
    )
  }

  export interface BillingMode {
    mode: "byok" | "managed"
    balance_cents: number
    balance_usd: number
    managed_supported: boolean
    managed_unlocked: boolean
    ace_enabled?: boolean
    balance_redacted?: boolean
    balance_verified?: boolean
    access_verified?: boolean
  }

  /** An explicit entitlement verdict: the gateway answered and refused. */
  function accessDenied(read: AccessRead): boolean {
    return read.status === 401 || read.status === 403
  }

  /** The billing mode one entitlement read and one wallet read describe. */
  async function billingFromReads(read: AccessRead, credits: Credits | null): Promise<BillingMode> {
    const { Config } = await import("@/config/config")
    const access = read.body
    const balance = credits?.balanceCents ?? access?.cli_balance_cents ?? 0
    const denied = accessDenied(read)
    const verified =
      denied ||
      (read.ok && typeof access?.managed_unlocked === "boolean" && typeof access.managed_supported === "boolean")
    const supported = !denied && access?.managed_supported === true
    return {
      mode: await localBillingMode(Config),
      balance_cents: balance,
      balance_usd: balance / 100,
      managed_supported: supported,
      managed_unlocked: verified && supported && access?.managed_unlocked === true,
      access_verified: verified,
      ace_enabled: access?.ace_enabled ?? false,
      balance_redacted: access?.balance_redacted ?? credits?.balanceRedacted ?? false,
      balance_verified: typeof access?.cli_balance_cents === "number" && access.balance_redacted !== true,
    }
  }

  export async function getBillingMode(
    snapshot?: FundingSnapshot,
    knownCredits?: Credits | null | Promise<Credits | null>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<BillingMode | null> {
    const session = snapshot ?? (await getReconciledFundingState({ signal: options.signal }))?.snapshot
    if (!session) return null
    const [accessRead, credits] = await Promise.all([
      readAccess(session, options.timeoutMs ?? ATLAS_FETCH_TIMEOUT_MS, options.signal),
      knownCredits === undefined
        ? getCredits(session, { signal: options.signal }).catch(() => null)
        : Promise.resolve(knownCredits),
    ])
    return billingFromReads(accessRead, credits)
  }

  export async function setBillingMode(
    mode: "byok" | "managed",
    localMode: "byok" | "managed" | null = mode,
  ): Promise<BillingMode | null> {
    const { Config } = await import("@/config/config")
    await Config.updateGlobal({ billing: { llm: localMode } }, { preserveInstances: true })
    const { Provider } = await import("@/provider/provider")
    Provider.invalidate()
    return null
  }

  export async function waitForBillingModeMirror(): Promise<void> {}

  // ---- Stored account summary ----------------------------------------------
  // The last good account summary is persisted (data dir, mode 0600) so the UI
  // can show it at once and refresh it in the background. It holds the
  // profile, funding context, wallet and entitlement the account service
  // returned; never the API key, which is bound by fingerprint only.

  export interface AccountSnapshot {
    /** When the summary was read from the account service (ms since epoch). */
    at: number
    user?: AccountProfile
    context: FundingContext
    credits: Credits | null
    billing: BillingMode | null
  }

  export interface AccountSummary extends AccountSnapshot {
    /** True while a newer summary is being read in the background. */
    refreshing: boolean
    /** Why the latest refresh failed, when the stored summary is served instead. */
    error?: string
  }

  /** Published when a refresh stored a newer summary, or dropped the stored one after a refusal. */
  export const AccountUpdatedEvent = BusEvent.define("account.updated", z.object({ refreshed_at: z.number() }))

  /** The one bound on account reads the UI waits for. It replaces the old
   * pair of a short UI timeout racing a long server timeout: the route's
   * request signal (aborted when the client leaves) and this budget are
   * combined once and propagated to every outbound fetch, so abandoned work
   * is cancelled and the UI's answer is the server's. */
  // Resolved per call, like the managed base, so the override applies as the
  // process environment stands rather than as it stood at import.
  export function accountDeadlineMs(): number {
    return Number(process.env.OPENSCIENCE_ACCOUNT_DEADLINE_MS) || 15_000
  }

  function accountDeadlineMessage(): string {
    return `The Ace account service did not answer within ${Math.round(accountDeadlineMs() / 1000)} seconds.`
  }

  /** The deadline's own reason says what happened, so a caller it cuts off,
   * the failure it records and the UI all report the same thing. */
  export function accountDeadline(signal?: AbortSignal): AbortSignal {
    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(new DOMException(accountDeadlineMessage(), "TimeoutError")),
      accountDeadlineMs(),
    )
    timer.unref()
    const deadline = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    if (deadline.aborted) clearTimeout(timer)
    else deadline.addEventListener("abort", () => clearTimeout(timer), { once: true })
    return deadline
  }

  const StoredOrganization = z.object({
    organization_id: z.string(),
    name: z.string(),
    slug: z.string(),
    is_personal: z.boolean(),
    status: z.string(),
    role: z.string(),
    membership_status: z.string(),
    funding_available: z.boolean(),
    effective_permissions: z.array(z.string()),
  })
  const StoredContext = z.object({
    type: z.enum(["personal", "organization"]),
    organization_id: z.string().optional(),
    available: z.boolean(),
    locked: z.boolean(),
    organizations: z.array(StoredOrganization),
  })
  const StoredCredits = z.object({
    balanceUsd: z.number(),
    balanceRedacted: z.boolean().optional(),
    balanceCents: z.number(),
    cliBalanceCents: z.number(),
    spendableBalanceCents: z.number(),
    promotionalBalanceCents: z.number(),
    cycleCreditsRemainingCents: z.number(),
    lifetimeSpentCents: z.number().nullable(),
  })
  const StoredBilling = z.object({
    mode: z.enum(["byok", "managed"]),
    balance_cents: z.number(),
    balance_usd: z.number(),
    managed_supported: z.boolean(),
    managed_unlocked: z.boolean(),
    ace_enabled: z.boolean().optional(),
    balance_redacted: z.boolean().optional(),
    balance_verified: z.boolean().optional(),
    access_verified: z.boolean().optional(),
  })
  // Only the profile fields the UI shows are stored. Whatever else the
  // account service returns with the profile is never written to disk.
  const StoredProfile = z.object({
    user_id: z.string().optional(),
    email: z.string().nullable().optional(),
    display_name: z.string().nullable().optional(),
    github_username: z.string().nullable().optional(),
  })
  const StoredSnapshot = z.object({
    protocol: z.literal(1),
    key_fingerprint: z.string(),
    user_id: z.string(),
    organization_id: z.string().optional(),
    workspace_locked: z.boolean().optional(),
    at: z.number(),
    user: StoredProfile.optional(),
    context: StoredContext,
    credits: StoredCredits.nullable(),
    billing: StoredBilling.nullable(),
  })

  // Summaries read before this instant are served as stale (a spend or a
  // credential change happened since).
  let accountStale = 0
  let accountFailure: { context: string; at: number; error: string } | undefined

  /** The profile a summary carries: the stored fields, picked from what the
   * account service returned, so memory and disk hold the same shape. */
  function storedProfile(user: AccountProfile): z.infer<typeof StoredProfile> {
    const text = (value: unknown) => (typeof value === "string" || value === null ? value : undefined)
    const picked = {
      user_id: typeof user.user_id === "string" ? user.user_id : undefined,
      email: text(user.email),
      display_name: text(user.display_name),
      github_username: text(user.github_username),
    }
    return Object.fromEntries(Object.entries(picked).filter(([, value]) => value !== undefined))
  }

  function sameSnapshot(a: FundingSnapshot, b: FundingSnapshot): boolean {
    return (
      a.api_key === b.api_key &&
      a.user_id === b.user_id &&
      a.organization_id === b.organization_id &&
      a.workspace_locked === b.workspace_locked
    )
  }

  /** The stored summary, only when it belongs to this exact account, funding
   * context and lock state (what flightKey and sameSnapshot bind on). */
  export async function readAccountSnapshot(session: FundingSnapshot): Promise<AccountSnapshot | null> {
    if (!existsSync(SNAPSHOT_PATH)) return null
    const parsed = StoredSnapshot.safeParse(
      await Bun.file(SNAPSHOT_PATH)
        .json()
        .catch(() => undefined),
    )
    if (!parsed.success) return null
    const stored = parsed.data
    if (stored.key_fingerprint !== keyFingerprint(session.api_key)) return null
    if (stored.user_id !== session.user_id || stored.organization_id !== session.organization_id) return null
    if ((stored.workspace_locked === true) !== (session.workspace_locked === true)) return null
    // A clock that moved backwards after the write leaves `at` in the future,
    // where it would pass every freshness check; such a summary is stale.
    const now = Date.now()
    return {
      at: stored.at > now ? now - ACCOUNT_SNAPSHOT_TTL_MS : stored.at,
      ...(stored.user ? { user: stored.user } : {}),
      context: stored.context,
      credits: stored.credits,
      billing: stored.billing,
    }
  }

  async function writeAccountSnapshot(session: FundingSnapshot, snapshot: AccountSnapshot): Promise<void> {
    await atomicWrite(
      SNAPSHOT_PATH,
      JSON.stringify({
        protocol: 1,
        key_fingerprint: keyFingerprint(session.api_key),
        user_id: session.user_id,
        ...(session.organization_id ? { organization_id: session.organization_id } : {}),
        ...(session.workspace_locked ? { workspace_locked: true } : {}),
        at: snapshot.at,
        ...(snapshot.user ? { user: storedProfile(snapshot.user) } : {}),
        context: snapshot.context,
        credits: snapshot.credits,
        billing: snapshot.billing,
      } satisfies z.input<typeof StoredSnapshot>),
    )
  }

  /** Read a fresh summary from the account service, store it and announce it.
   * Shared by every concurrent caller in one funding context. Throws when the
   * account status is unavailable or the selected account changed meanwhile,
   * so a stored summary is never overwritten by an incomplete read. */
  export function refreshAccount(
    session: FundingSnapshot,
    options: { signal?: AbortSignal } = {},
  ): Promise<AccountSnapshot> {
    return share(flightKey("account", session), (flight) => fetchAccount(session, flight), options.signal)
  }

  function refreshFailure(error: unknown): string {
    if (error instanceof DOMException && error.name === "TimeoutError") return accountDeadlineMessage()
    if (error instanceof DOMException && error.name === "AbortError") return "The account refresh was cancelled."
    return error instanceof Error ? error.message : "Account refresh failed. Try again."
  }

  /** Store `snapshot` for `expected`'s account, or with `null` drop whatever
   * is stored. The re-check and the write hold the session file's lock like
   * the session mutators do, so nothing lands after a sign-out or a new
   * sign-in removed the file. Returns whether the next summary read now
   * serves something different. */
  async function commitSummary(expected: FundingSnapshot, snapshot: AccountSnapshot | null): Promise<boolean> {
    using _ = await Lock.write(SESSION_PATH)
    const current = await getFundingSnapshot()
    if (!current || !sameSnapshot(current, expected)) {
      throw new Error("The selected account changed while refreshing. Retry.")
    }
    if (snapshot) {
      await writeAccountSnapshot(current, snapshot)
      return true
    }
    const stored = existsSync(SNAPSHOT_PATH)
    await fs.rm(SNAPSHOT_PATH, { force: true })
    return stored
  }

  async function fetchAccount(session: FundingSnapshot, signal: AbortSignal): Promise<AccountSnapshot> {
    const context = contextTag(session)
    const unavailable = () => new Error("The Ace account service is unavailable. Retry when connected.")
    try {
      // Reads only (status, entitlement, wallet): a refresh, in the
      // background or not, never calls anything that spends.
      const state = await getReconciledFundingState({ signal })
      if (!state) throw new Error("Sign in again to refresh the Ace account.")
      if (!state.verified) throw unavailable()
      const [credits, access] = await Promise.all([
        getCredits(state.snapshot, { signal }),
        readAccess(state.snapshot, ATLAS_FETCH_TIMEOUT_MS, signal),
      ])
      if (access.status === 401) {
        // The gateway rejected the key. accountAtlasFetch has begun clearing
        // the session; finish that here so a caller that waited finds
        // neither a session nor a stored summary.
        await clearSession(state.snapshot.api_key)
        throw new Error("This device was disconnected. Sign in again.")
      }
      const billing = await billingFromReads(access, credits)
      const denied = accessDenied(access)
      // A wallet or entitlement read that did not answer (a timeout, a 5xx)
      // is not a summary: the last good one stays stored and is served with
      // the failure.
      if (!denied && (credits === null || billing.access_verified !== true)) throw unavailable()
      const snapshot: AccountSnapshot = {
        at: Date.now(),
        ...(state.user ? { user: storedProfile(state.user) } : {}),
        context: state.context,
        credits,
        billing,
      }
      // A refusal is answered to whoever asked but never stored: the next
      // read asks the gateway again instead of trusting a refusal for a
      // summary's lifetime, and the last good summary is dropped so it
      // cannot outrank the refusal.
      const changed = await commitSummary(state.snapshot, denied ? null : snapshot)
      if (accountFailure?.context === context) accountFailure = undefined
      if (changed) {
        GlobalBus.emit("event", {
          directory: "global",
          payload: { type: AccountUpdatedEvent.type, properties: { refreshed_at: snapshot.at } },
        })
      }
      return snapshot
    } catch (error) {
      // The read is cancelled once its last caller left; that caller's own
      // cancellation is not an account failure, while the deadline is.
      const reason = signal.aborted ? signal.reason : error
      if (!(reason instanceof DOMException && reason.name === "AbortError")) {
        accountFailure = { context, at: Date.now(), error: refreshFailure(reason) }
      }
      throw error
    }
  }

  async function accountSummary(
    snapshot: AccountSnapshot,
    refreshing: boolean,
    error?: string,
  ): Promise<AccountSummary> {
    const { Config } = await import("@/config/config")
    const mode = await localBillingMode(Config)
    return {
      ...snapshot,
      billing: snapshot.billing ? { ...snapshot.billing, mode } : null,
      refreshing,
      ...(error ? { error } : {}),
    }
  }

  /** The account summary the UI shows. Null when signed out. A stored summary
   * is returned at once: as current while it is recent, otherwise marked
   * `refreshing` while a background read replaces it. Only the first read of
   * an account, with nothing stored yet, waits for the account service. */
  export async function getAccountSummary(options: { signal?: AbortSignal } = {}): Promise<AccountSummary | null> {
    const session = await getFundingSnapshot()
    if (!session) return null
    const cached = await readAccountSnapshot(session)
    const now = Date.now()
    // A recent summary is current. Strict: one stored in the same millisecond
    // as a spend is stale, which costs one background read instead of a wrong
    // verdict. A stale one younger than the refresh interval is served as it
    // is: the refresh that stored it just ran, and the next read after the
    // interval starts another. Nothing here asks the account service.
    const lifetime = cached && cached.at > accountStale ? ACCOUNT_SNAPSHOT_TTL_MS : ACCOUNT_REFRESH_MIN_MS
    if (cached && now - cached.at < lifetime) return accountSummary(cached, false)
    const failure = accountFailure?.context === contextTag(session) ? accountFailure : undefined
    if (cached && failure && failure.at > cached.at && now - failure.at < ACCOUNT_RETRY_MS) {
      return accountSummary(cached, false, failure.error)
    }
    // The only read that waits: the caller's own signal (a route's request,
    // aborted when the client leaves) bounds it together with the deadline.
    if (!cached)
      return accountSummary(await refreshAccount(session, { signal: accountDeadline(options.signal) }), false)
    // Nobody waits on the background read here, so it runs under the
    // deadline alone; the result is announced on the global bus and the next
    // summary read serves it.
    refreshAccount(session, { signal: accountDeadline() }).catch(() => undefined)
    return accountSummary(cached, true, failure?.error)
  }

  export async function reportUsage(
    _params: Record<string, unknown>,
    _snapshot?: FundingSnapshot,
  ): Promise<{ recorded: boolean; modelBlocked?: boolean } | null> {
    return null
  }

  export async function fetchLegacyInstalledSkills(): Promise<null> {
    return null
  }
}

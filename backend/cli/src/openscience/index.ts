import os from "node:os"
import path from "node:path"
import fs from "node:fs/promises"
import { existsSync } from "node:fs"
import { createHash, randomUUID } from "node:crypto"
import { Auth } from "@/auth"
import { CredentialLifecycle } from "@/credentials/lifecycle"
import { isAtlasManagedKey, isWorkspaceKey } from "@/credentials/managed-key"
import { Global } from "@/global"
import { DataRootBarrier } from "@/global/data-root-barrier"
import { ToolOutputPath } from "@/tool/tool-output-path"
import { Lock } from "@/util/lock"
import { Log } from "@/util/log"
import { BILLING_URL, DEFAULT_MANAGED_API_BASE, MANAGED_API_BASE } from "@/endpoints"
import { BYOK_LLM_ENV_KEYS, LOCAL_COMPUTE_CLI_ENV_KEYS, SYNCED_SERVICE_ENV_KEYS } from "./synced-env-policy"
import { WorkspaceCredentials } from "./workspace-credentials"

const log = Log.create({ service: "openscience" })
export const API_BASE = MANAGED_API_BASE

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

const SAFE_ENV_KEYS = new Set([...BYOK_LLM_ENV_KEYS, ...SYNCED_SERVICE_ENV_KEYS, "OPENSCIENCE_RUNTIME"])
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
const FUNDING_PROTOCOL = "1"
const FUNDING_PROTOCOL_HEADER = "OpenScience-Funding-Protocol"
const FUNDING_CONTEXT_HEADER = "OpenScience-Funding-Context"
const ATLAS_FETCH_TIMEOUT_MS = Number(process.env.OPENSCIENCE_ATLAS_TIMEOUT_MS) || 60_000
const VERIFICATION_PAGE = process.env.SYNSC_AUTH_URL?.replace(/\/+$/, "") || `${DEFAULT_MANAGED_API_BASE}/cli`

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

function isAccountKey(value: unknown): value is string {
  return typeof value === "string" && (value.startsWith("thk_") || value.startsWith("osk_"))
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
): Promise<Response> {
  return accountAtlasFetch(session, input, init, false)
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

export namespace OpenScience {
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
    })
    invalidateBalance()
    const { Provider } = await import("@/provider/provider")
    Provider.invalidate()
  }

  export async function clearSession(expectedApiKey?: string): Promise<boolean> {
    const action = async () => {
      using _ = await Lock.write(SESSION_PATH)
      if (expectedApiKey && (await getSession())?.api_key !== expectedApiKey) return false
      await fs.rm(SESSION_PATH, { force: true })
      await fs.rm(SCOPE_PATH, { force: true })
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
    return VERIFICATION_PAGE
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

  export async function managedRequestSnapshot(
    apiKey?: string,
    snapshot?: FundingSnapshot | null,
  ): Promise<FundingSnapshot> {
    if (!apiKey || !isAtlasManagedKey(apiKey)) throw new FundingContextError("Expected an Atlas managed API key.")
    const selected = snapshot ?? (await getFundingSnapshot())
    if (selected) {
      if (selected.api_key !== apiKey) {
        throw new FundingContextError("The connected account changed during managed inference. Retry it.")
      }
      return selected
    }
    if (existsSync(SESSION_PATH)) {
      throw new FundingContextError("OpenScience could not safely read the selected funding account. Sign in again.")
    }
    if (isWorkspaceKey(apiKey)) {
      throw new FundingContextError("A workspace credential requires a saved workspace scope. Sign in again.")
    }
    return Object.freeze({ api_key: apiKey, user_id: "", account: accountTag({ api_key: apiKey, user_id: "" }) })
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
    if (!snapshot.organization_id) {
      if ((!context || context === "personal") && protocol !== FUNDING_PROTOCOL) return response
      if (protocol === FUNDING_PROTOCOL && context === "personal") return response
      if (protocol === FUNDING_PROTOCOL && context?.startsWith("organization:") && !isWorkspaceKey(snapshot.api_key)) {
        return response
      }
    } else if (
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

  export function credentialSyncStatus(): SyncStatus {
    return synced
  }

  export async function syncCredentials(options: { force?: boolean; timeoutMs?: number } = {}): Promise<SyncStatus> {
    const session = await getSession()
    if (!session) return (synced = { state: "disconnected" })
    const identity = WorkspaceCredentials.identity(session)
    const pending = syncs.get(identity)
    if (pending) return pending
    if (!options.force && Date.now() - (attempts.get(identity) ?? 0) < 60_000) return synced
    attempts.set(identity, Date.now())
    const task = (async (): Promise<SyncStatus> => {
      synced = { state: "syncing" }
      const controller = new AbortController()
      let timer: ReturnType<typeof setTimeout> | undefined
      const request = (async () => {
        const response = await fetch(`${API_BASE}/api/cli/sync`, {
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
        const matches = async () => {
          const current = await getSession()
          return !!current && WorkspaceCredentials.identity(current) === identity
        }
        const previous = await WorkspaceCredentials.read()
        // A successful unchanged refresh extends the grant without revoking
        // running children or rebuilding the provider catalog.
        if (JSON.stringify(previous) === JSON.stringify(data.snapshot)) {
          await CredentialLifecycle.serialized(async () => {
            if (await matches()) await WorkspaceCredentials.write(session, data.snapshot)
          })
          if (!(await matches())) return synced
          return (synced = { state: "ready", organization_id: data.snapshot.organization_id, synced_at: Date.now() })
        }
        const applied = await CredentialLifecycle.mutateIf("workspace-sync.update", matches, () =>
          WorkspaceCredentials.write(session, data.snapshot),
        )
        if (!applied.applied) return synced
        await reloadSyncedEnv()
        const { Provider } = await import("@/provider/provider")
        Provider.invalidate()
        if (!(await matches())) return synced
        return (synced = { state: "ready", organization_id: data.snapshot.organization_id, synced_at: Date.now() })
      } catch (error) {
        const current = await getSession()
        if (current && WorkspaceCredentials.identity(current) !== identity) return synced
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

  export async function scheduleRefresh(): Promise<void> {
    await syncCredentials()
  }

  export function startCredentialSync(): void {
    if (syncTimer) return
    void scheduleRefresh()
    syncTimer = setInterval(() => void scheduleRefresh(), 4 * 60_000)
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
      const start = await atlasFetch(`${API_BASE}/api/v1/auth/cli/browser/start`, {
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
      const redeem = await atlasFetch(`${API_BASE}/api/v1/auth/cli/browser/redeem`, {
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
      await saveSession(session)
      await syncCredentials({ force: true })
      return session
    } finally {
      if (timer) clearTimeout(timer)
      callback.stop()
    }
  }

  async function readAuthStatus(session: FundingSnapshot | OpenScienceSession): Promise<{
    organizations: FundingOrganization[]
    pinned?: string
    locked: boolean
    context?: AuthStatusResponse["funding_context"]
    user?: AccountProfile
  } | null> {
    try {
      const response = await fundedAtlasFetch(session, `${API_BASE}/api/v1/auth/status`, {
        headers: { Accept: "application/json" },
      })
      if (!response.ok) return null
      const body = (await response.json()) as AuthStatusResponse
      const selected = body.funding_context?.type === "organization" ? body.funding_context.organization_id : undefined
      const pinned = loginOrganizationID(body.api_key?.organization_id ?? selected)
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
    const probe = await atlasFetch(`${API_BASE}/api/cli/balance`, {
      headers: { Authorization: `Bearer ${key}`, [FUNDING_PROTOCOL_HEADER]: FUNDING_PROTOCOL },
    })
    if (probe.status === 401 || probe.status === 403)
      throw new Error("That key was rejected. Double-check it and try again.")
    if (!probe.ok) throw new Error(`Could not validate key: HTTP ${probe.status}`)

    const response = await atlasFetch(`${API_BASE}/api/v1/auth/status`, {
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
    await saveSession(session)
    await syncCredentials({ force: true })
    return session
  }

  export async function getProfile(snapshot?: FundingSnapshot): Promise<AccountProfile | null> {
    const session = snapshot ?? (await getFundingSnapshot())
    if (!session) return null
    return (await readAuthStatus(session))?.user ?? (session.user_id ? { user_id: session.user_id } : null)
  }

  export async function getFundingContext(operation?: FundingSnapshot): Promise<FundingContext> {
    const snapshot = operation ?? (await getFundingSnapshot())
    if (!snapshot) return { type: "personal", available: true, locked: false, organizations: [] }
    const status = await readAuthStatus(snapshot)
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

  export async function getReconciledFundingState(): Promise<{
    snapshot: FundingSnapshot
    context: FundingContext
  } | null> {
    const snapshot = await getFundingSnapshot()
    if (!snapshot) return null
    return { snapshot, context: await getFundingContext(snapshot) }
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

  export async function listDevices(): Promise<DeviceInfo[] | null> {
    const session = await getSession()
    if (!session) return null
    try {
      const response = await authenticatedAtlasFetch(session, `${API_BASE}/api/cli/devices`)
      return response.ok ? ((await response.json()) as DeviceInfo[]) : null
    } catch {
      return null
    }
  }

  export async function revokeDevice(keyID: string): Promise<boolean> {
    const session = await getSession()
    if (!session) return false
    try {
      const response = await authenticatedAtlasFetch(
        session,
        `${API_BASE}/api/cli/devices/${encodeURIComponent(keyID)}`,
        { method: "DELETE" },
      )
      return response.ok || response.status === 204
    } catch {
      return false
    }
  }

  export async function revokeCurrentDevice(): Promise<boolean> {
    const session = await getSession()
    if (!session) return false
    const devices = await listDevices()
    const matches =
      devices?.filter((device) => device.key_prefix.length > 4 && session.api_key.startsWith(device.key_prefix)) ?? []
    return matches.length === 1 ? revokeDevice(matches[0].key_id) : false
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
      if (spec.baseUrl && spec.publicBaseUrl) result[spec.baseUrl] = spec.publicBaseUrl
    }
    return normalizeByokRouting(result)
  }

  export async function subprocessEnv(env: NodeJS.ProcessEnv = process.env): Promise<Record<string, string>> {
    await CredentialLifecycle.ensureFresh()
    const auth = await Auth.all().catch(() => ({}) as Record<string, Auth.Info>)
    return {
      ...mergeByokEnv(filterEnvForSubprocess(env), auth),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_TERMINAL_PROMPT: "0",
    }
  }

  export function withSubprocessEnv<T>(
    env: NodeJS.ProcessEnv,
    action: (snapshot: Record<string, string>) => T | Promise<T>,
  ): Promise<T> {
    return CredentialLifecycle.admit(async () => action(await subprocessEnv(env)))
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

  export function invalidateBalance(): void {
    balanceRevision++
    cachedBalance = null
    pendingBalance = undefined
  }

  export function invalidateBalanceCache(): void {
    invalidateBalance()
  }

  export async function getBalance(snapshot?: FundingSnapshot): Promise<number | null> {
    const session = snapshot ?? (await getFundingSnapshot())
    if (!session) return null
    const context = contextTag(session)
    if (cachedBalance?.context === context && Date.now() - cachedBalance.at < BALANCE_CACHE_TTL_MS) {
      return cachedBalance.value
    }
    if (pendingBalance?.context === context) return pendingBalance.promise
    const revision = balanceRevision
    const request = (async () => {
      try {
        const response = await fundedAtlasFetch(session, `${API_BASE}/api/cli/balance`)
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
    options: { timeoutMs?: number; lifetimeSpent?: boolean } = {},
  ): Promise<Credits | null> {
    const session = snapshot ?? (await getFundingSnapshot())
    if (!session) return null
    const timeoutMs = options.timeoutMs ?? ATLAS_FETCH_TIMEOUT_MS
    try {
      let currentWallet = true
      let response = await fundedAtlasFetch(session, `${API_BASE}/api/v1/wallet`, {}, timeoutMs)
      if (response.status === 404 || response.status === 405) {
        currentWallet = false
        response = await fundedAtlasFetch(session, `${API_BASE}/api/credits`, {}, timeoutMs)
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
        const metadata = await fundedAtlasFetch(session, `${API_BASE}/api/credits`, {}, timeoutMs).catch(
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

  export async function getTransactions(limit = 20, snapshot?: FundingSnapshot): Promise<Transaction[] | null> {
    const session = snapshot ?? (await getFundingSnapshot())
    if (!session) return null
    try {
      const response = await fundedAtlasFetch(session, `${API_BASE}/api/credits/transactions`)
      if (!response.ok) return null
      const body = (await response.json()) as
        | Array<Record<string, unknown>>
        | { transactions?: Array<Record<string, unknown>> }
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

  export async function getBillingMode(
    snapshot?: FundingSnapshot,
    knownCredits?: Credits | null | Promise<Credits | null>,
    timeoutMs = ATLAS_FETCH_TIMEOUT_MS,
  ): Promise<BillingMode | null> {
    const session = snapshot ?? (await getFundingSnapshot())
    if (!session) return null
    const [configModule, accessResponse, credits] = await Promise.all([
      import("@/config/config"),
      fundedAtlasFetch(session, `${API_BASE}/api/cli/access`, {}, timeoutMs).catch(() => undefined),
      knownCredits === undefined ? getCredits(session).catch(() => null) : Promise.resolve(knownCredits),
    ])
    const access = accessResponse?.ok
      ? ((await accessResponse.json()) as {
          cli_balance_cents?: number
          managed_supported?: boolean
          managed_unlocked?: boolean
          ace_enabled?: boolean
          balance_redacted?: boolean
        })
      : undefined
    const configured = (await configModule.Config.getGlobal()).billing?.llm
    const openrouterAuth = await Auth.get("openrouter").catch(() => undefined)
    const storedOwnKey = openrouterAuth?.type === "api" && !isAtlasManagedKey(openrouterAuth.key)
    const envOpenRouterKey = process.env.OPENROUTER_API_KEY
    const envOwnKey = !!envOpenRouterKey && !isAtlasManagedKey(envOpenRouterKey)
    const balance = credits?.balanceCents ?? access?.cli_balance_cents ?? 0
    const denied = accessResponse?.status === 401 || accessResponse?.status === 403
    const verified = denied || (
      accessResponse?.ok === true &&
      typeof access?.managed_unlocked === "boolean" &&
      typeof access.managed_supported === "boolean"
    )
    const supported = !denied && access?.managed_supported === true
    return {
      mode:
        configured === "managed" ? "managed" : configured === "byok" || storedOwnKey || envOwnKey ? "byok" : "managed",
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

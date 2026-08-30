import os from "node:os"
import path from "node:path"
import { Auth } from "@/auth"
import { CredentialLifecycle } from "@/credentials/lifecycle"
import { isAtlasManagedKey } from "@/credentials/managed-key"
import { Global } from "@/global"
import { ToolOutputPath } from "@/tool/tool-output-path"
import { BYOK_LLM_ENV_KEYS, LOCAL_COMPUTE_CLI_ENV_KEYS, SYNCED_SERVICE_ENV_KEYS } from "./synced-env-policy"

/**
 * Local runtime boundary.
 *
 * OpenScience has no product account, hosted inference, wallet, usage
 * reporting, credential sync, or telemetry transport. This module keeps the
 * local security helpers that sanitize child processes and redact secrets. A
 * few explicitly disabled methods remain as narrow compatibility seams for
 * older provider code; none performs network or account work.
 */

export interface OpenScienceSession {
  api_key: string
  user_id: string
  device_name?: string
  organization_id?: string
  workspace_locked?: boolean
}

export interface FundingSnapshot {
  readonly api_key: string
  readonly user_id: string
  readonly account: string
  readonly organization_id?: string
  readonly workspace_locked?: boolean
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

export namespace OpenScience {
  export async function getSession(): Promise<OpenScienceSession | null> {
    return null
  }

  export async function getFundingSnapshot(): Promise<FundingSnapshot | null> {
    return null
  }

  export async function managedRequestSnapshot(
    _apiKey?: string,
    _snapshot?: FundingSnapshot | null,
  ): Promise<FundingSnapshot> {
    throw new FundingContextError("Retired product routes are not supported. Connect a provider account you control.")
  }

  export function fundingHeaders(_snapshot: FundingSnapshot): Record<string, string> {
    return {}
  }

  export async function validateFundingResponse(response: Response, _snapshot?: FundingSnapshot): Promise<Response> {
    return response
  }

  export function scheduleRefresh(): Promise<void> {
    return Promise.resolve()
  }

  export async function reloadSyncedEnv(): Promise<void> {}

  export function isSyncedEnv(_key?: string, _value?: string): boolean {
    return false
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

  export function invalidateBalance(): void {}

  export async function getBalance(_snapshot?: FundingSnapshot): Promise<number | null> {
    return null
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

import { Hono, type Context } from "hono"
import { stream } from "hono/streaming"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import crypto from "crypto"
import path from "path"
import os from "os"
import fs from "fs/promises"
import { Global } from "../../../global"
import { errors } from "../../error"
import { lazy } from "../../../util/lazy"
import { JobBroker } from "../../../compute/job-broker"
import { Instance } from "../../../project/instance"
import { InstanceBootstrap } from "../../../project/bootstrap"
import { HTTPException } from "hono/http-exception"
import { projectSelection } from "../../project-selection"
import { Project } from "../../../project/project"
import { JsonStore } from "../../../util/jsonstore"
import { SecretFile } from "../../../util/secret-file"
import { OpenScience } from "../../../openscience"
import { ModalAdapter } from "../../../compute/modal/adapter"
import { ModalVolume } from "../../../compute/modal/volume"
import { SessionFilesystem } from "../../../session/filesystem"
import { ManagedEnvironments } from "../../../science/kernel/environment-manager"
import { ComputeSecrets } from "../../../compute/secrets"
import { ComputeCapabilities } from "../../../compute/capabilities"
import { resolveCredentialFields } from "./credentials"
import { CredentialLifecycle } from "../../../credentials/lifecycle"
import { TrustedExecutable } from "../../../process/trusted-executable"

const Directory = z.object({
  directory: z.string().trim().min(1).optional(),
})

async function project<T>(context: Context, fn: () => T): Promise<T> {
  const selected = await projectSelection(context)
  const directory = selected.directory
  if (!directory) {
    throw new HTTPException(400, { message: "Compute project directory does not exist." })
  }
  const canonical = await fs.realpath(directory).catch(() => undefined)
  const info = canonical ? await fs.stat(canonical).catch(() => undefined) : undefined
  if (!canonical || !info?.isDirectory()) {
    throw new HTTPException(400, { message: "Compute project directory does not exist." })
  }
  return Instance.provide({
    directory: canonical,
    init: InstanceBootstrap,
    async fn() {
      if (selected.project && Instance.project.id !== selected.project.id) {
        throw new Project.MismatchError({
          projectID: selected.project.id,
          directory: Instance.directory,
        })
      }
      return fn()
    },
  })
}

function modalDownloadDisposition(remote: string) {
  const basename =
    path.posix
      .basename(remote)
      .replace(/[\u0000-\u001f\u007f]/g, "_")
      .trim() || "download"
  const fallback = [...basename]
    .map((character) => {
      const code = character.charCodeAt(0)
      return code >= 0x20 && code <= 0x7e && character !== '"' && character !== "\\" ? character : "_"
    })
    .join("")
  const extended = [...Buffer.from(basename, "utf8")]
    .map((byte) => {
      const character = String.fromCharCode(byte)
      return /[A-Za-z0-9!#$&+.^_`|~-]/.test(character)
        ? character
        : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
    })
    .join("")
  return `attachment; filename="${fallback || "download"}"; filename*=UTF-8''${extended}`
}

// ── Compute settings store ──────────────────────────────────────────────────
//
// Durable backing store for the Compute settings panel — "where do runs
// execute". Persists to a real JSON file under ~/.openscience/ (Global.Path.data,
// mode 0600):
//
//   • BYOK GPU providers (Modal, TensorPool, Lambda Labs, Prime Intellect,
//     Vast.ai, RunPod). The provider API key is encrypted AT REST with a
//     machine-local AES-256-GCM key (mirroring the credentials route) and is
//     NEVER returned to the client — only presence + metadata are surfaced.
//   • SSH host profiles with pinned host-key identity and governed dispatch.
//
// Modal credentials are inert and resolve only inside its trusted adapter.
// Generic provider records resolve only through the host-only
// withProviderEnv() admission seam. Bash, Task, kernels, plugins, and local MCP
// do not receive them. The reviewed provider_compute broker is the sole agent
// boundary for the exact read-only calls declared in compute/provider-cli.ts.

export namespace ComputeSettings {
  const storePath = path.join(Global.Path.data, "settings-compute.json")
  const keyPath = path.join(Global.Path.data, "compute.key")

  // ── Encryption (AES-256-GCM, machine-local key) ──
  async function machineKey(): Promise<Buffer> {
    return SecretFile.key(keyPath)
  }

  async function encrypt(plain: string): Promise<string> {
    const key = await machineKey()
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
    const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([iv, tag, enc]).toString("base64")
  }

  // Inverse of encrypt(): iv(12) | tag(16) | ciphertext. Throws on a bad
  // key/tag, which callers treat as "unreadable key, skip it".
  async function decrypt(payload: string): Promise<string> {
    const key = await machineKey()
    const buf = Buffer.from(payload, "base64")
    const iv = buf.subarray(0, 12)
    const tag = buf.subarray(12, 28)
    const enc = buf.subarray(28)
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8")
  }

  // ── GPU provider catalog ──
  // Integration depth is a product contract, not a marketing badge. Modal has
  // a first-party governed adapter. The remaining entries are encrypted
  // credential records for provider-specific native CLI callers; they never
  // become generic shell environment variables, and saving a key does not
  // prove the provider is reachable.
  export interface ProviderSpec {
    id: string
    name: string
    integration: "integrated" | "cli_credential"
    placeholder: string
    hint: string
    credential: {
      label: string
      environment: string
      aliases: string[]
      docs_url: string
    }
  }

  const CATALOG: ProviderSpec[] = [
    {
      id: "modal",
      name: "Modal",
      integration: "integrated",
      placeholder: "ak-… : as-…",
      hint: "First-party governed jobs, artifacts, cancellation, and connection checks.",
      credential: {
        label: "Token ID and token secret",
        environment: "MODAL_TOKEN_ID + MODAL_TOKEN_SECRET",
        aliases: [],
        docs_url: "https://modal.com/docs/sdk/js/latest",
      },
    },
    {
      id: "tensorpool",
      name: "TensorPool",
      integration: "cli_credential",
      placeholder: "tp-…",
      hint: "Available to agents only after Test connection approves an administrator-managed TensorPool CLI; user-owned CLI installs and generic shells never receive it.",
      credential: {
        label: "API key",
        environment: "TENSORPOOL_KEY",
        aliases: ["TENSORPOOL_API_KEY"],
        docs_url: "https://docs.tensorpool.dev/",
      },
    },
    {
      id: "lambda",
      name: "Lambda",
      integration: "cli_credential",
      placeholder: "secret_…",
      hint: "Available to agents through reviewed read-only Lambda API operations after Test connection approves the system curl executable; generic shells never receive it.",
      credential: {
        label: "Cloud API key",
        environment: "LAMBDA_API_KEY",
        aliases: ["LAMBDA_LABS_API_KEY"],
        docs_url: "https://docs.lambda.ai/public-cloud/cloud-api/",
      },
    },
    {
      id: "prime_intellect",
      name: "Prime Intellect",
      integration: "cli_credential",
      placeholder: "pi-…",
      hint: "Available to agents only after Test connection approves an administrator-managed Prime CLI; user-owned CLI installs and generic shells never receive it.",
      credential: {
        label: "API key",
        environment: "PRIME_API_KEY",
        aliases: ["PRIME_INTELLECT_API_KEY"],
        docs_url: "https://docs.primeintellect.ai/cli-reference/introduction",
      },
    },
    {
      id: "vast",
      name: "Vast.ai",
      integration: "cli_credential",
      placeholder: "vast api key",
      hint: "Available to agents only after Test connection approves an administrator-managed Vast.ai CLI; user-owned CLI installs and generic shells never receive it.",
      credential: {
        label: "API key",
        environment: "VAST_API_KEY",
        aliases: [],
        docs_url: "https://docs.vast.ai/cli/authentication",
      },
    },
    {
      id: "runpod",
      name: "RunPod",
      integration: "cli_credential",
      placeholder: "rpa_…",
      hint: "Available to agents only after Test connection approves an administrator-managed RunPod CLI; user-owned CLI installs and generic shells never receive it.",
      credential: {
        label: "API key",
        environment: "RUNPOD_API_KEY",
        aliases: [],
        docs_url: "https://docs.runpod.io/runpodctl/overview",
      },
    },
  ]

  // ── Schemas ──
  export const SshHost = JobBroker.Host
  export type SshHost = z.infer<typeof SshHost>
  export const SshHostPatch = z.object({ notes: z.string().trim().max(4_000) })
  export type SshHostPatch = z.infer<typeof SshHostPatch>
  export const SshConfigHost = z.object({
    alias: z.string().trim().min(1).max(253).regex(/^\S+$/),
    hostname: z.string().trim().min(1).max(253).regex(/^\S+$/).optional(),
    user: z.string().trim().min(1).max(120).regex(/^\S+$/).optional(),
    port: z.number().int().min(1).max(65_535).optional(),
    identity_file: z.string().optional(),
    proxy_jump: z.string().optional(),
  })
  export type SshConfigHost = z.infer<typeof SshConfigHost>

  export const Provider = z.object({
    id: z.string(),
    name: z.string(),
    integration: z.enum(["integrated", "cli_credential"]),
    placeholder: z.string(),
    hint: z.string(),
    credential: z.object({
      label: z.string(),
      environment: z.string(),
      aliases: z.string().array(),
      docs_url: z.string().url(),
    }),
    connected: z.boolean(),
    enabled: z.boolean(),
    source: z.enum(["stored", "account", "modal_toml"]).nullable(),
    connected_at: z.string().nullable(),
    last_used: z.string().nullable(),
  })
  export type Provider = z.infer<typeof Provider>

  export const ProviderDoctor = z.object({
    ok: z.boolean(),
    provider: z.string(),
    cli: z.string(),
    command: z.string(),
    checked_at: z.string(),
    error: z.string().optional(),
  })
  export type ProviderDoctor = z.infer<typeof ProviderDoctor>

  export const Modal = z.object({
    app: z.string().trim().min(1).default("openscience"),
    image: z.string().trim().min(1).default("python:3.12-slim"),
    network: z.enum(["unrestricted", "none"]).default("none"),
    timeout_minutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60)
      .default(60),
    concurrency: z.number().int().min(1).max(100).default(10),
  })
  export type Modal = z.infer<typeof Modal>

  export const ModalPatch = z.object({
    app: Modal.shape.app.optional(),
    image: Modal.shape.image.optional(),
    network: Modal.shape.network.optional(),
    timeout_minutes: Modal.shape.timeout_minutes.optional(),
    concurrency: Modal.shape.concurrency.optional(),
  })
  export type ModalPatch = z.infer<typeof ModalPatch>

  export const ModalFile = z.object({
    found: z.boolean(),
    ready: z.boolean(),
    status: z.enum(["absent", "invalid", "ready"]),
    profile: z.string().optional(),
    environment: z.string().optional(),
    error: z.string().optional(),
  })
  export type ModalFile = z.infer<typeof ModalFile>
  type ModalProfileFile = ModalFile & { token?: string; secret?: string }

  export const Info = z.object({
    providers: Provider.array().default([]),
    ssh_hosts: SshHost.array().default([]),
    ssh_config_hosts: SshConfigHost.array().default([]),
    modal: Modal.default(() => Modal.parse({})),
    modal_file: ModalFile,
    environments: z.object({
      status: z.enum(["absent", "installing", "ready", "failed"]),
      phase: z.string(),
      error: z.string().optional(),
      environments: z
        .object({
          language: z.enum(["python", "r"]),
          ready: z.boolean(),
          path: z.string(),
          packages: z.string().array(),
        })
        .array(),
    }),
  })
  export type Info = z.infer<typeof Info>

  // ── On-disk shape (secrets live here only) ──
  const ExecutableAttestation = z.object({
    version: z.literal(1),
    name: z.string().min(1),
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.string().regex(/^\d+$/),
    device: z.string().regex(/^\d+$/),
    inode: z.string().regex(/^\d+$/),
    mode: z.string().regex(/^\d+$/),
  })
  const ExecutableApproval = z.object({
    source: z.literal("settings"),
    approved_at: z.string(),
  })
  const ProviderRemoval = z.object({
    token: z.string().uuid(),
    remote: z.boolean(),
    requested_at: z.string(),
  })
  const StoredProvider = z.object({
    key: z.string().optional(),
    source: z.enum(["stored", "account", "modal_toml"]).default("stored"),
    path: z.string().optional(),
    enabled: z.boolean().default(false),
    connected_at: z.string(),
    last_used: z.string().nullable().default(null),
    executable: ExecutableAttestation.optional(),
    executable_approval: ExecutableApproval.optional(),
    removal: ProviderRemoval.optional(),
  })
  const ModalStored = z.preprocess((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value
    const legacy = value as Record<string, unknown>
    const timeout = (() => {
      const minutes = legacy.timeout_minutes
      if (typeof minutes === "number" && Number.isFinite(minutes)) return minutes
      const hours = legacy.timeout_hours
      if (typeof hours === "number" && Number.isFinite(hours)) return hours * 60
      return undefined
    })()
    return {
      app: typeof legacy.app === "string" && legacy.app.trim() ? legacy.app : undefined,
      image: typeof legacy.image === "string" && legacy.image.trim() ? legacy.image : undefined,
      network: legacy.network === "unrestricted" || legacy.network === "allow" ? "unrestricted" : "none",
      timeout_minutes: timeout === undefined ? undefined : Math.max(1, Math.min(24 * 60, Math.round(timeout))),
      concurrency:
        typeof legacy.concurrency === "number" && Number.isFinite(legacy.concurrency)
          ? Math.max(1, Math.min(100, Math.round(legacy.concurrency)))
          : undefined,
    }
  }, Modal)
  const Stored = z.object({
    providers: z.record(z.string(), StoredProvider).default({}),
    ssh_hosts: SshHost.array().default([]),
    modal: ModalStored.default(() => Modal.parse({})),
  })
  type Stored = z.infer<typeof Stored>

  const EMPTY: Stored = { providers: {}, ssh_hosts: [], modal: Modal.parse({}) }

  const ModalProfiles = z.record(
    z.string(),
    z
      .object({
        active: z.boolean().optional(),
        token_id: z.string().optional(),
        token_secret: z.string().optional(),
        environment: z.string().optional(),
      })
      .passthrough(),
  )

  function parseStored(value: unknown): Stored {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const providers = (value as { providers?: Record<string, unknown> }).providers
      if (providers?.prime && !providers.prime_intellect) {
        providers.prime_intellect = providers.prime
        delete providers.prime
      }
    }
    const result = Stored.safeParse(value)
    return result.success ? result.data : structuredClone(EMPTY)
  }

  async function read(): Promise<Stored> {
    return parseStored(await JsonStore.read(storePath))
  }

  async function update(fn: (stored: Stored) => void | Promise<void>): Promise<Stored> {
    const result: { value?: Stored } = {}
    await JsonStore.update(storePath, async (data) => {
      const stored = Stored.parse(data)
      await fn(stored)
      result.value = stored
      return stored
    })
    if (!result.value) throw new Error("Compute settings update completed without a store")
    return result.value
  }

  function id() {
    return crypto.randomUUID().slice(0, 8)
  }

  // ── Trusted control-plane credential resolution ──

  // Canonical env var names each provider's real consumers read (skill scripts,
  // session prompts, dashboard sync). Where two spellings exist in the wild
  // both are set. Modal is handled separately — its single pasted key
  // ("ak-… : as-…") splits into a token id + secret pair.
  const PROVIDER_ENV: Record<string, string[]> = {
    tensorpool: ["TENSORPOOL_KEY", "TENSORPOOL_API_KEY"],
    lambda: ["LAMBDA_API_KEY", "LAMBDA_LABS_API_KEY"],
    prime_intellect: ["PRIME_API_KEY", "PRIME_INTELLECT_API_KEY"],
    vast: ["VAST_API_KEY"],
    runpod: ["RUNPOD_API_KEY"],
  }
  const canonicalProvider = (target: string) => (target === "prime" ? "prime_intellect" : target)

  /** Map one provider's decrypted key to the canonical env var names its real
   *  consumers read. Modal's combined "token_id : token_secret" key is split;
   *  a half-pasted modal key maps to nothing (both vars are required). */
  function mapProviderEnv(target: string, key: string): Record<string, string> {
    target = canonicalProvider(target)
    if (target === "modal") {
      const [token, secret] = key.split(":").map((part) => part.trim())
      if (!token || !secret) return {}
      return { MODAL_TOKEN_ID: token, MODAL_TOKEN_SECRET: secret }
    }
    return Object.fromEntries((PROVIDER_ENV[target] ?? []).map((name) => [name, key]))
  }

  async function readModal(filepath = path.join(os.homedir(), ".modal.toml")): Promise<ModalProfileFile> {
    const info = await fs.stat(filepath).catch(() => undefined)
    if (!info?.isFile())
      return {
        found: false as const,
        ready: false as const,
        status: "absent" as const,
        error: "Modal config file was not found.",
      }
    const text = await Bun.file(filepath)
      .text()
      .catch(() => undefined)
    if (!text)
      return {
        found: true as const,
        ready: false as const,
        status: "invalid" as const,
        error: "Modal config file could not be read or is empty.",
      }
    const value = await Promise.resolve()
      .then(() => Bun.TOML.parse(text))
      .catch(() => undefined)
    const parsed = ModalProfiles.safeParse(value)
    if (!parsed.success)
      return {
        found: true as const,
        ready: false as const,
        status: "invalid" as const,
        error: "Modal config file is not valid TOML profile configuration.",
      }
    const entries = Object.entries(parsed.data)
    const active = entries.filter(([, item]) => item.active)
    if (active.length > 1)
      return {
        found: true as const,
        ready: false as const,
        status: "invalid" as const,
        error: "Modal config has more than one active profile.",
      }
    const selected = active[0] ?? (entries.length === 1 && entries[0]?.[0] === "default" ? entries[0] : undefined)
    if (!selected)
      return {
        found: true as const,
        ready: false as const,
        status: "invalid" as const,
        error: "Modal config does not identify one active profile.",
      }
    const [profile, settings] = selected
    const token = settings.token_id?.trim() || undefined
    const secret = settings.token_secret?.trim() || undefined
    if (!token || !secret)
      return {
        found: true as const,
        ready: false as const,
        status: "invalid" as const,
        profile,
        environment: settings.environment?.trim() || undefined,
        error: "Selected Modal profile is missing token_id or token_secret.",
      }
    return {
      found: true as const,
      ready: true as const,
      status: "ready" as const,
      profile,
      environment: settings.environment?.trim() || undefined,
      token,
      secret,
    }
  }

  export async function modalFile(filepath?: string): Promise<ModalFile> {
    const target = filepath ?? path.join(os.homedir(), ".modal.toml")
    const { token: _token, secret: _secret, ...file } = await readModal(target)
    return ModalFile.parse(file)
  }

  async function providerEnvUnlocked(target: string): Promise<{ env: Record<string, string>; revision: string }> {
    target = canonicalProvider(target)
    const entry = (await read()).providers[target]
    if (!entry?.enabled || entry.removal) throw new Error(`Compute provider ${target} is disabled`)
    const env = await (async () => {
      if (target === "modal" && entry.source === "modal_toml" && entry.path) {
        const file = await readModal(entry.path)
        if (!file.token || !file.secret) return {}
        return { MODAL_TOKEN_ID: file.token, MODAL_TOKEN_SECRET: file.secret }
      }
      if (!entry.key) return {}
      return mapProviderEnv(target, await decrypt(entry.key))
    })()
    if (!Object.keys(env).length) throw new Error(`Compute provider ${target} has invalid credentials`)
    OpenScience.registerSecretValues(Object.values(env))
    const revision = entry.key ?? (entry.source === "modal_toml" && entry.path ? `modal_toml:${entry.path}` : undefined)
    if (!revision) throw new Error(`Compute provider ${target} has no stored credential authority`)
    return { env, revision }
  }

  /** Credential-bearing admission seam for a reviewed provider CLI adapter.
   * The mutation lease stays held until `action` has spawned and durably
   * registered any child that can outlive it. Generic Bash, Task, kernel, and
   * local MCP paths never call this function and therefore never receive these
   * values. Modal keeps its deeper first-party adapter instead. */
  export async function withProviderEnv<T>(
    target: string,
    base: NodeJS.ProcessEnv,
    action: (env: Record<string, string>, credentialRevision: string) => T | Promise<T>,
  ): Promise<T> {
    target = canonicalProvider(target)
    const spec = CATALOG.find((item) => item.id === target)
    if (!spec || spec.integration !== "cli_credential") {
      throw new Error(`Compute provider ${target} does not use the reviewed CLI credential bridge`)
    }
    return CredentialLifecycle.admit(async () => {
      const credential = await providerEnvUnlocked(target)
      const clean = OpenScience.filterControlPlaneEnv(base)
      return action({ ...clean, ...credential.env }, credential.revision)
    })
  }

  /** Record a successful, read-only native provider invocation. The opaque
   * encrypted value closes the rotate-while-running race: a late response for
   * key A can never make replacement key B look verified. */
  export async function markProviderUsed(target: string, credentialRevision: string): Promise<void> {
    target = canonicalProvider(target)
    await CredentialLifecycle.serialized(() =>
      update((current) => {
        const entry = current.providers[target]
        if (!entry?.enabled || entry.removal || entry.key !== credentialRevision) {
          throw new Error(`Compute provider ${target} changed before its connection check completed`)
        }
        entry.last_used = new Date().toISOString()
      }),
    )
  }

  /** A failed explicit Settings check must not leave the provider advertised as
   * verified from an older successful binary or credential. */
  export async function markProviderCheckFailed(target: string): Promise<void> {
    target = canonicalProvider(target)
    await CredentialLifecycle.serialized(() =>
      update((current) => {
        const entry = current.providers[target]
        if (entry && !entry.removal) entry.last_used = null
      }),
    )
  }

  /** Persist an exact provider CLI identity only from the explicit Settings
   * connection check. Existing auto-pins from older builds have no approval
   * marker and remain inadmissible until the user runs that check. */
  export async function approveProviderExecutable(
    target: string,
    attestation: TrustedExecutable.Attestation,
  ): Promise<TrustedExecutable.Attestation> {
    target = canonicalProvider(target)
    let pinned: TrustedExecutable.Attestation | undefined
    await CredentialLifecycle.serialized(() =>
      update((current) => {
        const entry = current.providers[target]
        if (!entry?.enabled || entry.removal) throw new Error(`Compute provider ${target} is disabled`)
        if (!entry.executable || !entry.executable_approval) {
          entry.executable = ExecutableAttestation.parse(attestation)
          entry.executable_approval = { source: "settings", approved_at: new Date().toISOString() }
        }
        pinned = entry.executable
      }),
    )
    if (!pinned) throw new Error(`Compute provider ${target} executable attestation was not persisted`)
    return pinned
  }

  /** Resolve only an explicitly approved executable. Provider tool invocations
   * never create trust on first use. */
  export async function approvedProviderExecutable(target: string): Promise<TrustedExecutable.Attestation> {
    target = canonicalProvider(target)
    const current = await read()
    const entry = current.providers[target]
    if (!entry?.enabled || entry.removal) throw new Error(`Compute provider ${target} is disabled`)
    if (!entry.executable || !entry.executable_approval) {
      throw new Error(`Compute provider ${target} CLI is not approved; run Check connection in Settings > Compute`)
    }
    return entry.executable
  }

  function sshConfigTokens(value: string) {
    const tokens: string[] = []
    let token = ""
    let quote: "'" | '"' | undefined
    let escaped = false
    for (const char of value) {
      if (escaped) {
        token += char
        escaped = false
        continue
      }
      if (char === "\\") {
        escaped = true
        continue
      }
      if (quote) {
        if (char === quote) quote = undefined
        else token += char
        continue
      }
      if (char === "'" || char === '"') {
        quote = char
        continue
      }
      if (char === "#") break
      if (/\s/.test(char)) {
        if (token) tokens.push(token)
        token = ""
        continue
      }
      token += char
    }
    if (escaped) token += "\\"
    if (token) tokens.push(token)
    return tokens
  }

  const SSH_CONFIG_MAX_DEPTH = 4
  const SSH_CONFIG_MAX_FILES = 32
  const SSH_CONFIG_MAX_BYTES = 1024 * 1024

  function inside(root: string, candidate: string) {
    const relative = path.relative(root, candidate)
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  }

  async function identityFile(value: string, base: string): Promise<string> {
    if (!value || /[%$\u0000\r\n]/.test(value)) throw new Error("SSH IdentityFile must be a literal local path")
    const expanded = value.startsWith("~/") ? path.join(os.homedir(), value.slice(2)) : value
    const candidate = path.isAbsolute(expanded) ? expanded : path.resolve(base, expanded)
    const canonical = await fs.realpath(candidate).catch(() => undefined)
    const info = canonical ? await fs.stat(canonical).catch(() => undefined) : undefined
    if (!canonical || !info?.isFile()) throw new Error(`SSH identity file does not exist: ${value}`)
    if (/[%$\u0000\r\n]/.test(canonical)) throw new Error("SSH IdentityFile must resolve to a literal local path")
    if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
      throw new Error(`SSH identity file permissions are too broad: ${value}`)
    }
    return canonical
  }

  function expandedProxyJump(value: string | undefined, hosts: Map<string, SshConfigHost>) {
    if (!value) return undefined
    return value
      .split(",")
      .map((hop) => {
        if (hop.includes("@") || hop.includes(":") || hop.startsWith("[")) return hop
        const saved = hosts.get(hop)
        if (!saved) return hop
        const destination = saved.user
          ? `${saved.user}@${saved.hostname ?? saved.alias}`
          : (saved.hostname ?? saved.alias)
        return saved.port ? `${destination}:${saved.port}` : destination
      })
      .join(",")
  }

  /** Parse a bounded, data-only subset of OpenSSH config. Includes are read
   * recursively only beneath the initial config directory, with hard depth,
   * file, and byte caps. Match and ProxyCommand are never evaluated; a Host
   * stanza that depends on ProxyCommand is omitted instead of being imported
   * with misleading connectivity. */
  export async function sshConfigHosts(filepath = path.join(os.homedir(), ".ssh", "config")): Promise<SshConfigHost[]> {
    const initial = await fs.realpath(filepath).catch(() => undefined)
    if (!initial) return []
    const root = path.dirname(initial)
    const found = new Map<string, SshConfigHost>()
    let aliases: string[] = []
    let values: Omit<SshConfigHost, "alias"> & { identityBase?: string; unsupportedProxy?: boolean } = {}
    let inMatch = false
    let files = 0
    let bytes = 0
    const active = new Set<string>()
    const flush = async () => {
      for (const alias of aliases) {
        if (found.has(alias) || values.unsupportedProxy) continue
        const identity = values.identity_file
          ? await identityFile(values.identity_file, values.identityBase ?? root).catch(() => undefined)
          : undefined
        const parsed = SshConfigHost.safeParse({
          alias,
          hostname: values.hostname,
          user: values.user,
          port: values.port,
          identity_file: identity,
          proxy_jump: values.proxy_jump,
        })
        if (parsed.success) found.set(alias, parsed.data)
      }
      aliases = []
      values = {}
    }

    const includes = async (pattern: string, base: string) => {
      if (!pattern || /[%$\u0000\r\n]/.test(pattern)) return []
      const expanded = pattern.startsWith("~/") ? path.join(os.homedir(), pattern.slice(2)) : pattern
      const absolute = path.isAbsolute(expanded) ? expanded : path.resolve(base, expanded)
      if (!inside(root, absolute)) return []
      const relative = path.relative(root, absolute).split(path.sep).join("/")
      const matches: string[] = []
      for await (const match of new Bun.Glob(relative).scan({
        cwd: root,
        absolute: true,
        onlyFiles: true,
        followSymlinks: false,
      })) {
        matches.push(match)
        if (matches.length > SSH_CONFIG_MAX_FILES) throw new Error("SSH config Include match limit exceeded")
      }
      const result: string[] = []
      for (const match of matches.toSorted()) {
        const canonical = await fs.realpath(match).catch(() => undefined)
        if (canonical && inside(root, canonical)) result.push(canonical)
      }
      return result
    }

    const parseFile = async (file: string, depth: number): Promise<void> => {
      if (depth > SSH_CONFIG_MAX_DEPTH) throw new Error("SSH config Include depth limit exceeded")
      if (active.has(file)) return
      if (++files > SSH_CONFIG_MAX_FILES) throw new Error("SSH config Include limit exceeded")
      active.add(file)
      try {
        const buffer = await fs.readFile(file)
        bytes += buffer.byteLength
        if (bytes > SSH_CONFIG_MAX_BYTES) throw new Error("SSH config byte limit exceeded")
        for (const line of buffer.toString("utf8").split(/\r?\n/)) {
          const match = line.trim().match(/^([^\s=]+)(?:\s+|\s*=\s*)(.*)$/)
          if (!match) continue
          const key = match[1]!.toLowerCase()
          const tokens = sshConfigTokens(match[2]!)
          if (key === "host") {
            await flush()
            inMatch = false
            aliases = tokens.filter((alias) => alias && !alias.startsWith("!") && !/[*?\[\]]/.test(alias))
            continue
          }
          if (key === "match") {
            await flush()
            inMatch = true
            continue
          }
          if (key === "include") {
            if (inMatch) continue
            if (tokens.length > 16) throw new Error("SSH config Include pattern limit exceeded")
            for (const token of tokens) {
              for (const included of await includes(token, path.dirname(file))) await parseFile(included, depth + 1)
            }
            continue
          }
          if (!aliases.length || !tokens[0] || inMatch) continue
          if (key === "hostname" && !tokens[0].includes("%")) values.hostname ??= tokens[0]
          if (key === "user" && !tokens[0].includes("%") && !tokens[0].includes("@")) values.user ??= tokens[0]
          if (key === "port") {
            const port = Number(tokens[0])
            if (Number.isInteger(port) && port >= 1 && port <= 65_535) values.port ??= port
          }
          if (key === "identityfile" && !values.identity_file) {
            values.identity_file = tokens[0]
            values.identityBase = path.dirname(file)
          }
          if (key === "proxyjump" && tokens[0]?.toLowerCase() !== "none") values.proxy_jump ??= tokens[0]
          if (key === "proxycommand" && tokens[0]?.toLowerCase() !== "none") values.unsupportedProxy = true
        }
      } finally {
        active.delete(file)
      }
    }

    try {
      await parseFile(initial, 0)
      await flush()
    } catch {
      return []
    }
    return [...found.values()]
      .map((item) => ({ ...item, proxy_jump: expandedProxyJump(item.proxy_jump, found) }))
      .map((item) => SshConfigHost.parse(item))
      .toSorted((a, b) => a.alias.localeCompare(b.alias))
  }

  // Build the client-facing view — never includes the encrypted key.
  async function view(stored: Stored, file = modalFile(), configHosts = sshConfigHosts()): Promise<Info> {
    const providers = CATALOG.map((spec) => {
      const entry = stored.providers[spec.id]
      const connected = !!entry && !entry.removal
      return {
        id: spec.id,
        name: spec.name,
        integration: spec.integration,
        placeholder: spec.placeholder,
        hint: spec.hint,
        credential: spec.credential,
        connected,
        enabled: connected ? (entry?.enabled ?? false) : false,
        source: connected ? (entry?.source ?? null) : null,
        connected_at: connected ? (entry?.connected_at ?? null) : null,
        last_used: connected ? (entry?.last_used ?? null) : null,
      }
    })
    return {
      providers,
      ssh_hosts: stored.ssh_hosts,
      ssh_config_hosts: await configHosts,
      modal: stored.modal,
      modal_file: await file,
      environments: await ManagedEnvironments.status(),
    }
  }

  export async function get(): Promise<Info> {
    return view(await read())
  }

  export function isProvider(target: string): boolean {
    return CATALOG.some((s) => s.id === canonicalProvider(target))
  }

  export async function connectProvider(target: string, key: string): Promise<Info> {
    target = canonicalProvider(target)
    const stored = await CredentialLifecycle.mutate(`compute-provider.set:${target}`, async () => {
      const before = (await read()).providers[target]
      if (before?.removal) {
        throw new Error(`Compute provider ${target} removal is pending; retry disconnect before reconnecting`)
      }
      const authenticated = await OpenScience.isAuthenticated()
      const accountFields =
        target === "modal"
          ? (() => {
              const [token_id, token_secret] = key.split(":").map((part) => part.trim())
              return token_id && token_secret ? { token_id, token_secret } : undefined
            })()
          : { api_key: key }
      if (
        authenticated &&
        (!accountFields || !(await OpenScience.savePortableCredential(target, accountFields, target)))
      ) {
        throw new Error(`Could not sync ${target} to your Synthetic Sciences account`)
      }
      return update(async (current) => {
        const existing = current.providers[target]
        if (existing?.removal) {
          throw new Error(`Compute provider ${target} removal is pending; retry disconnect before reconnecting`)
        }
        const sameCredential = existing?.key
          ? await decrypt(existing.key)
              .then((value) => value === key)
              .catch(() => false)
          : false
        current.providers[target] = {
          key: await encrypt(key),
          source: authenticated ? "account" : "stored",
          enabled: existing?.enabled ?? false,
          connected_at: existing?.connected_at ?? new Date().toISOString(),
          last_used: sameCredential ? (existing?.last_used ?? null) : null,
          executable: existing?.executable,
          executable_approval: existing?.executable_approval,
        }
      })
    })
    return view(stored)
  }

  export async function configureModal(filepath = path.join(os.homedir(), ".modal.toml")): Promise<Info> {
    const file = await modalFile(filepath)
    if (!file.ready)
      throw new HTTPException(400, {
        message: file.error ?? "Modal config does not contain one usable profile.",
      })
    const stored = await CredentialLifecycle.mutate("compute-provider.configure:modal", () =>
      update((current) => {
        const existing = current.providers.modal
        if (existing?.removal) {
          throw new Error("Compute provider modal removal is pending; retry disconnect before reconnecting")
        }
        current.providers.modal = {
          source: "modal_toml",
          path: path.resolve(filepath),
          enabled: true,
          connected_at: existing?.connected_at ?? new Date().toISOString(),
          last_used: null,
        }
      }),
    )
    return view(stored, Promise.resolve(file))
  }

  export async function disconnectProvider(target: string): Promise<Info> {
    target = canonicalProvider(target)
    const tombstoned = await CredentialLifecycle.mutate(`compute-provider.remove:${target}:tombstone`, () =>
      update((current) => {
        const entry = current.providers[target]
        if (!entry || entry.removal) return
        current.providers[target] = {
          source: entry.source,
          enabled: false,
          connected_at: entry.connected_at,
          last_used: null,
          executable: entry.executable,
          executable_approval: entry.executable_approval,
          removal: {
            token: crypto.randomUUID(),
            remote: entry.source === "account",
            requested_at: new Date().toISOString(),
          },
        }
      }),
    )
    const pending = tombstoned.providers[target]?.removal
    if (!pending) return view(tombstoned)
    if (pending.remote && !(await OpenScience.deletePortableCredential(target))) {
      throw new Error(`Could not remove ${target} from your Synthetic Sciences account`)
    }
    const stored = await CredentialLifecycle.mutate(`compute-provider.remove:${target}:finalize`, () =>
      update((current) => {
        if (current.providers[target]?.removal?.token === pending.token) delete current.providers[target]
      }),
    )
    return view(stored)
  }

  export async function setProviderEnabled(target: string, enabled: boolean): Promise<Info> {
    target = canonicalProvider(target)
    const stored = await CredentialLifecycle.mutate(`compute-provider.enabled:${target}`, () =>
      update((current) => {
        const entry = current.providers[target]
        if (!entry || entry.removal) throw new Error(`Compute provider ${target} is not connected`)
        entry.enabled = enabled
      }),
    )
    return view(stored)
  }

  async function reconcileAccountProvidersUnlocked(
    portable: Record<string, { fields: Record<string, string>; updated_at?: string | null }>,
  ): Promise<void> {
    const incoming = Object.fromEntries(Object.entries(portable).filter(([id]) => isProvider(id)))
    await update(async (current) => {
      for (const [id, entry] of Object.entries(current.providers)) {
        if (entry.removal) continue
        if (entry.source !== "account" || id in incoming) continue
        delete current.providers[id]
      }
      for (const [id, payload] of Object.entries(incoming)) {
        const existing = current.providers[id]
        if (existing?.removal) continue
        if (existing?.source === "stored" || existing?.source === "modal_toml") continue
        const key =
          id === "modal"
            ? payload.fields.token_id && payload.fields.token_secret
              ? `${payload.fields.token_id}:${payload.fields.token_secret}`
              : undefined
            : payload.fields.api_key
        if (!key) continue
        const sameCredential = existing?.key
          ? await decrypt(existing.key)
              .then((value) => value === key)
              .catch(() => false)
          : false
        current.providers[id] = {
          key: await encrypt(key),
          source: "account",
          enabled: existing?.enabled ?? true,
          connected_at: payload.updated_at ?? existing?.connected_at ?? new Date().toISOString(),
          last_used: sameCredential ? (existing?.last_used ?? null) : null,
          executable: existing?.executable,
          executable_approval: existing?.executable_approval,
        }
      }
    })
  }

  /** Reconcile portable provider records when no credential mutation is
   * already active. Dashboard sync uses the explicitly named held-mutation
   * variant below to avoid recursively acquiring the same cross-process lease. */
  export async function reconcileAccountProviders(
    portable: Record<string, { fields: Record<string, string>; updated_at?: string | null }>,
  ): Promise<void> {
    await CredentialLifecycle.mutate("compute-providers.reconcile", () => reconcileAccountProvidersUnlocked(portable))
  }

  export async function reconcileAccountProvidersDuringCredentialMutation(
    portable: Record<string, { fields: Record<string, string>; updated_at?: string | null }>,
  ): Promise<void> {
    await reconcileAccountProvidersUnlocked(portable)
  }

  export async function updateModal(input: ModalPatch): Promise<Info> {
    const patch = ModalPatch.parse(input)
    const stored = await update((current) => {
      current.modal = Modal.parse({ ...current.modal, ...patch })
    })
    return view(stored)
  }

  export async function modalConfig(): Promise<ModalAdapter.Config> {
    const stored = await read()
    const provider = stored.providers.modal
    if (!provider?.enabled) throw new Error("Compute provider modal is disabled")
    const file = provider.source === "modal_toml" && provider.path ? await readModal(provider.path) : undefined
    if (file && !file.ready) throw new Error(file.error ?? "Modal config does not contain one usable profile")
    return {
      app: stored.modal.app,
      image: stored.modal.image,
      environment: file?.environment,
      network: stored.modal.network,
      timeoutMinutes: stored.modal.timeout_minutes,
      concurrency: stored.modal.concurrency,
    }
  }

  export async function modalContext(): Promise<ModalAdapter.Context> {
    return CredentialLifecycle.admit(async () => {
      const [{ env }, config] = await Promise.all([providerEnvUnlocked("modal"), modalConfig()])
      return { ...config, tokenId: env.MODAL_TOKEN_ID!, tokenSecret: env.MODAL_TOKEN_SECRET! }
    })
  }

  export function modalResolver() {
    const cache: { value?: Promise<ModalAdapter.Context> } = {}
    return () => {
      cache.value ??= modalContext()
      return cache.value
    }
  }

  /** Resolve only reviewed symbolic references after a job approval. Values
   * stay inside the trusted compute adapter and are never returned by routes. */
  export function secretResolver() {
    return (refs: ComputeSecrets.Ref[]) => ComputeSecrets.resolve(refs, resolveCredentialFields)
  }

  export async function capabilities(): Promise<ComputeCapabilities.Target[]> {
    const stored = await read()
    const secrets = await ComputeSecrets.available(resolveCredentialFields)
    return ComputeCapabilities.describe({
      modal: stored.providers.modal?.enabled === true,
      hosts: stored.ssh_hosts,
      secrets,
    })
  }

  export async function addSshHost(input: Omit<SshHost, "id">): Promise<Info> {
    const identity = input.identity_file ? await identityFile(input.identity_file, os.homedir()) : undefined
    const stored = await update((current) => {
      current.ssh_hosts.push({
        id: id(),
        ...input,
        identity_file: identity,
        notes: input.notes?.trim() || undefined,
      })
    })
    return view(stored)
  }

  export async function removeSshHost(target: string): Promise<Info> {
    const stored = await update((current) => {
      current.ssh_hosts = current.ssh_hosts.filter((h) => h.id !== target)
    })
    return view(stored)
  }

  export async function updateSshHost(target: string, patch: SshHostPatch): Promise<Info> {
    const stored = await update((current) => {
      const index = current.ssh_hosts.findIndex((host) => host.id === target)
      if (index < 0) throw new Error(`SSH host ${target} was not found`)
      current.ssh_hosts[index] = SshHost.parse({
        ...current.ssh_hosts[index]!,
        ...patch,
        notes: patch.notes?.trim() || undefined,
      })
    })
    return view(stored)
  }

  export async function findSshHost(target: string): Promise<SshHost | undefined> {
    return (await read()).ssh_hosts.find((host) => host.id === target)
  }

  export async function verifySshHost(target: string, probe: JobBroker.Probe): Promise<Info> {
    if (!probe.ok || !probe.host_key || !probe.fingerprint) throw new Error(`SSH host ${target} was not verified`)
    const stored = await update((current) => {
      const index = current.ssh_hosts.findIndex((host) => host.id === target)
      if (index < 0) throw new Error(`SSH host ${target} was not found`)
      current.ssh_hosts[index] = SshHost.parse({
        ...current.ssh_hosts[index]!,
        host_key: probe.host_key,
        fingerprint: probe.fingerprint,
        proxy_jump_host_keys: probe.proxy_jump_host_keys,
      })
    })
    return view(stored)
  }
}

export const ComputeSettingsRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get compute settings",
        operationId: "settings.compute.get",
        responses: {
          200: {
            description: "Compute settings",
            content: { "application/json": { schema: resolver(ComputeSettings.Info) } },
          },
        },
      }),
      async (c) => c.json(await ComputeSettings.get()),
    )
    .post(
      "/environments/repair",
      describeRoute({
        summary: "Install or repair managed Python and R starter environments",
        operationId: "settings.compute.environments.repair",
        responses: {
          200: { description: "Updated", content: { "application/json": { schema: resolver(ComputeSettings.Info) } } },
        },
      }),
      async (c) => {
        await ManagedEnvironments.bootstrap()
        return c.json(await ComputeSettings.get())
      },
    )
    .post(
      "/provider/:id",
      describeRoute({
        summary: "Connect or update a GPU provider (BYOK)",
        operationId: "settings.compute.provider.connect",
        responses: {
          200: { description: "Updated", content: { "application/json": { schema: resolver(ComputeSettings.Info) } } },
          ...errors(400),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      validator("json", z.object({ key: z.string().min(1) })),
      async (c) => {
        const target = c.req.valid("param").id
        if (!ComputeSettings.isProvider(target)) return c.json({ error: "Unknown provider" }, 400)
        return c.json(await ComputeSettings.connectProvider(target, c.req.valid("json").key.trim()))
      },
    )
    .post(
      "/provider/:id/enabled",
      describeRoute({
        summary: "Enable or disable a connected compute provider",
        operationId: "settings.compute.provider.enabled",
        responses: {
          200: { description: "Updated", content: { "application/json": { schema: resolver(ComputeSettings.Info) } } },
          ...errors(400),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      validator("json", z.object({ enabled: z.boolean() })),
      async (c) => {
        const target = c.req.valid("param").id
        if (!ComputeSettings.isProvider(target)) return c.json({ error: "Unknown provider" }, 400)
        return c.json(await ComputeSettings.setProviderEnabled(target, c.req.valid("json").enabled))
      },
    )
    .post(
      "/provider/:id/doctor",
      describeRoute({
        summary: "Run the provider's reviewed read-only native connection check",
        operationId: "settings.compute.provider.doctor",
        responses: {
          200: {
            description: "Connection check result",
            content: { "application/json": { schema: resolver(ComputeSettings.ProviderDoctor) } },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const target = c.req.valid("param").id
        if (!ComputeSettings.isProvider(target) || target === "modal") {
          return c.json({ error: "Provider does not use the native CLI connection check" }, 400)
        }
        const { ProviderCli } = await import("../../../compute/provider-cli")
        return c.json(await ProviderCli.doctor(target))
      },
    )
    .delete(
      "/provider/:id",
      describeRoute({
        summary: "Disconnect a GPU provider",
        operationId: "settings.compute.provider.disconnect",
        responses: {
          200: { description: "Updated", content: { "application/json": { schema: resolver(ComputeSettings.Info) } } },
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        return c.json(await ComputeSettings.disconnectProvider(c.req.valid("param").id))
      },
    )
    .patch(
      "/modal",
      describeRoute({
        summary: "Update Modal compute defaults",
        operationId: "settings.compute.modal.update",
        responses: {
          200: { description: "Updated", content: { "application/json": { schema: resolver(ComputeSettings.Info) } } },
          ...errors(400),
        },
      }),
      validator("json", ComputeSettings.ModalPatch),
      async (c) => c.json(await ComputeSettings.updateModal(c.req.valid("json"))),
    )
    .get(
      "/modal/volumes",
      describeRoute({
        summary: "List Modal Volumes",
        operationId: "settings.compute.modal.volumes",
        responses: {
          200: {
            description: "Modal Volumes",
            content: {
              "application/json": {
                schema: resolver(z.object({ name: z.string() }).array()),
              },
            },
          },
          ...errors(400),
        },
      }),
      async (c) => c.json(await ModalVolume.volumes(await ComputeSettings.modalContext())),
    )
    .get(
      "/modal/volumes/:name/files",
      describeRoute({
        summary: "List files in a Modal Volume",
        operationId: "settings.compute.modal.volume.files",
        responses: {
          200: {
            description: "Modal Volume files",
            content: {
              "application/json": {
                schema: resolver(
                  z
                    .object({
                      path: z.string(),
                      type: z.string(),
                      size: z.number().int().nonnegative(),
                      mtime: z.number().optional(),
                    })
                    .array(),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("param", z.object({ name: z.string().trim().min(1) })),
      validator("query", z.object({ path: z.string().default("/") })),
      async (c) => {
        const input = c.req.valid("param")
        const query = c.req.valid("query")
        const context = await ComputeSettings.modalContext()
        return c.json(await ModalVolume.list(context, input.name, query.path, false))
      },
    )
    .get(
      "/modal/volumes/:name/file",
      describeRoute({
        summary: "Download a file from a Modal Volume",
        operationId: "settings.compute.modal.volume.file",
        responses: {
          200: { description: "Modal Volume file" },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ name: z.string().trim().min(1) })),
      validator("query", z.object({ path: z.string().trim().min(1) })),
      async (c) => {
        const input = c.req.valid("param")
        const query = c.req.valid("query")
        const context = await ComputeSettings.modalContext()
        const entries = await ModalVolume.list(context, input.name, path.posix.dirname(query.path), false)
        const entry = entries.find((item) => item.path === query.path.replace(/^\/+/, ""))
        if (!entry || entry.type !== "file") return c.json({ error: "Modal Volume file not found" }, 404)
        const staging = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-modal-volume-"))
        let cleanupPromise: Promise<void> | undefined
        const cleanup = () => (cleanupPromise ??= fs.rm(staging, { recursive: true, force: true }))
        let handedOff = false
        try {
          const file = await ModalVolume.download(context, input.name, [entry.path], staging, {
            signal: c.req.raw.signal,
            declaredBytes: entry.size,
          }).then((files) => {
            const file = files[0]
            if (!file) throw new Error(`Modal Volume did not download ${entry.path}`)
            return file
          })
          c.req.raw.signal.throwIfAborted()
          c.header("content-type", "application/octet-stream")
          c.header("content-disposition", modalDownloadDisposition(entry.path))
          c.header("content-length", String(file.size))
          const response = stream(c, async (output) => {
            let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
            let cancelled: Promise<void> | undefined
            let complete = false
            const abort = () => output.abort()
            try {
              reader = Bun.file(file.staging).stream().getReader()
              output.onAbort(() => (cancelled ??= reader!.cancel().catch(() => undefined)))
              if (c.req.raw.signal.aborted) abort()
              else c.req.raw.signal.addEventListener("abort", abort, { once: true })
              while (!output.aborted) {
                const next = await reader.read()
                if (next.done) {
                  complete = true
                  break
                }
                await output.write(next.value)
              }
            } finally {
              c.req.raw.signal.removeEventListener("abort", abort)
              if (reader) {
                if (!complete) cancelled ??= reader.cancel().catch(() => undefined)
                await cancelled
                reader.releaseLock()
              }
              await cleanup()
            }
          })
          handedOff = true
          return response
        } finally {
          if (!handedOff) await cleanup()
        }
      },
    )
    .post(
      "/modal/configure",
      describeRoute({
        summary: "Configure Modal from the active ~/.modal.toml profile",
        operationId: "settings.compute.modal.configure",
        responses: {
          200: {
            description: "Configured",
            content: { "application/json": { schema: resolver(ComputeSettings.Info) } },
          },
          ...errors(400),
        },
      }),
      async (c) => c.json(await ComputeSettings.configureModal()),
    )
    .post(
      "/modal/check",
      describeRoute({
        summary: "Check the enabled Modal connection",
        operationId: "settings.compute.modal.check",
        responses: {
          200: {
            description: "Connection result",
            content: { "application/json": { schema: resolver(z.object({ ok: z.literal(true), sdk: z.string() })) } },
          },
          ...errors(400),
        },
      }),
      async (c) => c.json(await ModalAdapter.check(await ComputeSettings.modalContext())),
    )
    .post(
      "/ssh",
      describeRoute({
        summary: "Add SSH host",
        operationId: "settings.compute.ssh.add",
        responses: {
          200: { description: "Updated", content: { "application/json": { schema: resolver(ComputeSettings.Info) } } },
          ...errors(400),
        },
      }),
      validator(
        "json",
        ComputeSettings.SshHost.omit({ id: true, fingerprint: true, host_key: true, proxy_jump_host_keys: true }),
      ),
      async (c) => c.json(await ComputeSettings.addSshHost(c.req.valid("json"))),
    )
    .post(
      "/ssh/:id/test",
      describeRoute({
        summary: "Test an SSH compute host",
        operationId: "settings.compute.ssh.test",
        responses: {
          200: {
            description: "Connection result",
            content: { "application/json": { schema: resolver(JobBroker.Probe) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const host = await ComputeSettings.findSshHost(c.req.valid("param").id)
        if (!host) return c.json({ error: "SSH host not found" }, 404)
        const probe = await JobBroker.probe(host)
        if (probe.ok) await ComputeSettings.verifySshHost(host.id, probe)
        return c.json(probe)
      },
    )
    .patch(
      "/ssh/:id",
      describeRoute({
        summary: "Update SSH host notes",
        operationId: "settings.compute.ssh.update",
        responses: {
          200: { description: "Updated", content: { "application/json": { schema: resolver(ComputeSettings.Info) } } },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      validator("json", ComputeSettings.SshHostPatch),
      async (c) => {
        const target = c.req.valid("param").id
        if (!(await ComputeSettings.findSshHost(target))) return c.json({ error: "SSH host not found" }, 404)
        return c.json(await ComputeSettings.updateSshHost(target, c.req.valid("json")))
      },
    )
    .delete(
      "/ssh/:id",
      describeRoute({
        summary: "Remove SSH host",
        operationId: "settings.compute.ssh.remove",
        responses: {
          200: { description: "Updated", content: { "application/json": { schema: resolver(ComputeSettings.Info) } } },
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => c.json(await ComputeSettings.removeSshHost(c.req.valid("param").id)),
    )
    .get(
      "/jobs",
      describeRoute({
        summary: "List local and remote compute jobs",
        operationId: "settings.compute.jobs.list",
        responses: {
          200: {
            description: "Compute jobs",
            content: { "application/json": { schema: resolver(JobBroker.Job.array()) } },
          },
        },
      }),
      validator("query", Directory),
      async (c) =>
        project(c, async () => {
          const settings = await ComputeSettings.get()
          const provider = settings.providers.find((item) => item.id === "modal")
          const resolveCredentials = provider?.enabled ? ComputeSettings.modalResolver() : undefined
          return c.json(await JobBroker.list({ resolveCredentials, resolveSecrets: ComputeSettings.secretResolver() }))
        }),
    )
    .post(
      "/jobs/plan",
      describeRoute({
        summary: "Prepare an exact remote run plan for approval",
        operationId: "settings.compute.jobs.plan",
        responses: {
          200: {
            description: "Remote run plan",
            content: { "application/json": { schema: resolver(JobBroker.Plan) } },
          },
          ...errors(400, 409),
        },
      }),
      validator("query", Directory),
      validator("json", JobBroker.Request),
      async (c) => {
        return project(c, async () => {
          const input = c.req.valid("json")
          const settings = await ComputeSettings.get()
          return c.json(
            await JobBroker.plan(input, {
              projectDirectory: Instance.directory,
              workspace: await SessionFilesystem.workspace(input.sessionID),
              hosts: settings.ssh_hosts,
              modal: input.target.kind === "modal" ? await ComputeSettings.modalConfig() : undefined,
              resolveSecrets: ComputeSettings.secretResolver(),
            }),
          )
        })
      },
    )
    .post(
      "/jobs",
      describeRoute({
        summary: "Start a compute job",
        operationId: "settings.compute.jobs.start",
        responses: {
          200: { description: "Started job", content: { "application/json": { schema: resolver(JobBroker.Job) } } },
          ...errors(400, 409),
        },
      }),
      validator("query", Directory),
      validator("json", JobBroker.Request),
      async (c) => {
        return project(c, async () => {
          const input = c.req.valid("json")
          const settings = input.target.kind === "ssh" ? await ComputeSettings.get() : undefined
          const sshHostID = input.target.kind === "ssh" ? input.target.host_id : undefined
          if (sshHostID && !settings?.ssh_hosts.some((host) => host.id === sshHostID)) {
            throw new HTTPException(400, { message: "The selected SSH compute profile was not found." })
          }
          const modal = input.target.kind === "modal" ? await ComputeSettings.modalConfig() : undefined
          const resolveCredentials = input.target.kind === "modal" ? ComputeSettings.modalResolver() : undefined
          return c.json(
            await JobBroker.start(input, {
              projectDirectory: Instance.directory,
              workspace: await SessionFilesystem.workspace(input.sessionID),
              hosts: settings?.ssh_hosts,
              modal,
              resolveCredentials,
              resolveSecrets: ComputeSettings.secretResolver(),
            }),
          )
        })
      },
    )
    .delete(
      "/jobs/completed",
      describeRoute({
        summary: "Clear completed compute jobs",
        operationId: "settings.compute.jobs.clear",
        responses: {
          200: {
            description: "Number cleared",
            content: {
              "application/json": { schema: resolver(z.object({ cleared: z.number().int().nonnegative() })) },
            },
          },
        },
      }),
      validator("query", Directory),
      async (c) =>
        project(c, async () => {
          return c.json({ cleared: await JobBroker.clear() })
        }),
    )
    .get(
      "/jobs/:id/log",
      describeRoute({
        summary: "Read a compute job log",
        operationId: "settings.compute.jobs.log",
        responses: {
          200: {
            description: "Job output",
            content: { "application/json": { schema: resolver(z.object({ log: z.string() })) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      validator("query", Directory),
      async (c) => {
        return project(c, async () => {
          const job = await JobBroker.get(c.req.valid("param").id)
          if (!job) return c.json({ error: "Compute job not found" }, 404)
          return c.json({ log: await JobBroker.log(job.id) })
        })
      },
    )
    .get(
      "/jobs/:id/events",
      describeRoute({
        summary: "Read compute provider lifecycle logs",
        operationId: "settings.compute.jobs.events",
        responses: {
          200: {
            description: "Provider lifecycle logs",
            content: { "application/json": { schema: resolver(z.object({ events: z.string() })) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      validator("query", Directory),
      async (c) => {
        return project(c, async () => {
          const job = await JobBroker.get(c.req.valid("param").id)
          if (!job) return c.json({ error: "Compute job not found" }, 404)
          return c.json({ events: await JobBroker.events(job.id) })
        })
      },
    )
    .post(
      "/jobs/:id/retry",
      describeRoute({
        summary: "Retry output delivery from a retained remote resource",
        operationId: "settings.compute.jobs.retry",
        responses: {
          200: {
            description: "Recovery started",
            content: { "application/json": { schema: resolver(JobBroker.Job) } },
          },
          ...errors(400, 404, 409),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      validator("query", Directory),
      async (c) => {
        return project(c, async () => {
          const job = await JobBroker.get(c.req.valid("param").id)
          if (!job) return c.json({ error: "Compute job not found" }, 404)
          return c.json(
            await JobBroker.retry(job.id, {
              resolveCredentials: ComputeSettings.modalResolver(),
              resolveSecrets: ComputeSettings.secretResolver(),
            }),
          )
        })
      },
    )
    .post(
      "/jobs/:id/release",
      describeRoute({
        summary: "Release retained compute resources",
        operationId: "settings.compute.jobs.release",
        responses: {
          200: {
            description: "Resources released",
            content: { "application/json": { schema: resolver(JobBroker.Job) } },
          },
          ...errors(400, 404, 409),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      validator("query", Directory),
      async (c) => {
        return project(c, async () => {
          const job = await JobBroker.get(c.req.valid("param").id)
          if (!job) return c.json({ error: "Compute job not found" }, 404)
          const settings = await ComputeSettings.get()
          const provider = settings.providers.find((item) => item.id === "modal")
          const resolveCredentials =
            job.target.kind === "modal" && provider?.enabled ? ComputeSettings.modalResolver() : undefined
          return c.json(
            await JobBroker.release(job.id, {
              hosts: settings.ssh_hosts,
              resolveCredentials,
              resolveSecrets: ComputeSettings.secretResolver(),
            }),
          )
        })
      },
    )
    .post(
      "/jobs/:id/cancel",
      describeRoute({
        summary: "Cancel a compute job",
        operationId: "settings.compute.jobs.cancel",
        responses: {
          200: { description: "Cancelled job", content: { "application/json": { schema: resolver(JobBroker.Job) } } },
          ...errors(404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      validator("query", Directory),
      async (c) => {
        return project(c, async () => {
          const settings = await ComputeSettings.get()
          const job = await JobBroker.get(c.req.valid("param").id)
          if (!job) return c.json({ error: "Compute job not found" }, 404)
          const provider = settings.providers.find((item) => item.id === "modal")
          const resolveCredentials =
            job.target.kind === "modal" && provider?.enabled ? ComputeSettings.modalResolver() : undefined
          return c.json(
            await JobBroker.cancel(job.id, {
              hosts: settings.ssh_hosts,
              resolveCredentials,
              resolveSecrets: ComputeSettings.secretResolver(),
            }),
          )
        })
      },
    ),
)

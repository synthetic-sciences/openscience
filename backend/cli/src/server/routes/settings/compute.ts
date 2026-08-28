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
import { Env } from "../../../env"
import { SessionFilesystem } from "../../../session/filesystem"
import { ManagedEnvironments } from "../../../science/kernel/environment-manager"
import { ComputeSecrets } from "../../../compute/secrets"
import { ComputeCapabilities } from "../../../compute/capabilities"
import { resolveCredentialFields } from "./credentials"

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
// Providers that still run through shipped CLI skills retain their legacy
// environment bridge until they gain equivalent control-plane adapters.

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
  // `verified` = a first-class provider whose integration we've validated;
  // surfaced as the green "verified" badge vs a plain "connected" one.
  export interface ProviderSpec {
    id: string
    name: string
    verified: boolean
    placeholder: string
    hint: string
  }

  const CATALOG: ProviderSpec[] = [
    { id: "modal", name: "Modal", verified: true, placeholder: "ak-… : as-…", hint: "Serverless GPU compute." },
    { id: "tensorpool", name: "TensorPool", verified: true, placeholder: "tp-…", hint: "On-demand GPU clusters." },
    { id: "lambda", name: "Lambda Labs", verified: true, placeholder: "secret_…", hint: "Cloud GPU instances." },
    {
      id: "prime_intellect",
      name: "Prime Intellect",
      verified: false,
      placeholder: "pi-…",
      hint: "Decentralized GPU marketplace.",
    },
    { id: "vast", name: "Vast.ai", verified: false, placeholder: "vast api key", hint: "Spot GPU marketplace." },
    { id: "runpod", name: "RunPod", verified: false, placeholder: "rpa_…", hint: "Community & secure GPU cloud." },
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
  })
  export type SshConfigHost = z.infer<typeof SshConfigHost>

  export const Provider = z.object({
    id: z.string(),
    name: z.string(),
    verified: z.boolean(),
    placeholder: z.string(),
    hint: z.string(),
    connected: z.boolean(),
    enabled: z.boolean(),
    source: z.enum(["stored", "account", "modal_toml"]).nullable(),
    connected_at: z.string().nullable(),
    last_used: z.string().nullable(),
  })
  export type Provider = z.infer<typeof Provider>

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
  const StoredProvider = z.object({
    key: z.string().optional(),
    source: z.enum(["stored", "account", "modal_toml"]).default("stored"),
    path: z.string().optional(),
    enabled: z.boolean().default(false),
    connected_at: z.string(),
    last_used: z.string().nullable().default(null),
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
  const owned = new Map<string, string>()
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

  export async function providerEnv(target: string): Promise<Record<string, string>> {
    target = canonicalProvider(target)
    const entry = (await read()).providers[target]
    if (!entry?.enabled) throw new Error(`Compute provider ${target} is disabled`)
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
    return env
  }

  /** Keep legacy skill-based providers working without exposing Modal tokens.
   *  Explicit shell exports win over values owned by this settings store. */
  export async function applyComputeEnv(): Promise<void> {
    const stored = await read()
    const env: Record<string, string> = {}
    const secrets: string[] = []
    for (const [target, entry] of Object.entries(stored.providers)) {
      if (target === "modal" || !entry.enabled || !entry.key) continue
      const key = await decrypt(entry.key).catch(() => undefined)
      if (!key) continue
      for (const [name, value] of Object.entries(mapProviderEnv(target, key))) {
        env[name] = value
        secrets.push(value)
      }
    }
    for (const [name, value] of owned) {
      if (name in env) continue
      if (process.env[name] === value) delete process.env[name]
      owned.delete(name)
    }
    for (const [name, value] of Object.entries(env)) {
      const previous = owned.get(name)
      if (process.env[name] && process.env[name] !== previous) {
        owned.delete(name)
        continue
      }
      process.env[name] = value
      await Promise.resolve()
        .then(() => Env.set(name, value))
        .catch(() => undefined)
      owned.set(name, value)
    }
    OpenScience.registerSecretValues(secrets)
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

  /** Read literal Host stanzas without executing ssh(1), Match exec, Include,
   *  ProxyCommand, or any other user-configured program. Import copies only
   *  host, user, and port into the fixed broker transport; wildcard/negated
   *  entries and identity/proxy directives are deliberately ignored. */
  export async function sshConfigHosts(filepath = path.join(os.homedir(), ".ssh", "config")): Promise<SshConfigHost[]> {
    const text = await Bun.file(filepath)
      .text()
      .catch(() => undefined)
    if (!text) return []
    const found = new Map<string, SshConfigHost>()
    let aliases: string[] = []
    let values: Omit<SshConfigHost, "alias"> = {}
    const flush = () => {
      for (const alias of aliases) {
        if (found.has(alias)) continue
        const parsed = SshConfigHost.safeParse({ alias, ...values })
        if (parsed.success) found.set(alias, parsed.data)
      }
      aliases = []
      values = {}
    }
    for (const line of text.split(/\r?\n/)) {
      const match = line.trim().match(/^([^\s=]+)(?:\s+|\s*=\s*)(.*)$/)
      if (!match) continue
      const key = match[1]!.toLowerCase()
      const tokens = sshConfigTokens(match[2]!)
      if (key === "host") {
        flush()
        aliases = tokens.filter((alias) => alias && !alias.startsWith("!") && !/[*?\[\]]/.test(alias))
        continue
      }
      if (key === "match") {
        flush()
        continue
      }
      if (!aliases.length || !tokens[0]) continue
      if (key === "hostname" && !tokens[0].includes("%")) values.hostname ??= tokens[0]
      if (key === "user" && !tokens[0].includes("%") && !tokens[0].includes("@")) values.user ??= tokens[0]
      if (key === "port") {
        const port = Number(tokens[0])
        if (Number.isInteger(port) && port >= 1 && port <= 65_535) values.port ??= port
      }
    }
    flush()
    return [...found.values()].toSorted((a, b) => a.alias.localeCompare(b.alias))
  }

  // Build the client-facing view — never includes the encrypted key.
  async function view(stored: Stored, file = modalFile(), configHosts = sshConfigHosts()): Promise<Info> {
    const providers = CATALOG.map((spec) => {
      const entry = stored.providers[spec.id]
      return {
        id: spec.id,
        name: spec.name,
        verified: spec.verified,
        placeholder: spec.placeholder,
        hint: spec.hint,
        connected: !!entry,
        enabled: entry?.enabled ?? false,
        source: entry?.source ?? null,
        connected_at: entry?.connected_at ?? null,
        last_used: entry?.last_used ?? null,
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
    const stored = await update(async (current) => {
      const existing = current.providers[target]
      current.providers[target] = {
        key: await encrypt(key),
        source: authenticated ? "account" : "stored",
        enabled: existing?.enabled ?? false,
        connected_at: existing?.connected_at ?? new Date().toISOString(),
        last_used: existing?.last_used ?? null,
      }
    })
    await applyComputeEnv()
    return view(stored)
  }

  export async function configureModal(filepath = path.join(os.homedir(), ".modal.toml")): Promise<Info> {
    const file = await modalFile(filepath)
    if (!file.ready)
      throw new HTTPException(400, {
        message: file.error ?? "Modal config does not contain one usable profile.",
      })
    const stored = await update((current) => {
      const existing = current.providers.modal
      current.providers.modal = {
        source: "modal_toml",
        path: path.resolve(filepath),
        enabled: true,
        connected_at: existing?.connected_at ?? new Date().toISOString(),
        last_used: existing?.last_used ?? null,
      }
    })
    return view(stored, Promise.resolve(file))
  }

  export async function disconnectProvider(target: string): Promise<Info> {
    target = canonicalProvider(target)
    const entry = (await read()).providers[target]
    if (entry?.source === "account" && !(await OpenScience.deletePortableCredential(target))) {
      throw new Error(`Could not remove ${target} from your Synthetic Sciences account`)
    }
    const stored = await update((current) => {
      delete current.providers[target]
    })
    await applyComputeEnv()
    return view(stored)
  }

  export async function setProviderEnabled(target: string, enabled: boolean): Promise<Info> {
    target = canonicalProvider(target)
    const stored = await update((current) => {
      const entry = current.providers[target]
      if (!entry) throw new Error(`Compute provider ${target} is not connected`)
      entry.enabled = enabled
    })
    await applyComputeEnv()
    return view(stored)
  }

  export async function reconcileAccountProviders(
    portable: Record<string, { fields: Record<string, string>; updated_at?: string | null }>,
  ): Promise<void> {
    const incoming = Object.fromEntries(Object.entries(portable).filter(([id]) => isProvider(id)))
    await update(async (current) => {
      for (const [id, entry] of Object.entries(current.providers)) {
        if (entry.source !== "account" || id in incoming) continue
        delete current.providers[id]
      }
      for (const [id, payload] of Object.entries(incoming)) {
        const existing = current.providers[id]
        if (existing?.source === "stored" || existing?.source === "modal_toml") continue
        const key =
          id === "modal"
            ? payload.fields.token_id && payload.fields.token_secret
              ? `${payload.fields.token_id}:${payload.fields.token_secret}`
              : undefined
            : payload.fields.api_key
        if (!key) continue
        current.providers[id] = {
          key: await encrypt(key),
          source: "account",
          enabled: existing?.enabled ?? true,
          connected_at: payload.updated_at ?? existing?.connected_at ?? new Date().toISOString(),
          last_used: existing?.last_used ?? null,
        }
      }
    })
    await applyComputeEnv()
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
    const [env, config] = await Promise.all([providerEnv("modal"), modalConfig()])
    OpenScience.registerSecretValues([env.MODAL_TOKEN_ID!, env.MODAL_TOKEN_SECRET!])
    return { ...config, tokenId: env.MODAL_TOKEN_ID!, tokenSecret: env.MODAL_TOKEN_SECRET! }
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
    const stored = await update((current) => {
      current.ssh_hosts.push({ id: id(), ...input, notes: input.notes?.trim() || undefined })
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
      validator("json", ComputeSettings.SshHost.omit({ id: true, fingerprint: true, host_key: true })),
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

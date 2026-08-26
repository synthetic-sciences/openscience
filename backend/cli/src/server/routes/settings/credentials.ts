/**
 * Encrypted-at-rest credential store for external services (settings ▸
 * Credentials). Distinct from provider BYOK keys (auth.json) — this holds
 * secrets for AWS, GitHub, Modal, etc. that skills and tools consume.
 *
 * Storage layout (both under Global.Path.data, mode 0600):
 *   credentials.json  — { [serviceId]: { label?, fields: { name: cipher }, updated_at } }
 *   credentials.key   — 32 random bytes, the machine-local AES-256-GCM key.
 *
 * Every field VALUE is encrypted individually (iv|tag|ciphertext, base64). The
 * API never returns a decrypted value — only which field names are set — so a
 * key is write-only from the UI's perspective, matching the "keys never shown
 * after save" requirement.
 *
 * How a stored credential actually does something: applyCredentialEnv() decrypts
 * the store and injects each field into the process environment under the
 * canonical var names the real consumers already read — Bedrock/S3 (provider.ts
 * reads AWS_ACCESS_KEY_ID), the in-process literature connectors (Semantic
 * Scholar `x-api-key`, OpenAlex mailto/key), and — via OpenScience.subprocessEnv,
 * which forwards non-managed env vars — approved skill/bash subprocesses (aws,
 * gh, gcloud, …). Governed Modal tokens remain in settings ▸ Compute and never
 * enter agent-controlled shells.
 * It runs at CLI/server boot (index.ts middleware) and again
 * after each save/delete so changes apply live without a restart. Decrypted
 * secret values are registered for output redaction.
 */
import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import crypto from "crypto"
import fs from "node:fs/promises"
import { DataRootBarrier } from "@/global/data-root-barrier"
import path from "path"
import z from "zod"
import { Global } from "@/global"
import { Env } from "@/env"
import { OpenScience } from "@/openscience"
import { CredentialLifecycle } from "@/credentials/lifecycle"
import { lazy } from "@/util/lazy"
import { JsonStore } from "@/util/jsonstore"
import { SecretFile } from "@/util/secret-file"
import { SecretBox } from "@/util/secret-box"

type FieldType = "password" | "text" | "textarea"

interface FieldSpec {
  name: string
  label: string
  type: FieldType
  optional?: boolean
  placeholder?: string
}

interface ServiceSpec {
  id: string
  label: string
  description: string
  category: "compute" | "integration"
  fields: FieldSpec[]
  /** Trusted-only credentials are resolved by an in-process adapter and are
   * never copied into process.env or agent-controlled subprocesses. */
  trusted?: boolean
  /** Compute credentials sync to the account unless explicitly device-only. */
  portable?: boolean
}

// Known services and the shape of the secret each one needs. "Custom" entries
// (user-defined) are not listed here — they are stored ad-hoc with a single
// value field and surfaced back from the store.
const CATALOG: ServiceSpec[] = [
  {
    id: "aws",
    label: "AWS",
    description: "Access key for S3, Bedrock, and other AWS services.",
    category: "compute",
    fields: [
      { name: "access_key_id", label: "Access key ID", type: "text", placeholder: "AKIA…" },
      { name: "secret_access_key", label: "Secret access key", type: "password" },
      { name: "region", label: "Default region", type: "text", optional: true, placeholder: "us-east-1" },
    ],
  },
  {
    id: "github",
    label: "GitHub",
    description: "Personal access token for repositories and the GitHub API.",
    category: "integration",
    fields: [{ name: "token", label: "Access token", type: "password", placeholder: "ghp_… / github_pat_…" }],
  },
  {
    id: "gcp",
    label: "Google Cloud",
    description: "Service-account credentials for GCP APIs and storage.",
    category: "compute",
    fields: [
      { name: "project_id", label: "Project ID", type: "text", optional: true },
      { name: "service_account_json", label: "Service account JSON", type: "textarea", placeholder: "{ … }" },
    ],
  },
  {
    id: "literature",
    label: "Literature access",
    description: "Semantic Scholar API key for literature retrieval.",
    category: "integration",
    fields: [{ name: "api_key", label: "API key", type: "password" }],
  },
  {
    id: "firecrawl",
    label: "Firecrawl",
    description: "Optional own API key for enhanced web search when Ace managed search is unavailable.",
    category: "integration",
    fields: [{ name: "api_key", label: "API key", type: "password", placeholder: "fc-…" }],
    trusted: true,
  },
  {
    id: "azure",
    label: "Microsoft Azure",
    description: "Service principal or API credentials for Azure workloads.",
    category: "compute",
    fields: [
      { name: "tenant_id", label: "Tenant ID", type: "text", optional: true },
      { name: "client_id", label: "Client ID", type: "text", optional: true },
      { name: "client_secret", label: "Client secret", type: "password", optional: true },
      { name: "subscription_id", label: "Subscription ID", type: "text", optional: true },
      { name: "api_key", label: "API key", type: "password", optional: true },
      { name: "endpoint", label: "Endpoint", type: "text", optional: true, placeholder: "https://….openai.azure.com" },
    ],
  },
  {
    id: "nvidia",
    label: "NVIDIA API",
    description: "API key for NVIDIA NIM / build.nvidia.com models.",
    category: "compute",
    fields: [{ name: "api_key", label: "API key", type: "password", placeholder: "nvapi-…" }],
    trusted: true,
  },
  {
    id: "nvidia_ngc",
    label: "NVIDIA NGC Registry",
    description: "Device-local NGC key for approved NVIDIA container pulls on trusted compute adapters.",
    category: "compute",
    fields: [{ name: "api_key", label: "NGC API key", type: "password" }],
    trusted: true,
    portable: false,
  },
  {
    id: "openalex",
    label: "OpenAlex",
    description: "Polite-pool email (and optional key) for the OpenAlex API.",
    category: "integration",
    fields: [
      { name: "email", label: "Contact email", type: "text", placeholder: "you@example.com" },
      { name: "api_key", label: "API key", type: "password", optional: true },
    ],
  },
  {
    id: "huggingface",
    label: "Hugging Face",
    description: "Token for models, datasets, and the Hugging Face Hub.",
    category: "integration",
    fields: [{ name: "api_key", label: "Access token", type: "password", placeholder: "hf_…" }],
  },
  {
    id: "tinker",
    label: "Tinker",
    description: "API key for Tinker training and inference.",
    category: "integration",
    fields: [
      { name: "api_key", label: "API key", type: "password" },
      { name: "base_url", label: "Base URL", type: "text", optional: true },
    ],
  },
  {
    id: "wandb",
    label: "Weights & Biases",
    description: "API key for experiment tracking and artifact logging.",
    category: "integration",
    fields: [{ name: "api_key", label: "API key", type: "password" }],
  },
  {
    id: "pinecone",
    label: "Pinecone",
    description: "API key for vector indexes and retrieval.",
    category: "integration",
    fields: [{ name: "api_key", label: "API key", type: "password" }],
  },
  {
    id: "langsmith",
    label: "LangSmith",
    description: "API key for tracing, evaluation, and observability.",
    category: "integration",
    fields: [{ name: "api_key", label: "API key", type: "password" }],
  },
]

const StoreEntry = z.object({
  label: z.string().optional(),
  fields: z.record(z.string(), z.string()),
  updated_at: z.string(),
  source: z.enum(["local", "account"]).default("local"),
})
type StoreEntry = z.infer<typeof StoreEntry>
const Store = z.record(z.string(), StoreEntry)
type Store = z.infer<typeof Store>

const storePath = path.join(Global.Path.data, "credentials.json")
const keyPath = path.join(Global.Path.data, "credentials.key")
const gcpPath = path.join(Global.Path.data, "gcp-service-account.json")

async function machineKey(): Promise<Buffer> {
  return SecretFile.key(keyPath)
}

// The envelope itself lives in util/secret-box so the data-directory import can
// share it: moving a store between roots means holding both machine keys at
// once, and that code sits below Global in the module graph.
async function encrypt(plain: string): Promise<string> {
  return SecretBox.seal(await machineKey(), plain)
}

// Throws on a bad key/tag, which callers treat as "unreadable field, skip it".
async function decrypt(payload: string): Promise<string> {
  return SecretBox.open(await machineKey(), payload)
}

function parseStore(data: Record<string, unknown>): Store {
  const parsed = Store.safeParse(data)
  return parsed.success ? parsed.data : {}
}

async function readStore(): Promise<Store> {
  return parseStore(await JsonStore.read(storePath))
}

async function updateStore(fn: (store: Store) => void | Promise<void>): Promise<Store> {
  const result: { value?: Store } = {}
  await JsonStore.update(storePath, async (data) => {
    const store = Store.parse(data)
    await fn(store)
    result.value = store
    return store
  })
  if (!result.value) throw new Error("Credential update completed without a store")
  return result.value
}

/** Trusted adapters read their encrypted fields directly from the shared store
 * at each paid/provider boundary. They never inherit those values through
 * process.env or a child process, so publishing a process-credential revision
 * would only tear down unrelated active sessions. The shared mutation lease is
 * still required to serialize writers. Environment-backed credentials retain
 * the full cross-process refresh and revocation contract. */
async function mutateCredentialStore<T>(id: string, reason: string, action: () => T | Promise<T>): Promise<T> {
  if (specFor(id)?.trusted) return CredentialLifecycle.serialized(action)
  return CredentialLifecycle.mutate(reason, action)
}

function specFor(id: string): ServiceSpec | undefined {
  return CATALOG.find((s) => s.id === id)
}

// ── runtime env injection ───────────────────────────────────────────────────
// This is the ONLY thing that turns a stored credential into a working one.

/** Field names whose values are NOT secret (endpoints, regions, project ids,
 *  contact emails, file paths) — excluded from output redaction. */
const NON_SECRET_ENV =
  /(_ENDPOINT|_REGION|_PROJECT|_MAILTO|_BASE_URL|_CLIENT_ID|_TENANT_ID|_SUBSCRIPTION_ID|_TRACING)$|GOOGLE_APPLICATION_CREDENTIALS/

/** Map one service's decrypted fields to the canonical env var names its real
 *  consumers read. GCP's service-account JSON is handled separately (it needs a
 *  file on disk). Custom user services expose each field as <ID>_<FIELD>. */
function mapServiceEnv(id: string, f: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  const put = (key: string, value: string | undefined) => {
    if (value) out[key] = value
  }
  switch (id) {
    case "aws":
      put("AWS_ACCESS_KEY_ID", f.access_key_id)
      put("AWS_SECRET_ACCESS_KEY", f.secret_access_key)
      put("AWS_DEFAULT_REGION", f.region)
      put("AWS_REGION", f.region)
      return out
    case "github":
      put("GITHUB_TOKEN", f.token)
      put("GH_TOKEN", f.token)
      return out
    case "gcp":
      put("GOOGLE_CLOUD_PROJECT", f.project_id)
      put("GCLOUD_PROJECT", f.project_id)
      return out // service_account_json → file, handled in readDecryptedEnv
    case "literature":
      put("SEMANTIC_SCHOLAR_API_KEY", f.api_key)
      return out
    case "azure":
      put("AZURE_TENANT_ID", f.tenant_id)
      put("AZURE_CLIENT_ID", f.client_id)
      put("AZURE_CLIENT_SECRET", f.client_secret)
      put("AZURE_SUBSCRIPTION_ID", f.subscription_id)
      put("AZURE_OPENAI_API_KEY", f.api_key)
      put("AZURE_API_KEY", f.api_key)
      put("AZURE_OPENAI_ENDPOINT", f.endpoint)
      return out
    case "nvidia":
    case "nvidia_ngc":
    case "firecrawl":
      // These credentials cross a paid/provider boundary. Their trusted
      // adapters resolve the encrypted fields just in time; keeping them out
      // of process.env also keeps them out of bash, skills, and child shells.
      return out
    case "openalex":
      put("OPENALEX_MAILTO", f.email)
      put("OPENALEX_API_KEY", f.api_key)
      return out
    case "huggingface":
      put("HF_TOKEN", f.api_key)
      put("HUGGING_FACE_HUB_TOKEN", f.api_key)
      return out
    case "tinker":
      put("TINKER_API_KEY", f.api_key)
      put("TINKER_BASE_URL", f.base_url)
      return out
    case "wandb":
      put("WANDB_API_KEY", f.api_key)
      return out
    case "pinecone":
      put("PINECONE_API_KEY", f.api_key)
      return out
    case "langsmith":
      put("LANGSMITH_API_KEY", f.api_key)
      put("LANGCHAIN_API_KEY", f.api_key)
      put("LANGSMITH_TRACING", f.api_key ? "true" : undefined)
      return out
    default:
      if (id.startsWith("custom:")) {
        const prefix = id
          .slice(7)
          .toUpperCase()
          .replace(/[^A-Z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "")
        if (prefix) {
          for (const [name, value] of Object.entries(f)) {
            const field = name
              .toUpperCase()
              .replace(/[^A-Z0-9]+/g, "_")
              .replace(/^_+|_+$/g, "")
            if (field) put(`${prefix}_${field}`, value)
          }
        }
      }
      return out
  }
}

interface CredentialEnv {
  env: Record<string, string>
  secrets: string[]
  materializationError?: unknown
}

async function decryptFields(entry: StoreEntry): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const [name, cipher] of Object.entries(entry.fields)) {
    try {
      out[name] = await decrypt(cipher)
    } catch {
      // Unreadable (rotated key / corrupt) — omit from runtime and API state.
    }
  }
  return out
}

function validField(id: string, name: string, value: string): boolean {
  if (id !== "gcp" || name !== "service_account_json") return true
  try {
    const parsed: unknown = JSON.parse(value)
    return !!parsed && typeof parsed === "object" && !Array.isArray(parsed)
  } catch {
    return false
  }
}

async function validDecryptedFields(id: string, entry: StoreEntry): Promise<Record<string, string>> {
  const fields = await decryptFields(entry)
  return Object.fromEntries(Object.entries(fields).filter(([name, value]) => validField(id, name, value)))
}

/** Resolve one encrypted service credential for a trusted in-process adapter.
 * Values are never returned by HTTP routes and never copied into process.env. */
export async function resolveCredentialFields(id: string): Promise<Record<string, string> | undefined> {
  const spec = specFor(id)
  if (!spec?.trusted) return
  const entry = (await readStore())[id]
  if (!entry) return
  const fields = await validDecryptedFields(id, entry)
  if (!Object.keys(fields).length) return
  OpenScience.registerSecretValues(Object.values(fields))
  return fields
}

export async function hasCredentialFields(id: string, names: string[]): Promise<boolean> {
  const fields = await resolveCredentialFields(id)
  return !!fields && names.every((name) => !!fields[name])
}

async function atomicSecretWrite(filepath: string, content: string): Promise<void> {
  await using operation = await DataRootBarrier.enter(filepath)
  const temp = `${filepath}.${process.pid}.${crypto.randomUUID()}.tmp`
  await fs.mkdir(path.dirname(filepath), { recursive: true })
  const handle = await fs.open(temp, "wx", 0o600)
  await handle
    .chmod(0o600)
    .then(() => handle.writeFile(content, "utf8"))
    .then(() => handle.sync())
    .finally(() => handle.close())
    .catch(async (error) => {
      await fs.rm(temp, { force: true }).catch(() => undefined)
      throw error
    })
  await fs.rename(temp, filepath).catch(async (error) => {
    await fs.rm(temp, { force: true }).catch(() => undefined)
    throw error
  })
  const directory = await fs.open(path.dirname(filepath), "r").catch(() => undefined)
  await directory?.sync().catch(() => undefined)
  await directory?.close().catch(() => undefined)
}

/** Decrypt the whole store into canonical env vars + the list of secret-bearing
 *  values to redact. GCP service-account JSON is materialized to a 0600 file. */
async function readDecryptedEnv(): Promise<CredentialEnv> {
  const store = await readStore()
  const env: Record<string, string> = {}
  const secrets: string[] = []
  let gcp: string | undefined
  let materializationError: unknown
  for (const [id, entry] of Object.entries(store)) {
    const fields = await validDecryptedFields(id, entry)
    if (specFor(id)?.trusted) secrets.push(...Object.values(fields))
    if (id === "gcp") gcp = fields.service_account_json
    const mapped = mapServiceEnv(id, fields)
    for (const [key, value] of Object.entries(mapped)) {
      env[key] = value
      if (!NON_SECRET_ENV.test(key)) secrets.push(value)
    }
  }
  if (gcp) {
    try {
      await atomicSecretWrite(gcpPath, gcp)
      env.GOOGLE_APPLICATION_CREDENTIALS = gcpPath
      secrets.push(gcp)
    } catch (error) {
      // A failed rotation must not leave the previous service-account document
      // live under the canonical path.
      await fs.rm(gcpPath, { force: true }).catch(() => undefined)
      materializationError = error
    }
  } else {
    // Deleted, corrupt, or undecryptable ciphertext is disconnected state.
    // Remove the materialized plaintext before dropping the environment path.
    await fs.rm(gcpPath, { force: true }).catch(() => undefined)
  }
  return { env, secrets, materializationError }
}

// Env keys this module has set, so a re-apply after save can update our own
// values while still never clobbering an explicit shell export.
const ownedKeys = new Set<string>()

/** Decrypt stored service credentials and inject them into the process
 *  environment so the real consumers use them (see the module header). Explicit
 *  shell exports always win. Registers secret values for redaction. Best-effort;
 *  never throws. Call at boot and after every save/delete. */
export async function applyCredentialEnv(options: { strict?: boolean } = {}): Promise<boolean> {
  try {
    const { env, secrets, materializationError } = await readDecryptedEnv()
    const state = { staleChildSnapshot: false }
    // Drop vars we previously injected that are gone now (credential removed) —
    // but never touch a key the user exported in their own shell.
    for (const key of [...ownedKeys]) {
      if (key in env) continue
      state.staleChildSnapshot = true
      delete process.env[key]
      try {
        Env.remove(key)
      } catch {
        /* Instance state not initialized — process.env delete is enough */
      }
      ownedKeys.delete(key)
    }
    for (const [key, value] of Object.entries(env)) {
      if (process.env[key] && !ownedKeys.has(key)) continue
      if (ownedKeys.has(key) && process.env[key] !== value) state.staleChildSnapshot = true
      process.env[key] = value
      ownedKeys.add(key)
      try {
        Env.set(key, value)
      } catch {
        // Instance state not initialized yet — process.env alone is enough here.
      }
    }
    OpenScience.registerSecretValues(secrets)
    if (materializationError && options.strict) {
      throw new Error("Google Cloud credentials could not be materialized safely", { cause: materializationError })
    }
    return state.staleChildSnapshot
  } catch (error) {
    if (options.strict) throw error
    // best-effort; a broken store must not break boot or a save response
    return false
  }
}

const PORTABLE_CREDENTIAL_IDS = new Set(["aws", "gcp", "azure", "nvidia"])

export async function reconcileAccountCredentialFields(
  portable: Record<string, { fields: Record<string, string>; updated_at?: string | null }>,
): Promise<void> {
  const incoming = Object.fromEntries(Object.entries(portable).filter(([id]) => PORTABLE_CREDENTIAL_IDS.has(id)))
  await updateStore(async (current) => {
    for (const [id, entry] of Object.entries(current)) {
      if (!PORTABLE_CREDENTIAL_IDS.has(id) || entry.source !== "account" || id in incoming) continue
      delete current[id]
    }
    for (const [id, payload] of Object.entries(incoming)) {
      const existing = current[id]
      // A device-local override remains authoritative until its next save
      // successfully reaches the account. Account-owned entries follow the
      // dashboard across devices.
      if (existing?.source === "local") continue
      const spec = specFor(id)
      if (!spec) continue
      const allowed = new Set(spec.fields.map((field) => field.name))
      const fields: Record<string, string> = {}
      for (const [name, value] of Object.entries(payload.fields)) {
        if (!allowed.has(name) || !value.trim() || !validField(id, name, value)) continue
        fields[name] = await encrypt(value)
      }
      if (!Object.keys(fields).length) continue
      current[id] = {
        label: spec.label,
        fields,
        updated_at: payload.updated_at ?? new Date().toISOString(),
        source: "account",
      }
    }
  })
  await applyCredentialEnv({ strict: true })
}

const ServiceView = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  category: z.enum(["compute", "integration"]),
  custom: z.boolean(),
  fields: z.array(
    z.object({
      name: z.string(),
      label: z.string(),
      type: z.enum(["password", "text", "textarea"]),
      optional: z.boolean(),
      placeholder: z.string().optional(),
    }),
  ),
  connected: z.boolean(),
  set_fields: z.array(z.string()),
  updated_at: z.string().nullable(),
  source: z.enum(["local", "account"]).nullable(),
})

async function view(store: Store) {
  const seen = new Set<string>()
  const known = await Promise.all(
    CATALOG.map(async (spec) => {
      seen.add(spec.id)
      const entry = store[spec.id]
      const set = entry ? Object.keys(await validDecryptedFields(spec.id, entry)) : []
      const required = spec.fields.filter((field) => !field.optional).map((field) => field.name)
      return {
        id: spec.id,
        label: spec.label,
        description: spec.description,
        category: spec.category,
        custom: false,
        fields: spec.fields.map((f) => ({
          name: f.name,
          label: f.label,
          type: f.type,
          optional: !!f.optional,
          placeholder: f.placeholder,
        })),
        connected: required.length ? required.every((field) => set.includes(field)) : set.length > 0,
        set_fields: set,
        updated_at: entry?.updated_at ?? null,
        source: entry?.source ?? null,
      }
    }),
  )
  const custom = await Promise.all(
    Object.entries(store)
      .filter(([id]) => !seen.has(id))
      .map(async ([id, entry]) => {
        const names = Object.keys(await validDecryptedFields(id, entry))
        return {
          id,
          label: entry.label ?? id,
          description: "Custom credential.",
          category: "integration" as const,
          custom: true,
          fields: names.map((name) => ({ name, label: name, type: "password" as const, optional: false })),
          connected: names.length > 0,
          set_fields: names,
          updated_at: entry.updated_at,
          source: entry.source,
        }
      }),
  )
  return [...known, ...custom]
}

export const CredentialsRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List credential services",
        description: "List external-service credential slots and which fields are set (never values).",
        operationId: "settings.credentials.list",
        responses: {
          200: {
            description: "Services",
            content: { "application/json": { schema: resolver(z.object({ services: ServiceView.array() })) } },
          },
        },
      }),
      async (c) => c.json({ services: await view(await readStore()) }),
    )
    .put(
      "/:id",
      describeRoute({
        summary: "Save service credential",
        description: "Encrypt and persist one or more secret fields for a service. Empty values are ignored.",
        operationId: "settings.credentials.set",
        responses: {
          200: {
            description: "Services",
            content: { "application/json": { schema: resolver(z.object({ services: ServiceView.array() })) } },
          },
        },
      }),
      validator(
        "param",
        z.object({
          id: z
            .string()
            .min(1)
            .regex(/^[a-z0-9:_-]+$/i),
        }),
      ),
      validator(
        "json",
        z.object({
          label: z.string().optional(),
          fields: z.record(z.string(), z.string()),
        }),
      ),
      async (c) => {
        const id = c.req.valid("param").id
        const body = c.req.valid("json")
        const spec = specFor(id)
        const custom = id.startsWith("custom:")
        if (!spec && !/^custom:[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
          return c.json({ error: "Unknown credential service" }, 400)
        }
        const names = Object.keys(body.fields)
        if (custom && names.some((name) => !/^[a-z][a-z0-9_]{0,63}$/.test(name))) {
          return c.json({ error: "Custom credential field names must be valid environment fields" }, 400)
        }
        if (spec && names.some((name) => !spec.fields.some((field) => field.name === name))) {
          return c.json({ error: "Credential contains an unknown field" }, 400)
        }
        const gcp = body.fields.service_account_json?.trim()
        if (id === "gcp" && gcp && !validField(id, "service_account_json", gcp)) {
          return c.json({ error: "Google Cloud service account credentials must be a JSON object" }, 400)
        }
        const store = await mutateCredentialStore(id, `settings-credential.set:${id}`, () =>
          updateStore(async (current) => {
            const entry = current[id] ?? { fields: {}, updated_at: new Date().toISOString() }
            const fields = { ...entry.fields }
            for (const [name, value] of Object.entries(body.fields)) {
              const trimmed = value.trim()
              if (!trimmed) continue
              fields[name] = await encrypt(trimmed)
            }
            current[id] = {
              label: body.label ?? entry.label,
              fields,
              updated_at: new Date().toISOString(),
              source: "local",
            }
          }),
        )
        if (spec?.category === "compute" && spec.portable !== false) {
          const entry = store[id]
          const fields = entry ? await validDecryptedFields(id, entry) : {}
          const authenticated = await OpenScience.isAuthenticated()
          if (authenticated && !(await OpenScience.savePortableCredential(id, fields, spec.label))) {
            throw new Error(`${spec.label} was saved on this device but could not be synced to your account`)
          }
          if (authenticated && entry) {
            entry.source = "account"
            await updateStore((current) => {
              if (current[id]) current[id]!.source = "account"
            })
          }
        }
        return c.json({ services: await view(store) })
      },
    )
    .delete(
      "/:id",
      describeRoute({
        summary: "Remove service credential",
        description: "Delete all stored secrets for a service.",
        operationId: "settings.credentials.remove",
        responses: {
          200: {
            description: "Services",
            content: { "application/json": { schema: resolver(z.object({ services: ServiceView.array() })) } },
          },
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const id = c.req.valid("param").id
        const spec = specFor(id)
        if (spec?.category === "compute" && spec.portable !== false && (await OpenScience.isAuthenticated())) {
          if (!(await OpenScience.deletePortableCredential(id))) {
            return c.json({ error: `${spec.label} could not be removed from your account` }, 502)
          }
        }
        const store = await mutateCredentialStore(id, `settings-credential.remove:${id}`, () =>
          updateStore((current) => {
            delete current[id]
          }),
        )
        return c.json({ services: await view(store) })
      },
    ),
)

CredentialLifecycle.onRefresh(async () => {
  await applyCredentialEnv({ strict: true })
})

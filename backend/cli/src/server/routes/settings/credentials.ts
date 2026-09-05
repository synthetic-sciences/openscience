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
import { CredentialOverlay } from "@/credentials/overlay"
import { lazy } from "@synsci/util/lazy"
import { JsonStore } from "@/util/jsonstore"
import { SecretFile } from "@/util/secret-file"
import { SecretBox } from "@/util/secret-box"
import { WorkspaceCredentials } from "@/openscience/workspace-credentials"

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
}

// Known services and the shape of the secret each one needs. "Custom" entries
// (user-defined) are not listed here — they are stored ad-hoc with a single
// value field and surfaced back from the store.
const CATALOG: ServiceSpec[] = [
  {
    id: "aws",
    label: "AWS",
    description:
      "Credential-only bridge for AWS CLI/SDK skills such as S3 and Bedrock; OpenScience does not provide a first-party AWS job adapter.",
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
    description:
      "Credential-only bridge for Google Cloud CLI/SDK skills; OpenScience does not provide a first-party Google Cloud job adapter.",
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
    description: "Your Firecrawl API key for web and research search.",
    category: "integration",
    fields: [{ name: "api_key", label: "API key", type: "password", placeholder: "fc-…" }],
    trusted: true,
  },
  {
    id: "azure",
    label: "Microsoft Azure",
    description:
      "Credential-only bridge for Azure CLI/SDK skills; OpenScience does not provide a first-party Azure job adapter.",
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
    description: "NVIDIA-hosted science tools, including Boltz-2, DiffDock, and Evo 2.",
    category: "integration",
    fields: [{ name: "api_key", label: "API key", type: "password", placeholder: "nvapi-…" }],
    trusted: true,
  },
  {
    id: "nvidia_ngc",
    label: "NVIDIA NGC Registry",
    description:
      "Device-local registry credential for approved NVIDIA container pulls on an existing trusted adapter; it does not add an NVIDIA compute backend.",
    category: "compute",
    fields: [{ name: "api_key", label: "NGC API key", type: "password" }],
    trusted: true,
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
  organization_id: z.string().optional(),
  removal: z
    .object({
      token: z.string().uuid(),
      remote: z.boolean(),
      requested_at: z.string(),
    })
    .optional(),
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

function parseStore(data: Record<string, unknown>, strict = false): Store {
  const parsed = Store.safeParse(data)
  if (!parsed.success && strict) throw new Error("Saved service credentials could not be read")
  if (!parsed.success) return {}
  for (const [id, entry] of Object.entries(parsed.data)) {
    // Old dashboard copies are explicitly attributed but have no current
    // workspace grant. Never adopt them as permanent device-owned secrets.
    if (entry.source === "account") {
      delete parsed.data[id]
      continue
    }
    if (entry.removal) entry.removal.remote = false
  }
  return parsed.data
}

async function readStore(options: { strict?: boolean; service?: string } = {}): Promise<Store> {
  const local = parseStore(
    await JsonStore.read(storePath, options).catch((error) => {
      if (options.strict) throw new Error("Saved service credentials could not be read")
      throw error
    }),
    options.strict,
  )
  // A device-owned credential takes precedence and does not depend on whether
  // an unrelated workspace overlay is currently readable.
  if (options.service && local[options.service]) return local
  const workspace = await WorkspaceCredentials.read({ strict: options.strict })
  if (!workspace) return local
  for (const [id, values] of Object.entries(workspace.services)) {
    if (local[id]) continue
    const spec = specFor(id)
    if (!spec) continue
    const fields: Record<string, string> = {}
    for (const field of spec.fields) {
      const value = values[field.name]
      if (value && validField(id, field.name, value)) fields[field.name] = await encrypt(value)
    }
    if (Object.keys(fields).length)
      local[id] = {
        fields,
        source: "account",
        organization_id: workspace.organization_id,
        updated_at: new Date().toISOString(),
      }
  }
  return local
}

async function updateStore(fn: (store: Store) => void | Promise<void>): Promise<Store> {
  const result: { value?: Store } = {}
  await JsonStore.update(storePath, async (data) => {
    const store = parseStore(data)
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
  /** Env keys whose value came from an account-sourced (synced workspace)
   * entry, mapped to the workspace that granted it. */
  account: Map<string, string>
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
export async function resolveCredentialFields(
  id: string,
  options: { required?: string[] } = {},
): Promise<Record<string, string> | undefined> {
  const spec = specFor(id)
  if (!spec?.trusted) return
  const entry = (await readStore({ strict: options.required !== undefined, service: id }))[id]
  if (!entry || entry.removal) return
  const fields = await validDecryptedFields(id, entry)
  if (options.required?.some((name) => !fields[name]?.trim())) {
    throw new Error(
      `Your saved ${spec.label} credential could not be read. Reconnect it in Customize → Connectors; no other funding source was used.`,
    )
  }
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
  const account = new Map<string, string>()
  let gcp: string | undefined
  let materializationError: unknown
  for (const [id, entry] of Object.entries(store)) {
    if (entry.removal) continue
    const fields = await validDecryptedFields(id, entry)
    if (specFor(id)?.trusted) secrets.push(...Object.values(fields))
    if (id === "gcp") gcp = fields.service_account_json
    const mapped = mapServiceEnv(id, fields)
    const organization = entry.source === "account" ? entry.organization_id : undefined
    for (const [key, value] of Object.entries(mapped)) {
      env[key] = value
      if (organization) account.set(key, organization)
      else account.delete(key)
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
  return { env, secrets, account, materializationError }
}

// Env keys this module has set, so a re-apply after save can update our own
// values while still never clobbering an explicit shell export.
const ownedKeys = new Set<string>()

/** Decrypt stored service credentials and inject them into the process
 *  environment so the real consumers use them (see the module header). Explicit
 *  shell exports always win. Registers secret values for redaction. Best-effort;
 *  never throws. Call at boot and after every save/delete.
 *
 *  Account-sourced values are recorded in CredentialOverlay as they enter
 *  process.env and forgotten only when they actually leave it, so the
 *  subprocess env builder stamps a child with the overlay exactly when the
 *  child inherits one of these values. */
export async function applyCredentialEnv(options: { strict?: boolean } = {}): Promise<boolean> {
  try {
    const { env, secrets, account, materializationError } = await readDecryptedEnv()
    const state = { staleChildSnapshot: false }
    // Drop vars we previously injected that are gone now (credential removed) —
    // but never touch a key the user exported in their own shell.
    for (const key of [...ownedKeys]) {
      if (key in env) continue
      state.staleChildSnapshot = true
      delete process.env[key]
      CredentialOverlay.release(key)
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
      const organization = account.get(key)
      if (organization) CredentialOverlay.inject(key, value, organization)
      else CredentialOverlay.release(key)
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
  organization_id: z.string().nullable(),
})

async function view(store: Store) {
  const seen = new Set<string>()
  const known = await Promise.all(
    CATALOG.map(async (spec) => {
      seen.add(spec.id)
      const entry = store[spec.id]
      const active = entry && !entry.removal ? entry : undefined
      const set = active ? Object.keys(await validDecryptedFields(spec.id, active)) : []
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
        updated_at: active?.updated_at ?? null,
        source: active?.source ?? null,
        organization_id: active?.organization_id ?? null,
      }
    }),
  )
  const custom = await Promise.all(
    Object.entries(store)
      .filter(([id, entry]) => !seen.has(id) && !entry.removal)
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
          source: "local" as const,
          organization_id: null,
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
        await mutateCredentialStore(id, `settings-credential.set:${id}`, async () => {
          const stored = await updateStore(async (current) => {
            const entry = current[id] ?? { fields: {}, updated_at: new Date().toISOString() }
            if (entry.removal) {
              throw new Error(`Credential ${id} removal is pending; retry removal before reconnecting`)
            }
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
          })
          return stored
        })
        return c.json({ services: await view(await readStore()) })
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
        if ((await readStore())[id]?.source === "account") {
          return c.json({ error: "Manage this synced credential in your workspace on app.syntheticsciences.ai." }, 409)
        }
        const tombstoned = await mutateCredentialStore(id, `settings-credential.remove:${id}:tombstone`, () =>
          updateStore((current) => {
            const entry = current[id]
            if (entry?.removal) return
            if (!entry) return
            current[id] = {
              label: entry?.label ?? spec?.label,
              fields: {},
              updated_at: new Date().toISOString(),
              source: "local",
              removal: {
                token: crypto.randomUUID(),
                remote: false,
                requested_at: new Date().toISOString(),
              },
            }
          }),
        )
        const pending = tombstoned[id]?.removal
        if (!pending) return c.json({ services: await view(tombstoned) })
        await mutateCredentialStore(id, `settings-credential.remove:${id}:finalize`, () =>
          updateStore((current) => {
            if (current[id]?.removal?.token === pending.token) delete current[id]
          }),
        )
        return c.json({ services: await view(await readStore()) })
      },
    ),
)

CredentialLifecycle.onRefresh(async () => {
  await applyCredentialEnv({ strict: true })
})

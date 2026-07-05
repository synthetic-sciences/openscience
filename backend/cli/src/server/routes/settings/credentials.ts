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
 * which forwards non-managed env vars — every skill/bash subprocess (aws, gh,
 * gcloud, modal, …). It runs at CLI/server boot (index.ts middleware) and again
 * after each save/delete so changes apply live without a restart. Decrypted
 * secret values are registered for output redaction.
 */
import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import crypto from "crypto"
import path from "path"
import z from "zod"
import { Global } from "@/global"
import { Env } from "@/env"
import { OpenScience } from "@/openscience"
import { lazy } from "@/util/lazy"

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
  fields: FieldSpec[]
}

// Known services and the shape of the secret each one needs. "Custom" entries
// (user-defined) are not listed here — they are stored ad-hoc with a single
// value field and surfaced back from the store.
const CATALOG: ServiceSpec[] = [
  {
    id: "aws",
    label: "AWS",
    description: "Access key for S3, Bedrock, and other AWS services.",
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
    fields: [{ name: "token", label: "Access token", type: "password", placeholder: "ghp_… / github_pat_…" }],
  },
  {
    id: "gcp",
    label: "Google Cloud",
    description: "Service-account credentials for GCP APIs and storage.",
    fields: [
      { name: "project_id", label: "Project ID", type: "text", optional: true },
      { name: "service_account_json", label: "Service account JSON", type: "textarea", placeholder: "{ … }" },
    ],
  },
  {
    id: "literature",
    label: "Literature access",
    description: "API key for full-text scientific literature retrieval.",
    fields: [{ name: "api_key", label: "API key", type: "password" }],
  },
  {
    id: "azure",
    label: "Microsoft Azure",
    description: "Azure OpenAI / cognitive-services key and endpoint.",
    fields: [
      { name: "api_key", label: "API key", type: "password" },
      { name: "endpoint", label: "Endpoint", type: "text", optional: true, placeholder: "https://….openai.azure.com" },
    ],
  },
  {
    id: "modal",
    label: "Modal",
    description: "Token for running compute jobs on Modal.",
    fields: [
      { name: "token_id", label: "Token ID", type: "text", placeholder: "ak-…" },
      { name: "token_secret", label: "Token secret", type: "password", placeholder: "as-…" },
    ],
  },
  {
    id: "nvidia",
    label: "NVIDIA API",
    description: "API key for NVIDIA NIM / build.nvidia.com models.",
    fields: [{ name: "api_key", label: "API key", type: "password", placeholder: "nvapi-…" }],
  },
  {
    id: "openalex",
    label: "OpenAlex",
    description: "Polite-pool email (and optional key) for the OpenAlex API.",
    fields: [
      { name: "email", label: "Contact email", type: "text", placeholder: "you@example.com" },
      { name: "api_key", label: "API key", type: "password", optional: true },
    ],
  },
]

const StoreEntry = z.object({
  label: z.string().optional(),
  fields: z.record(z.string(), z.string()),
  updated_at: z.string(),
})
type StoreEntry = z.infer<typeof StoreEntry>
type Store = Record<string, StoreEntry>

const storePath = path.join(Global.Path.data, "credentials.json")
const keyPath = path.join(Global.Path.data, "credentials.key")

async function machineKey(): Promise<Buffer> {
  const existing = await Bun.file(keyPath)
    .arrayBuffer()
    .catch(() => undefined)
  if (existing && existing.byteLength === 32) return Buffer.from(existing)
  const key = crypto.randomBytes(32)
  await Bun.write(keyPath, key, { mode: 0o600 })
  return key
}

async function encrypt(plain: string): Promise<string> {
  const key = await machineKey()
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv)
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, enc]).toString("base64")
}

// Inverse of encrypt(): iv(12) | tag(16) | ciphertext. Throws on a bad key/tag,
// which callers treat as "unreadable field, skip it".
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

async function readStore(): Promise<Store> {
  const data = await Bun.file(storePath)
    .json()
    .catch(() => ({}) as Record<string, unknown>)
  return Object.entries(data).reduce((acc, [id, value]) => {
    const parsed = StoreEntry.safeParse(value)
    if (parsed.success) acc[id] = parsed.data
    return acc
  }, {} as Store)
}

async function writeStore(store: Store) {
  await Bun.write(storePath, JSON.stringify(store, null, 2), { mode: 0o600 })
}

function specFor(id: string): ServiceSpec | undefined {
  return CATALOG.find((s) => s.id === id)
}

// ── runtime env injection ───────────────────────────────────────────────────
// This is the ONLY thing that turns a stored credential into a working one.

/** Field names whose values are NOT secret (endpoints, regions, project ids,
 *  contact emails, file paths) — excluded from output redaction. */
const NON_SECRET_ENV = /(_ENDPOINT|_REGION|_PROJECT|_MAILTO)$|GOOGLE_APPLICATION_CREDENTIALS/

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
      put("AZURE_OPENAI_API_KEY", f.api_key)
      put("AZURE_API_KEY", f.api_key)
      put("AZURE_OPENAI_ENDPOINT", f.endpoint)
      return out
    case "modal":
      put("MODAL_TOKEN_ID", f.token_id)
      put("MODAL_TOKEN_SECRET", f.token_secret)
      return out
    case "nvidia":
      put("NVIDIA_API_KEY", f.api_key)
      return out
    case "openalex":
      put("OPENALEX_MAILTO", f.email)
      put("OPENALEX_API_KEY", f.api_key)
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
}

async function decryptFields(entry: StoreEntry): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const [name, cipher] of Object.entries(entry.fields)) {
    try {
      out[name] = await decrypt(cipher)
    } catch {
      // Unreadable (rotated key / corrupt) — skip; the UI still shows it "set".
    }
  }
  return out
}

/** Decrypt the whole store into canonical env vars + the list of secret-bearing
 *  values to redact. GCP service-account JSON is materialized to a 0600 file. */
async function readDecryptedEnv(): Promise<CredentialEnv> {
  const store = await readStore()
  const env: Record<string, string> = {}
  const secrets: string[] = []
  for (const [id, entry] of Object.entries(store)) {
    const fields = await decryptFields(entry)
    if (id === "gcp" && fields.service_account_json) {
      try {
        const file = path.join(Global.Path.data, "gcp-service-account.json")
        await Bun.write(file, fields.service_account_json, { mode: 0o600 })
        env.GOOGLE_APPLICATION_CREDENTIALS = file
      } catch {
        // couldn't write — skip ADC; other GCP vars still apply
      }
    }
    for (const [key, value] of Object.entries(mapServiceEnv(id, fields))) {
      env[key] = value
      if (!NON_SECRET_ENV.test(key)) secrets.push(value)
    }
  }
  return { env, secrets }
}

// Env keys this module has set, so a re-apply after save can update our own
// values while still never clobbering an explicit shell export.
const ownedKeys = new Set<string>()

/** Decrypt stored service credentials and inject them into the process
 *  environment so the real consumers use them (see the module header). Explicit
 *  shell exports always win. Registers secret values for redaction. Best-effort;
 *  never throws. Call at boot and after every save/delete. */
export async function applyCredentialEnv(): Promise<void> {
  try {
    const { env, secrets } = await readDecryptedEnv()
    // Drop vars we previously injected that are gone now (credential removed) —
    // but never touch a key the user exported in their own shell.
    for (const key of [...ownedKeys]) {
      if (key in env) continue
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
      process.env[key] = value
      ownedKeys.add(key)
      try {
        Env.set(key, value)
      } catch {
        // Instance state not initialized yet — process.env alone is enough here.
      }
    }
    OpenScience.registerSecretValues(secrets)
  } catch {
    // best-effort; a broken store must not break boot or a save response
  }
}

const ServiceView = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
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
})

function view(store: Store) {
  const seen = new Set<string>()
  const known = CATALOG.map((spec) => {
    seen.add(spec.id)
    const entry = store[spec.id]
    const set = entry ? Object.keys(entry.fields) : []
    return {
      id: spec.id,
      label: spec.label,
      description: spec.description,
      custom: false,
      fields: spec.fields.map((f) => ({
        name: f.name,
        label: f.label,
        type: f.type,
        optional: !!f.optional,
        placeholder: f.placeholder,
      })),
      connected: set.length > 0,
      set_fields: set,
      updated_at: entry?.updated_at ?? null,
    }
  })
  const custom = Object.entries(store)
    .filter(([id]) => !seen.has(id))
    .map(([id, entry]) => {
      const names = Object.keys(entry.fields)
      return {
        id,
        label: entry.label ?? id,
        description: "Custom credential.",
        custom: true,
        fields: names.map((name) => ({ name, label: name, type: "password" as const, optional: false })),
        connected: names.length > 0,
        set_fields: names,
        updated_at: entry.updated_at,
      }
    })
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
      async (c) => c.json({ services: view(await readStore()) }),
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
        const store = await readStore()
        const spec = specFor(id)
        const current = store[id] ?? { fields: {}, updated_at: new Date().toISOString() }
        const fields = { ...current.fields }
        for (const [name, value] of Object.entries(body.fields)) {
          const trimmed = value.trim()
          if (!trimmed) continue
          if (spec && !spec.fields.some((f) => f.name === name)) continue
          fields[name] = await encrypt(trimmed)
        }
        store[id] = {
          label: body.label ?? current.label,
          fields,
          updated_at: new Date().toISOString(),
        }
        await writeStore(store)
        await applyCredentialEnv() // apply the new secret to the running process
        return c.json({ services: view(store) })
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
        const store = await readStore()
        delete store[c.req.valid("param").id]
        await writeStore(store)
        await applyCredentialEnv() // re-sync process env after removal
        return c.json({ services: view(store) })
      },
    ),
)

import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import crypto from "crypto"
import path from "path"
import fs from "fs/promises"
import { Global } from "../../../global"
import { errors } from "../../error"
import { lazy } from "../../../util/lazy"

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
//   • SSH hosts the agent can dispatch runs to.
//   • Model endpoints (local or remote inference URLs).

export namespace ComputeSettings {
  const storePath = path.join(Global.Path.data, "settings-compute.json")
  const keyPath = path.join(Global.Path.data, "compute.key")

  // ── Encryption (AES-256-GCM, machine-local key) ──
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
    { id: "prime", name: "Prime Intellect", verified: false, placeholder: "pi-…", hint: "Decentralized GPU marketplace." },
    { id: "vast", name: "Vast.ai", verified: false, placeholder: "vast api key", hint: "Spot GPU marketplace." },
    { id: "runpod", name: "RunPod", verified: false, placeholder: "rpa_…", hint: "Community & secure GPU cloud." },
  ]

  // ── Schemas ──
  export const SshHost = z.object({
    id: z.string(),
    label: z.string(),
    host: z.string(),
    user: z.string().optional(),
    port: z.number().int().positive().optional(),
  })
  export type SshHost = z.infer<typeof SshHost>

  export const Endpoint = z.object({
    id: z.string(),
    label: z.string(),
    url: z.string(),
    kind: z.enum(["local", "remote"]),
  })
  export type Endpoint = z.infer<typeof Endpoint>

  export const Provider = z.object({
    id: z.string(),
    name: z.string(),
    verified: z.boolean(),
    placeholder: z.string(),
    hint: z.string(),
    connected: z.boolean(),
    connected_at: z.string().nullable(),
    last_used: z.string().nullable(),
  })
  export type Provider = z.infer<typeof Provider>

  export const Info = z.object({
    providers: Provider.array().default([]),
    ssh_hosts: SshHost.array().default([]),
    endpoints: Endpoint.array().default([]),
  })
  export type Info = z.infer<typeof Info>

  // ── On-disk shape (secrets live here only) ──
  const StoredProvider = z.object({
    key: z.string(),
    connected_at: z.string(),
    last_used: z.string().nullable().default(null),
  })
  const Stored = z.object({
    providers: z.record(z.string(), StoredProvider).default({}),
    ssh_hosts: SshHost.array().default([]),
    endpoints: Endpoint.array().default([]),
  })
  type Stored = z.infer<typeof Stored>

  const EMPTY: Stored = { providers: {}, ssh_hosts: [], endpoints: [] }

  async function read(): Promise<Stored> {
    const parsed = await Bun.file(storePath)
      .json()
      .catch(() => null)
    if (!parsed) return structuredClone(EMPTY)
    const result = Stored.safeParse(parsed)
    return result.success ? result.data : structuredClone(EMPTY)
  }

  async function write(next: Stored) {
    await fs.mkdir(Global.Path.data, { recursive: true })
    await Bun.write(storePath, JSON.stringify(next, null, 2), { mode: 0o600 })
  }

  function id() {
    return crypto.randomUUID().slice(0, 8)
  }

  // Build the client-facing view — never includes the encrypted key.
  function view(stored: Stored): Info {
    const providers = CATALOG.map((spec) => {
      const entry = stored.providers[spec.id]
      return {
        id: spec.id,
        name: spec.name,
        verified: spec.verified,
        placeholder: spec.placeholder,
        hint: spec.hint,
        connected: !!entry,
        connected_at: entry?.connected_at ?? null,
        last_used: entry?.last_used ?? null,
      }
    })
    return { providers, ssh_hosts: stored.ssh_hosts, endpoints: stored.endpoints }
  }

  export async function get(): Promise<Info> {
    return view(await read())
  }

  export function isProvider(target: string): boolean {
    return CATALOG.some((s) => s.id === target)
  }

  export async function connectProvider(target: string, key: string): Promise<Info> {
    const stored = await read()
    const existing = stored.providers[target]
    stored.providers[target] = {
      key: await encrypt(key),
      connected_at: existing?.connected_at ?? new Date().toISOString(),
      last_used: existing?.last_used ?? null,
    }
    await write(stored)
    return view(stored)
  }

  export async function disconnectProvider(target: string): Promise<Info> {
    const stored = await read()
    delete stored.providers[target]
    await write(stored)
    return view(stored)
  }

  export async function addSshHost(input: Omit<SshHost, "id">): Promise<Info> {
    const stored = await read()
    stored.ssh_hosts.push({ id: id(), ...input })
    await write(stored)
    return view(stored)
  }

  export async function removeSshHost(target: string): Promise<Info> {
    const stored = await read()
    stored.ssh_hosts = stored.ssh_hosts.filter((h) => h.id !== target)
    await write(stored)
    return view(stored)
  }

  export async function addEndpoint(input: Omit<Endpoint, "id">): Promise<Info> {
    const stored = await read()
    stored.endpoints.push({ id: id(), ...input })
    await write(stored)
    return view(stored)
  }

  export async function removeEndpoint(target: string): Promise<Info> {
    const stored = await read()
    stored.endpoints = stored.endpoints.filter((e) => e.id !== target)
    await write(stored)
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
      async (c) => c.json(await ComputeSettings.disconnectProvider(c.req.valid("param").id)),
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
        z.object({
          label: z.string().min(1),
          host: z.string().min(1),
          user: z.string().optional(),
          port: z.number().int().positive().optional(),
        }),
      ),
      async (c) => c.json(await ComputeSettings.addSshHost(c.req.valid("json"))),
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
    .post(
      "/endpoint",
      describeRoute({
        summary: "Add model endpoint",
        operationId: "settings.compute.endpoint.add",
        responses: {
          200: { description: "Updated", content: { "application/json": { schema: resolver(ComputeSettings.Info) } } },
          ...errors(400),
        },
      }),
      validator(
        "json",
        z.object({
          label: z.string().min(1),
          url: z.string().min(1),
          kind: z.enum(["local", "remote"]),
        }),
      ),
      async (c) => c.json(await ComputeSettings.addEndpoint(c.req.valid("json"))),
    )
    .delete(
      "/endpoint/:id",
      describeRoute({
        summary: "Remove model endpoint",
        operationId: "settings.compute.endpoint.remove",
        responses: {
          200: { description: "Updated", content: { "application/json": { schema: resolver(ComputeSettings.Info) } } },
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => c.json(await ComputeSettings.removeEndpoint(c.req.valid("param").id)),
    ),
)

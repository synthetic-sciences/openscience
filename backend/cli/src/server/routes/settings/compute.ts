import { Hono, type Context } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import z from "zod"
import crypto from "crypto"
import path from "path"
import os from "os"
import fs from "fs/promises"
import { Global } from "../../../global"
import { errors } from "../../error"
import { lazy } from "../../../util/lazy"
import { ComputeJobs } from "../../../compute/jobs"
import { Instance } from "../../../project/instance"
import { InstanceBootstrap } from "../../../project/bootstrap"
import { HTTPException } from "hono/http-exception"
import { projectSelection } from "../../project-selection"
import { Project } from "../../../project/project"
import { JsonStore } from "../../../util/jsonstore"
import { SecretFile } from "../../../util/secret-file"
import { OpenScience } from "../../../openscience"
import { ModalAdapter } from "../../../compute/modal/adapter"
import { ModalPlan } from "../../../compute/modal/plan"
import { ModalVolume } from "../../../compute/modal/volume"
import { Env } from "../../../env"

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
//   • Legacy SSH host profiles retained for migration. Public dispatch stays
//     unavailable until the full remote lifecycle is verified end to end.
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
      id: "prime",
      name: "Prime Intellect",
      verified: false,
      placeholder: "pi-…",
      hint: "Decentralized GPU marketplace.",
    },
    { id: "vast", name: "Vast.ai", verified: false, placeholder: "vast api key", hint: "Spot GPU marketplace." },
    { id: "runpod", name: "RunPod", verified: false, placeholder: "rpa_…", hint: "Community & secure GPU cloud." },
  ]

  // ── Schemas ──
  export const SshHost = ComputeJobs.Host
  export type SshHost = z.infer<typeof SshHost>

  export const Provider = z.object({
    id: z.string(),
    name: z.string(),
    verified: z.boolean(),
    placeholder: z.string(),
    hint: z.string(),
    connected: z.boolean(),
    enabled: z.boolean(),
    source: z.enum(["stored", "modal_toml"]).nullable(),
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
  })
  export type ModalFile = z.infer<typeof ModalFile>

  export const Info = z.object({
    providers: Provider.array().default([]),
    ssh_hosts: SshHost.array().default([]),
    modal: Modal.default(() => Modal.parse({})),
    modal_file: ModalFile,
  })
  export type Info = z.infer<typeof Info>

  // ── On-disk shape (secrets live here only) ──
  const StoredProvider = z.object({
    key: z.string().optional(),
    source: z.enum(["stored", "modal_toml"]).default("stored"),
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
      })
      .passthrough(),
  )

  function parseStored(value: unknown): Stored {
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
    prime: ["PRIME_API_KEY", "PRIME_INTELLECT_API_KEY"],
    vast: ["VAST_API_KEY"],
    runpod: ["RUNPOD_API_KEY"],
  }
  const owned = new Map<string, string>()

  /** Map one provider's decrypted key to the canonical env var names its real
   *  consumers read. Modal's combined "token_id : token_secret" key is split;
   *  a half-pasted modal key maps to nothing (both vars are required). */
  function mapProviderEnv(target: string, key: string): Record<string, string> {
    if (target === "modal") {
      const [token, secret] = key.split(":").map((part) => part.trim())
      if (!token || !secret) return {}
      return { MODAL_TOKEN_ID: token, MODAL_TOKEN_SECRET: secret }
    }
    return Object.fromEntries((PROVIDER_ENV[target] ?? []).map((name) => [name, key]))
  }

  async function readModal(filepath = path.join(os.homedir(), ".modal.toml")) {
    const info = await fs.stat(filepath).catch(() => undefined)
    if (!info?.isFile()) return { found: false, token: undefined, secret: undefined }
    const text = await Bun.file(filepath)
      .text()
      .catch(() => undefined)
    if (!text) return { found: true, token: undefined, secret: undefined }
    const value = await Promise.resolve()
      .then(() => Bun.TOML.parse(text))
      .catch(() => undefined)
    const parsed = ModalProfiles.safeParse(value)
    if (!parsed.success) return { found: true, token: undefined, secret: undefined }
    const profile = Object.values(parsed.data).find((item) => item.active)
    return {
      found: true,
      token: profile?.token_id?.trim() || undefined,
      secret: profile?.token_secret?.trim() || undefined,
    }
  }

  export async function modalFile(filepath?: string): Promise<ModalFile> {
    const target = filepath ?? path.join(os.homedir(), ".modal.toml")
    const info = await fs.stat(target).catch(() => undefined)
    const found = info?.isFile() ?? false
    return { found, ready: found }
  }

  export async function providerEnv(target: string): Promise<Record<string, string>> {
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

  // Build the client-facing view — never includes the encrypted key.
  async function view(stored: Stored, file = modalFile()): Promise<Info> {
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
    return { providers, ssh_hosts: stored.ssh_hosts, modal: stored.modal, modal_file: await file }
  }

  export async function get(): Promise<Info> {
    return view(await read())
  }

  export function isProvider(target: string): boolean {
    return CATALOG.some((s) => s.id === target)
  }

  export async function connectProvider(target: string, key: string): Promise<Info> {
    const stored = await update(async (current) => {
      const existing = current.providers[target]
      current.providers[target] = {
        key: await encrypt(key),
        source: "stored",
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
    if (!file.found) throw new HTTPException(400, { message: "Modal config was not found at ~/.modal.toml." })
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
    const stored = await update((current) => {
      delete current.providers[target]
    })
    await applyComputeEnv()
    return view(stored)
  }

  export async function setProviderEnabled(target: string, enabled: boolean): Promise<Info> {
    const stored = await update((current) => {
      const entry = current.providers[target]
      if (!entry) throw new Error(`Compute provider ${target} is not connected`)
      entry.enabled = enabled
    })
    await applyComputeEnv()
    return view(stored)
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
    if (!stored.providers.modal?.enabled) throw new Error("Compute provider modal is disabled")
    return {
      app: stored.modal.app,
      image: stored.modal.image,
      environment: undefined,
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

  export async function addSshHost(input: Omit<SshHost, "id">): Promise<Info> {
    const stored = await update((current) => {
      current.ssh_hosts.push({ id: id(), ...input })
    })
    return view(stored)
  }

  export async function removeSshHost(target: string): Promise<Info> {
    const stored = await update((current) => {
      current.ssh_hosts = current.ssh_hosts.filter((h) => h.id !== target)
    })
    return view(stored)
  }

  export async function findSshHost(target: string): Promise<SshHost | undefined> {
    return (await read()).ssh_hosts.find((host) => host.id === target)
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
        if (entry.size > 256 * 1024 * 1024) {
          throw new HTTPException(400, { message: "Modal Volume browser downloads are limited to 256 MB." })
        }
        const staging = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-modal-volume-"))
        const bytes = await ModalVolume.download(context, input.name, [entry.path], staging)
          .then((files) => {
            const file = files[0]
            if (!file) throw new Error(`Modal Volume did not download ${entry.path}`)
            return Bun.file(file.staging).arrayBuffer()
          })
          .finally(() => fs.rm(staging, { recursive: true, force: true }))
        const filename = path.posix.basename(entry.path).replaceAll('"', "") || "download"
        return new Response(bytes, {
          headers: {
            "content-type": "application/octet-stream",
            "content-disposition": `attachment; filename="${filename}"`,
          },
        })
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
        z.object({
          label: z.string().min(1),
          host: z.string().min(1),
          user: z.string().optional(),
          port: z.number().int().positive().optional(),
          scheduler: ComputeJobs.Scheduler.default("none"),
          workdir: z.string().optional(),
        }),
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
            content: { "application/json": { schema: resolver(ComputeJobs.Probe) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      async (c) => {
        const host = await ComputeSettings.findSshHost(c.req.valid("param").id)
        if (!host) return c.json({ error: "SSH host not found" }, 404)
        return c.json(await ComputeJobs.probe(host))
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
            content: { "application/json": { schema: resolver(ComputeJobs.Job.array()) } },
          },
        },
      }),
      validator("query", Directory),
      async (c) =>
        project(c, async () => {
          const settings = await ComputeSettings.get()
          const provider = settings.providers.find((item) => item.id === "modal")
          const resolveCredentials = provider?.enabled ? ComputeSettings.modalResolver() : undefined
          return c.json(await ComputeJobs.list({ resolveCredentials }))
        }),
    )
    .post(
      "/jobs/plan",
      describeRoute({
        summary: "Prepare an exact Modal run plan for approval",
        operationId: "settings.compute.jobs.plan",
        responses: {
          200: {
            description: "Modal run plan",
            content: { "application/json": { schema: resolver(ModalPlan.Schema) } },
          },
          ...errors(400, 409),
        },
      }),
      validator("query", Directory),
      validator("json", ComputeJobs.Request),
      async (c) => {
        return project(c, async () => {
          const input = c.req.valid("json")
          return c.json(await ComputeJobs.plan(input, { modal: await ComputeSettings.modalConfig() }))
        })
      },
    )
    .post(
      "/jobs",
      describeRoute({
        summary: "Start a local compute job",
        operationId: "settings.compute.jobs.start",
        responses: {
          200: { description: "Started job", content: { "application/json": { schema: resolver(ComputeJobs.Job) } } },
          ...errors(400, 409),
        },
      }),
      validator("query", Directory),
      validator("json", ComputeJobs.Request),
      async (c) => {
        return project(c, async () => {
          const input = c.req.valid("json")
          if (input.target.kind === "ssh") {
            return c.json(
              {
                error: "remote_compute_unavailable",
                message:
                  "SSH dispatch is unavailable until staged inputs, durable remote IDs, reattachment, cancellation, logs, and outputs pass real-host validation.",
              },
              409,
            )
          }
          const modal = input.target.kind === "modal" ? await ComputeSettings.modalConfig() : undefined
          const resolveCredentials = input.target.kind === "modal" ? ComputeSettings.modalResolver() : undefined
          return c.json(await ComputeJobs.start(input, { modal, resolveCredentials }))
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
          return c.json({ cleared: await ComputeJobs.clear() })
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
          const job = await ComputeJobs.get(c.req.valid("param").id)
          if (!job) return c.json({ error: "Compute job not found" }, 404)
          return c.json({ log: await ComputeJobs.log(job.id) })
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
          const job = await ComputeJobs.get(c.req.valid("param").id)
          if (!job) return c.json({ error: "Compute job not found" }, 404)
          return c.json({ events: await ComputeJobs.events(job.id) })
        })
      },
    )
    .post(
      "/jobs/:id/retry",
      describeRoute({
        summary: "Retry delivery from a retained Modal resource",
        operationId: "settings.compute.jobs.retry",
        responses: {
          200: {
            description: "Recovery started",
            content: { "application/json": { schema: resolver(ComputeJobs.Job) } },
          },
          ...errors(400, 404, 409),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      validator("query", Directory),
      async (c) => {
        return project(c, async () => {
          const job = await ComputeJobs.get(c.req.valid("param").id)
          if (!job) return c.json({ error: "Compute job not found" }, 404)
          return c.json(await ComputeJobs.retry(job.id, { resolveCredentials: ComputeSettings.modalResolver() }))
        })
      },
    )
    .post(
      "/jobs/:id/cancel",
      describeRoute({
        summary: "Cancel a compute job",
        operationId: "settings.compute.jobs.cancel",
        responses: {
          200: { description: "Cancelled job", content: { "application/json": { schema: resolver(ComputeJobs.Job) } } },
          ...errors(404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      validator("query", Directory),
      async (c) => {
        return project(c, async () => {
          const settings = await ComputeSettings.get()
          const job = await ComputeJobs.get(c.req.valid("param").id)
          if (!job) return c.json({ error: "Compute job not found" }, 404)
          const provider = settings.providers.find((item) => item.id === "modal")
          const resolveCredentials =
            job.target.kind === "modal" && provider?.enabled ? ComputeSettings.modalResolver() : undefined
          return c.json(await ComputeJobs.cancel(job.id, { hosts: settings.ssh_hosts, resolveCredentials }))
        })
      },
    ),
)

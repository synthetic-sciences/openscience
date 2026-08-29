/** Local storage usage plus verified live relocation/reset. */
import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { Global } from "@/global"
import { DataRelocation } from "@/global/data-relocation"
import { lazy } from "@/util/lazy"

const pointerPath = path.join(Global.Path.config, "data-location")

function allocatedBytes(stat: Awaited<ReturnType<typeof fs.stat>>) {
  const blocks = Number(stat.blocks)
  const allocated = blocks * 512
  // A sparse file can legitimately occupy zero blocks while exposing a large
  // logical size. Disk usage must report the allocated bytes, including zero.
  if (Number.isSafeInteger(blocks) && blocks >= 0 && Number.isSafeInteger(allocated)) return allocated
  const size = Number(stat.size)
  return Number.isSafeInteger(size) && size >= 0 ? size : 0
}

function missing(error: unknown) {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT"
}

async function optional<T>(operation: Promise<T>): Promise<T | undefined> {
  return operation.catch((error) => {
    if (missing(error)) return undefined
    throw error
  })
}

async function dirSize(target: string, seen: Set<string>): Promise<number> {
  const entries = (await optional(fs.readdir(target, { withFileTypes: true }))) ?? []
  const directories: string[] = []
  const files: string[] = []
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue
    const full = path.join(target, entry.name)
    if (entry.isDirectory()) directories.push(full)
    else files.push(full)
  }

  let bytes = 0
  for (let index = 0; index < files.length; index += 64) {
    const sizes = await Promise.all(
      files.slice(index, index + 64).map(async (file) => {
        const stat = await optional(fs.stat(file))
        if (!stat?.isFile()) return 0
        const identity = `${stat.dev}:${stat.ino}`
        if (seen.has(identity)) return 0
        seen.add(identity)
        return allocatedBytes(stat)
      }),
    )
    bytes += sizes.reduce((sum, size) => sum + size, 0)
  }
  for (const directory of directories) bytes += await dirSize(directory, seen)
  return bytes
}

const Relocation = z.object({
  id: z.string().optional(),
  phase: z.enum(["copying", "ready", "publishing", "published", "switched", "recovery_required"]),
  source: z.string().optional(),
  target: z.string().optional(),
  started_at: z.string().optional(),
  updated_at: z.string().optional(),
  active: z.boolean().optional(),
  error: z.string().optional(),
})

const Usage = z.object({
  data_dir: z.string(),
  managed: z.boolean(),
  config_dir: z.string(),
  cache_dir: z.string(),
  state_dir: z.string(),
  pointer: z.string().nullable(),
  total_bytes: z.number(),
  scanning: z.boolean(),
  updated_at: z.string().nullable(),
  scan_error: z.string().nullable(),
  relocation: Relocation.nullable(),
  entries: z.array(z.object({ name: z.string(), path: z.string(), bytes: z.number(), kind: z.enum(["dir", "file"]) })),
})

type UsageEntry = z.infer<typeof Usage>["entries"][number]
type ScanResult = { total_bytes: number; entries: UsageEntry[]; updated_at: string }
const usageScan: {
  dataDir?: string
  value?: ScanResult
  promise?: Promise<void>
  error?: string
  errorAt?: number
} = {}

async function scanUsage(dataDir: string): Promise<ScanResult> {
  const dirents = await fs.readdir(dataDir, { withFileTypes: true })
  const entries: UsageEntry[] = []
  const seen = new Set<string>()
  for (const entry of dirents
    .filter((item) => !item.isSymbolicLink())
    .toSorted((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dataDir, entry.name)
    const stat = entry.isDirectory() ? undefined : await optional(fs.stat(full))
    const identity = stat?.isFile() ? `${stat.dev}:${stat.ino}` : undefined
    const bytes = entry.isDirectory()
      ? await dirSize(full, seen)
      : !stat?.isFile() || (identity && seen.has(identity))
        ? 0
        : allocatedBytes(stat)
    if (identity) seen.add(identity)
    entries.push({
      name: entry.name,
      path: full,
      bytes,
      kind: entry.isDirectory() ? "dir" : "file",
    })
  }
  entries.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name))
  return {
    total_bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
    entries,
    updated_at: new Date().toISOString(),
  }
}

function refreshUsage(dataDir: string, refresh = false) {
  if (usageScan.dataDir !== dataDir) {
    usageScan.dataDir = dataDir
    usageScan.value = undefined
    usageScan.promise = undefined
    usageScan.error = undefined
    usageScan.errorAt = undefined
  }
  const fresh = usageScan.value && Date.now() - Date.parse(usageScan.value.updated_at) < 30_000
  const recentError = usageScan.errorAt !== undefined && Date.now() - usageScan.errorAt < 30_000
  if (usageScan.promise) return
  if (!refresh && (fresh || recentError)) return
  if (refresh) {
    usageScan.error = undefined
    usageScan.errorAt = undefined
  }
  usageScan.promise = scanUsage(dataDir)
    .then((value) => {
      if (usageScan.dataDir !== dataDir) return
      usageScan.value = value
      usageScan.error = undefined
      usageScan.errorAt = undefined
    })
    .catch((error) => {
      if (usageScan.dataDir !== dataDir) return
      usageScan.error = message(error)
      usageScan.errorAt = Date.now()
    })
    .finally(() => {
      if (usageScan.dataDir === dataDir) usageScan.promise = undefined
    })
}

const Moved = z.object({
  ok: z.literal(true),
  source: z.string(),
  target: z.string(),
  files: z.number().int().nonnegative(),
  bytes: z.number().int().nonnegative(),
  backup: z.string().optional(),
  warning: z.string().optional(),
})

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export const StorageRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get storage usage",
        description:
          "Real on-disk sizes for the active OpenScience data directory and its top-level entries. Pass refresh=1 to bypass the result and error retry TTL.",
        operationId: "settings.storage.usage",
        responses: { 200: { description: "Usage", content: { "application/json": { schema: resolver(Usage) } } } },
      }),
      validator("query", z.object({ refresh: z.literal("1").optional() })),
      async (c) => {
        const dataDir = await fs.realpath(Global.Path.data)
        refreshUsage(dataDir, c.req.valid("query").refresh === "1")
        const [pointer, relocation] = await Promise.all([
          Bun.file(pointerPath)
            .text()
            .then((text) => text.trim() || null)
            .catch(() => null),
          DataRelocation.state().then((value) => value ?? null),
        ])
        return c.json({
          data_dir: dataDir,
          managed: Global.Path.dataManaged,
          config_dir: Global.Path.config,
          cache_dir: Global.Path.cache,
          state_dir: Global.Path.state,
          pointer,
          total_bytes: usageScan.value?.total_bytes ?? 0,
          entries: usageScan.value?.entries ?? [],
          scanning: Boolean(usageScan.promise),
          updated_at: usageScan.value?.updated_at ?? null,
          scan_error: usageScan.error ?? null,
          relocation,
        })
      },
    )
    .post(
      "/location",
      describeRoute({
        summary: "Change data location",
        description:
          "Take a verified snapshot, drain active writers, atomically switch every running OpenScience process, and retain the source as a safety copy.",
        operationId: "settings.storage.relocate",
        responses: {
          200: { description: "Relocated", content: { "application/json": { schema: resolver(Moved) } } },
          409: { description: "Relocation could not be completed safely" },
        },
      }),
      validator("json", z.object({ path: z.string().min(1) })),
      async (c) => {
        const raw = c.req.valid("json").path
        if (!path.isAbsolute(raw.replace(/^~(?=$|\/)/, Global.Path.home))) {
          return c.json({ error: "Path must be absolute", code: "invalid_storage_location" }, 400)
        }
        try {
          return c.json({ ok: true as const, ...(await DataRelocation.relocate(raw)) })
        } catch (error) {
          return c.json({ error: message(error), code: "storage_relocation_failed" }, 409)
        }
      },
    )
    .delete(
      "/location",
      describeRoute({
        summary: "Reset data location",
        description:
          "Reverse-migrate the active data into ~/.openscience, atomically switch every running process, and preserve the previous default as a timestamped backup.",
        operationId: "settings.storage.resetLocation",
        responses: {
          200: { description: "Reset", content: { "application/json": { schema: resolver(Moved) } } },
          409: { description: "Reset could not be completed safely" },
        },
      }),
      async (c) => {
        try {
          return c.json({ ok: true as const, ...(await DataRelocation.reset()) })
        } catch (error) {
          return c.json({ error: message(error), code: "storage_reset_failed" }, 409)
        }
      },
    ),
)

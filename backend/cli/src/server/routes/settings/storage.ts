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

async function dirSize(target: string): Promise<number> {
  const entries = await fs.readdir(target, { withFileTypes: true }).catch(() => [])
  const sizes = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isSymbolicLink()) return 0
      const full = path.join(target, entry.name)
      if (entry.isDirectory()) return dirSize(full)
      return (await fs.stat(full).catch(() => undefined))?.size ?? 0
    }),
  )
  return sizes.reduce((sum, size) => sum + size, 0)
}

const Usage = z.object({
  data_dir: z.string(),
  managed: z.boolean(),
  config_dir: z.string(),
  cache_dir: z.string(),
  state_dir: z.string(),
  pointer: z.string().nullable(),
  total_bytes: z.number(),
  entries: z.array(z.object({ name: z.string(), path: z.string(), bytes: z.number(), kind: z.enum(["dir", "file"]) })),
})

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
        description: "Real on-disk sizes for the active OpenScience data directory and its top-level entries.",
        operationId: "settings.storage.usage",
        responses: { 200: { description: "Usage", content: { "application/json": { schema: resolver(Usage) } } } },
      }),
      async (c) => {
        const dataDir = await fs.realpath(Global.Path.data)
        const dirents = await fs.readdir(dataDir, { withFileTypes: true }).catch(() => [])
        const entries = await Promise.all(
          dirents
            .filter((entry) => !entry.isSymbolicLink())
            .map(async (entry) => {
              const full = path.join(dataDir, entry.name)
              const bytes = entry.isDirectory()
                ? await dirSize(full)
                : ((await fs.stat(full).catch(() => undefined))?.size ?? 0)
              return {
                name: entry.name,
                path: full,
                bytes,
                kind: entry.isDirectory() ? ("dir" as const) : ("file" as const),
              }
            }),
        )
        entries.sort((a, b) => b.bytes - a.bytes)
        const pointer = await Bun.file(pointerPath)
          .text()
          .then((text) => text.trim() || null)
          .catch(() => null)
        return c.json({
          data_dir: dataDir,
          managed: Global.Path.dataManaged,
          config_dir: Global.Path.config,
          cache_dir: Global.Path.cache,
          state_dir: Global.Path.state,
          pointer,
          total_bytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
          entries,
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

/**
 * Local storage inspector (settings ▸ Storage). Reports the real on-disk
 * footprint of Open Science's data directory (and the config/cache/state
 * siblings), plus a supported "change data location" operation.
 *
 * Change-location is a genuine move: it copies the current data directory to
 * the chosen target and writes a pointer file (config/data-location) that
 * `Global` honours on the next launch — so it takes effect after a restart.
 * The original directory is left in place as a safety copy.
 */
import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import fs from "fs/promises"
import path from "path"
import z from "zod"
import { Global } from "@/global"
import { lazy } from "@/util/lazy"

const pointerPath = path.join(Global.Path.config, "data-location")

async function dirSize(target: string): Promise<number> {
  let total = 0
  const stack: string[] = [target]
  while (stack.length) {
    const dir = stack.pop()!
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      const stat = await fs.stat(full).catch(() => undefined)
      if (stat) total += stat.size
    }
  }
  return total
}

const Usage = z.object({
  data_dir: z.string(),
  config_dir: z.string(),
  cache_dir: z.string(),
  state_dir: z.string(),
  pointer: z.string().nullable(),
  total_bytes: z.number(),
  entries: z.array(z.object({ name: z.string(), path: z.string(), bytes: z.number(), kind: z.enum(["dir", "file"]) })),
})

export const StorageRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get storage usage",
        description: "Real on-disk sizes for the OpenScience data directory and its top-level entries.",
        operationId: "settings.storage.usage",
        responses: {
          200: {
            description: "Usage",
            content: { "application/json": { schema: resolver(Usage) } },
          },
        },
      }),
      async (c) => {
        const dataDir = Global.Path.data
        const dirents = await fs.readdir(dataDir, { withFileTypes: true }).catch(() => [])
        const entries = await Promise.all(
          dirents
            .filter((e) => !e.isSymbolicLink())
            .map(async (e) => {
              const full = path.join(dataDir, e.name)
              const bytes = e.isDirectory()
                ? await dirSize(full)
                : ((await fs.stat(full).catch(() => undefined))?.size ?? 0)
              return { name: e.name, path: full, bytes, kind: e.isDirectory() ? ("dir" as const) : ("file" as const) }
            }),
        )
        entries.sort((a, b) => b.bytes - a.bytes)
        const pointer = await Bun.file(pointerPath)
          .text()
          .then((t) => t.trim() || null)
          .catch(() => null)
        return c.json({
          data_dir: dataDir,
          config_dir: Global.Path.config,
          cache_dir: Global.Path.cache,
          state_dir: Global.Path.state,
          pointer,
          total_bytes: entries.reduce((sum, e) => sum + e.bytes, 0),
          entries,
        })
      },
    )
    .post(
      "/location",
      describeRoute({
        summary: "Change data location",
        description:
          "Copy the data directory to a new absolute path and record a pointer honoured on next launch. Requires restart.",
        operationId: "settings.storage.relocate",
        responses: {
          200: {
            description: "Relocated",
            content: {
              "application/json": {
                schema: resolver(z.object({ ok: z.boolean(), target: z.string(), restart_required: z.boolean() })),
              },
            },
          },
        },
      }),
      validator("json", z.object({ path: z.string().min(1) })),
      async (c) => {
        const raw = c.req.valid("json").path
        const target = path.resolve(raw.replace(/^~(?=$|\/)/, Global.Path.home))
        const source = path.resolve(Global.Path.data)
        if (!path.isAbsolute(target)) return c.json({ error: "Path must be absolute" }, 400)
        if (target === source) return c.json({ error: "Already the current location" }, 400)
        const rel = path.relative(source, target)
        if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel)))
          return c.json({ error: "Target cannot be inside the current data directory" }, 400)

        const existing = await fs.readdir(target).catch(() => undefined)
        if (existing && existing.length > 0) return c.json({ error: "Target directory is not empty" }, 400)

        await fs.mkdir(target, { recursive: true })
        await fs.cp(source, target, { recursive: true, errorOnExist: false, force: true })
        await Bun.write(pointerPath, target, { mode: 0o600 })
        return c.json({ ok: true, target, restart_required: true })
      },
    )
    .delete(
      "/location",
      describeRoute({
        summary: "Reset data location",
        description: "Remove the data-location pointer so the default location is used on next launch.",
        operationId: "settings.storage.resetLocation",
        responses: {
          200: {
            description: "Reset",
            content: { "application/json": { schema: resolver(z.object({ ok: z.boolean() })) } },
          },
        },
      }),
      async (c) => {
        await fs.rm(pointerPath, { force: true })
        return c.json({ ok: true })
      },
    ),
)

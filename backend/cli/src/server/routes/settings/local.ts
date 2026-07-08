import { Hono } from "hono"
import { validator } from "hono-openapi"
import z from "zod"
import { lazy } from "../../../util/lazy"
import { Log } from "../../../util/log"
import { Config } from "../../../config/config"
import { Provider } from "../../../provider/provider"
import { LocalProvider } from "../../../provider/local"

const log = Log.create({ service: "settings-local" })

/** Provider ids in config whose baseURL points at the local machine. */
async function configuredLocals() {
  const config = await Config.get().catch(() => ({}) as any)
  return Object.entries(config.provider ?? {})
    .filter(([, p]: [string, any]) => Provider.isLocalBaseURL(p?.options?.baseURL ?? p?.api))
    .map(([id, p]: [string, any]) => ({
      id,
      name: p?.name ?? id,
      baseURL: (p?.options?.baseURL ?? p?.api) as string,
      models: Object.keys(p?.models ?? {}),
    }))
}

/**
 * Local-model management for the workspace GUI. The SPA can't probe
 * `localhost:11434` itself (cross-origin), so the server — which CAN reach local
 * endpoints — does detection and listing on its behalf, and writes the provider
 * config block. Mirrors the `openscience local` CLI wizard.
 */
export const LocalModelsRoutes = lazy(() =>
  new Hono()
    // Configured local providers.
    .get("/", async (c) => c.json({ providers: await configuredLocals(), presets: LocalProvider.PRESETS }))

    // Auto-startable runtimes: is the CLI installed, and is it already running?
    .get("/status", async (c) => {
      const runtimes = await Promise.all(
        Object.entries(LocalProvider.RUNTIME_COMMANDS).map(async ([id, cmd]) => {
          const preset = LocalProvider.PRESETS.find((p) => p.id === id)
          const installed = !!Bun.which(cmd.bin)
          const models = preset ? await LocalProvider.probe(preset.baseURL, preset.apiKey) : null
          return {
            id,
            name: preset?.name ?? id,
            baseURL: preset?.baseURL,
            installed,
            running: Array.isArray(models),
            models: models ?? [],
            install: cmd.install,
            serveHint: cmd.serveHint,
          }
        }),
      )
      return c.json({ runtimes })
    })

    // Start (host) a runtime's server for the user, then wait until it responds.
    .post("/start", validator("json", z.object({ id: z.string() })), async (c) => {
      const { id } = c.req.valid("json")
      const cmd = LocalProvider.RUNTIME_COMMANDS[id]
      const preset = LocalProvider.PRESETS.find((p) => p.id === id)
      if (!cmd || !preset) return c.json({ error: `Unknown or non-startable runtime: ${id}` }, 400)

      // Already up? Just report the models.
      const already = await LocalProvider.probe(preset.baseURL, preset.apiKey)
      if (already) return c.json({ id, running: true, alreadyRunning: true, models: already })

      if (!Bun.which(cmd.bin)) {
        return c.json({ id, running: false, installed: false, install: cmd.install }, 200)
      }

      try {
        // Detached background server — unref so it outlives / doesn't block this
        // request and never keeps the openscience server alive on shutdown.
        const proc = Bun.spawn([cmd.bin, ...cmd.serve], { stdout: "ignore", stderr: "ignore", stdin: "ignore" })
        proc.unref?.()
        log.info("started local runtime", { id, bin: cmd.bin })
      } catch (e) {
        return c.json({ id, running: false, error: e instanceof Error ? e.message : String(e) }, 200)
      }

      // Poll until the OpenAI endpoint answers (server takes a moment to bind).
      const deadline = Date.now() + 15_000
      while (Date.now() < deadline) {
        await Bun.sleep(500)
        const models = await LocalProvider.probe(preset.baseURL, preset.apiKey)
        if (models) return c.json({ id, running: true, started: true, models })
      }
      return c.json(
        { id, running: false, started: true, error: "started but the endpoint didn't respond in time" },
        200,
      )
    })

    // Probe the well-known runtimes and report which are running + their models.
    .get("/detect", async (c) => {
      const detected = await LocalProvider.detect().catch(() => [])
      return c.json({
        detected: detected.map((d) => ({
          id: d.preset.id,
          name: d.preset.name,
          baseURL: d.preset.baseURL,
          models: d.models,
        })),
      })
    })

    // List the models a specific endpoint exposes (for a custom URL entry).
    .post("/models", validator("json", z.object({ url: z.string(), key: z.string().optional() })), async (c) => {
      const { url, key } = c.req.valid("json")
      const baseURL = LocalProvider.normalizeBaseURL(url)
      try {
        const models = await LocalProvider.listModels(baseURL, key)
        return c.json({ baseURL, models })
      } catch (e) {
        return c.json({ baseURL, models: [], error: e instanceof Error ? e.message : String(e) }, 200)
      }
    })

    // Register (or update) a local provider block.
    .post(
      "/",
      validator(
        "json",
        z.object({
          url: z.string(),
          id: z.string().optional(),
          name: z.string().optional(),
          key: z.string().optional(),
          models: z.array(z.string()).min(1),
          setDefault: z.boolean().optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const baseURL = LocalProvider.normalizeBaseURL(body.url)
        let host = "local"
        try {
          host = new URL(baseURL).host
        } catch {}
        const id = (body.id || `local-${host.split(":")[1] || host}`).replace(/[^a-z0-9-]/gi, "-").toLowerCase()
        const block = LocalProvider.buildProviderConfig({
          name: body.name || `Local (${host})`,
          baseURL,
          apiKey: body.key,
          models: body.models,
        })
        await Config.setProvider(id, block as any, "global")
        if (body.setDefault) await Config.updateGlobal({ model: `${id}/${body.models[0]}` })
        Provider.invalidate()
        log.info("registered local provider", { id, baseURL, models: body.models.length })
        return c.json({ id, baseURL, models: body.models })
      },
    )

    // Remove a local provider.
    .delete("/:id", async (c) => {
      const id = c.req.param("id")
      await Config.removeProvider(id, "global").catch(() => {})
      await Config.removeProvider(id, "project").catch(() => {})
      Provider.invalidate()
      return c.json({ id, removed: true })
    }),
)

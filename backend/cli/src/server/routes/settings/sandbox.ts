import { Hono } from "hono"
import { validator } from "hono-openapi"
import z from "zod"
import { lazy } from "../../../util/lazy"
import { Log } from "../../../util/log"
import { Config } from "../../../config/config"
import { Sandbox } from "../../../sandbox/sandbox"

const log = Log.create({ service: "settings-sandbox" })

const PatchSchema = z.object({
  enabled: z.boolean().optional(),
  network: z.enum(["allow", "deny"]).optional(),
  allowWrite: z.array(z.string()).optional(),
  onUnavailable: z.enum(["warn", "error", "allow"]).optional(),
})

async function currentConfig() {
  const config = await Config.get().catch(() => ({}) as Awaited<ReturnType<typeof Config.get>>)
  return config.sandbox ?? {}
}

/**
 * Execution-sandbox settings for the workspace GUI. The SPA can neither detect
 * the OS backend nor spawn a probe itself, so the server — which runs the
 * commands — reports availability, persists the config, and runs the empirical
 * self-test on its behalf. Mirrors the `openscience sandbox` CLI.
 */
export const SandboxSettingsRoutes = lazy(() =>
  new Hono()
    // Current config + backend availability.
    .get("/", async (c) => c.json({ config: await currentConfig(), status: Sandbox.describe() }))

    // Persist a partial config patch (machine-wide / global).
    .put("/", validator("json", PatchSchema), async (c) => {
      const patch = c.req.valid("json")
      log.info("updating sandbox config", { keys: Object.keys(patch) })
      const { config } = await Config.setSandbox(patch, "global")
      return c.json({ config: config.sandbox ?? {}, status: Sandbox.describe() })
    })

    // Run the empirical containment self-test.
    .post("/test", async (c) => c.json(Sandbox.selfTest())),
)

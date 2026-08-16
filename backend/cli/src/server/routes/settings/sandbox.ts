import { Hono } from "hono"
import { validator } from "hono-openapi"
import z from "zod"
import { lazy } from "../../../util/lazy"
import { Log } from "../../../util/log"
import { Config } from "../../../config/config"
import { Installer } from "@/package/installer"
import { Sandbox } from "../../../sandbox/sandbox"

const log = Log.create({ service: "settings-sandbox" })

const PatchSchema = z.object({
  enabled: z.boolean().optional(),
  network: z.enum(["deny", "allowlist", "allow"]).optional(),
  // Bounded the way main bounds allowWrite: this is attacker-reachable input
  // that ends up in a proxy's host allowlist, so an unbounded array of
  // unbounded strings is not something to accept just because it is new.
  allowHosts: z.array(z.string().trim().min(1).max(256)).max(64).optional(),
  allowWrite: z.array(z.string().trim().min(1).max(4096)).max(64).optional(),
  onUnavailable: z.enum(["warn", "error", "allow"]).optional(),
  requireProjectTrust: z.boolean().optional(),
})

async function currentConfig() {
  // Read the trusted (global + managed) policy directly — the same source the
  // bash tool enforces — rather than Config.get(), which needs an Instance
  // context this route is mounted before and would otherwise always throw → {}.
  return (await Config.trustedSandbox().catch(() => undefined)) ?? {}
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
    // `blocked` is a PREREQUISITE, not a status: on Windows an AppContainer can
    // only be granted access to paths its user owns, so a machine-wide Python
    // cannot be read by a sandboxed process however healthy it is. Nothing else
    // in this payload can express that, and without it the settings panel shows
    // a green sandbox on a machine where every install will fail.
    .get("/", async (c) =>
      c.json({
        config: await currentConfig(),
        status: Sandbox.describe(),
        blocked: (await Installer.blocked().catch(() => undefined)) ?? null,
      }),
    )

    // Persist a partial config patch (machine-wide / global).
    .put("/", validator("json", PatchSchema), async (c) => {
      const patch = c.req.valid("json")
      const roots = patch.allowWrite?.map((value) => ({ value, canonical: Sandbox.writableGrant(value) }))
      const invalid = roots?.find((value) => !value.canonical)
      if (invalid) return c.json({ error: `Writable sandbox path is invalid or over-broad: ${invalid.value}` }, 400)
      const next = {
        ...patch,
        ...(roots ? { allowWrite: [...new Set(roots.map((value) => value.canonical!))] } : {}),
      }
      log.info("updating sandbox config", { keys: Object.keys(patch) })
      // `next`, not `patch`: main canonicalises the writable roots first, and
      // persisting the raw patch would drop that.
      await Config.setSandbox(next)
      return c.json({
        config: await currentConfig(),
        status: Sandbox.describe(),
        blocked: (await Installer.blocked().catch(() => undefined)) ?? null,
      })
    })

    // Run the empirical containment self-test.
    .post("/test", async (c) => c.json(await Sandbox.selfTest())),
)

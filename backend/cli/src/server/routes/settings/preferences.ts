import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import path from "path"
import z from "zod"
import { Global } from "../../../global"
import { lazy } from "../../../util/lazy"
import { Log } from "../../../util/log"

const log = Log.create({ service: "settings-preferences" })

// Minimal real JSON preference store for settings surfaces that have no home in
// the strict Config schema (which strips unknown keys). Persists to
// `~/.config/openscience/settings.json` so the values survive restarts and are shared
// across every client talking to this local server.
const filepath = path.join(Global.Path.config, "settings.json")

export const Preferences = z.object({
  // Model reasoning effort applied when a model exposes it (General → Model).
  reasoning_effort: z.enum(["minimal", "low", "medium", "high"]).default("medium"),
  // Licensing use-intent (General → Licensing). Persisted for provenance /
  // downstream policy; drives no gate here beyond being recorded.
  intent: z.enum(["commercial", "non-commercial"]).default("non-commercial"),
  // Soft managed-compute spend ceiling in USD the user sets for themselves
  // (Usage → Extra usage budget). 0 = no extra budget beyond the plan.
  extra_budget_usd: z.number().min(0).default(0),
})
export type Preferences = z.infer<typeof Preferences>

async function read(): Promise<Preferences> {
  try {
    const raw = await Bun.file(filepath).json()
    return Preferences.parse(raw)
  } catch {
    // Missing / malformed file → schema defaults.
    return Preferences.parse({})
  }
}

async function write(next: Preferences): Promise<Preferences> {
  await Bun.write(filepath, JSON.stringify(next, null, 2), { mode: 0o600 })
  return next
}

export const SettingsPreferencesRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get settings preferences",
        operationId: "settings.preferences.get",
        responses: {
          200: {
            description: "Preferences",
            content: { "application/json": { schema: resolver(Preferences) } },
          },
        },
      }),
      async (c) => c.json(await read()),
    )
    .patch(
      "/",
      describeRoute({
        summary: "Update settings preferences",
        operationId: "settings.preferences.update",
        responses: {
          200: {
            description: "Updated preferences",
            content: { "application/json": { schema: resolver(Preferences) } },
          },
        },
      }),
      validator("json", Preferences.partial()),
      async (c) => {
        const patch = c.req.valid("json")
        const merged = Preferences.parse({ ...(await read()), ...patch })
        log.info("update", { keys: Object.keys(patch) })
        return c.json(await write(merged))
      },
    ),
)

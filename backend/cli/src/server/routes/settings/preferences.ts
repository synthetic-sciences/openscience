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
  // Retained as a no-op so existing 2.x SDK clients and settings files continue
  // to round-trip. OpenScience does not sell or budget managed compute.
  extra_budget_usd: z
    .number()
    .min(0)
    .default(0)
    .describe("@deprecated No billing effect. OpenScience compute is user-owned."),
  // The session trace is an advanced observability surface. Keep the regular
  // workspace quiet unless the user explicitly enables it in General.
  show_trace: z.boolean().default(false),
  // Local providers remain configured and usable when hidden; this controls
  // only whether they appear in the Settings → Models catalog.
  show_local_models: z.boolean().default(true),
  // Atlas is opt-in navigation. The switch controls only whether its local
  // project surface is shown; it never changes or deletes graph data.
  atlas_enabled: z.boolean().default(false),
  // Composer delegation is available by default. A selected specialist makes
  // the next normal prompt explicitly delegate to that subagent.
  delegation_enabled: z.boolean().default(true),
  delegation_specialist: z.string().nullable().default(null),
  delegation_level: z.enum(["off", "light", "standard", "high"]).default("standard"),
  delegation_worker_model: z
    .object({
      providerID: z.string(),
      modelID: z.string(),
    })
    .nullable()
    .default(null),
  // Independence applies to both the lead and delegated workers.
  delegation_autonomy: z.enum(["interactive", "balanced", "autonomous"]).default("balanced"),
  // Deprecated no-op retained so older 2.x clients and settings files still round-trip.
  delegation_diversity: z.enum(["focused", "balanced", "exploratory"]).default("balanced"),
})
export type Preferences = z.infer<typeof Preferences>

const PreferencesPatch = z.object({
  reasoning_effort: Preferences.shape.reasoning_effort.removeDefault().optional(),
  intent: Preferences.shape.intent.removeDefault().optional(),
  extra_budget_usd: Preferences.shape.extra_budget_usd.removeDefault().optional(),
  show_trace: Preferences.shape.show_trace.removeDefault().optional(),
  show_local_models: Preferences.shape.show_local_models.removeDefault().optional(),
  atlas_enabled: Preferences.shape.atlas_enabled.removeDefault().optional(),
  delegation_enabled: Preferences.shape.delegation_enabled.removeDefault().optional(),
  delegation_specialist: Preferences.shape.delegation_specialist.removeDefault().optional(),
  delegation_level: Preferences.shape.delegation_level.removeDefault().optional(),
  delegation_worker_model: Preferences.shape.delegation_worker_model.removeDefault().optional(),
  delegation_autonomy: Preferences.shape.delegation_autonomy.removeDefault().optional(),
  delegation_diversity: Preferences.shape.delegation_diversity.removeDefault().optional(),
})

function normalizeDelegation(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value
  const next = { ...(value as Record<string, unknown>) }
  const level = next.delegation_level
  if (level === "off" || level === "light" || level === "standard" || level === "high") {
    next.delegation_enabled = level !== "off"
  } else if (typeof next.delegation_enabled === "boolean") {
    next.delegation_level = next.delegation_enabled ? "standard" : "off"
  }
  return next
}

async function read(): Promise<Preferences> {
  try {
    const raw = await Bun.file(filepath).json()
    return Preferences.parse(normalizeDelegation(raw))
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
      validator("json", PreferencesPatch),
      async (c) => {
        const patch = normalizeDelegation(c.req.valid("json")) as Partial<Preferences>
        const merged = Preferences.parse({ ...(await read()), ...patch })
        log.info("update", { keys: Object.keys(patch) })
        return c.json(await write(merged))
      },
    ),
)

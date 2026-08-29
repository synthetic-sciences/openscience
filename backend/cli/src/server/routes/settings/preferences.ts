import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import path from "path"
import { randomUUID } from "node:crypto"
import z from "zod"
import { Global } from "../../../global"
import { lazy } from "../../../util/lazy"
import { Log } from "../../../util/log"
import { JsonStore } from "../../../util/jsonstore"

const log = Log.create({ service: "settings-preferences" })

// Minimal real JSON preference store for settings surfaces that have no home in
// the strict Config schema (which strips unknown keys). Persists to
// `~/.config/openscience/settings.json` so the values survive restarts and are shared
// across every client talking to this local server.
const filepath = path.join(Global.Path.config, "settings.json")

const OnboardingOperations = z
  .record(z.string().min(1).max(4_096), z.string().uuid())
  .refine((value) => Object.keys(value).length <= 32, "Too many pending desktop onboarding operations")

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
  // Desktop uses a random loopback port on every launch, so origin-scoped
  // browser storage cannot remember setup. Persist the completed wizard
  // revision in the shared local settings store instead.
  desktop_onboarding_version: z.number().int().min(0).default(0),
  // A create request can commit even when its response or the completion write
  // is lost. Bind each exact onboarding draft to its opaque create operation in
  // the same port-independent app store so a remounted desktop retries safely.
  desktop_onboarding_operations: OnboardingOperations.default({}),
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
  desktop_onboarding_version: Preferences.shape.desktop_onboarding_version.removeDefault().optional(),
  atlas_enabled: Preferences.shape.atlas_enabled.removeDefault().optional(),
  delegation_enabled: Preferences.shape.delegation_enabled.removeDefault().optional(),
  delegation_specialist: Preferences.shape.delegation_specialist.removeDefault().optional(),
  delegation_level: Preferences.shape.delegation_level.removeDefault().optional(),
  delegation_worker_model: Preferences.shape.delegation_worker_model.removeDefault().optional(),
  delegation_autonomy: Preferences.shape.delegation_autonomy.removeDefault().optional(),
  delegation_diversity: Preferences.shape.delegation_diversity.removeDefault().optional(),
})

const OnboardingOperationInput = z.object({
  fingerprint: z.string().min(1).max(4_096),
})

const OnboardingOperation = z.object({
  operation_id: z.string().uuid(),
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
  const raw = await JsonStore.read(filepath)
  const parsed = Preferences.safeParse(normalizeDelegation(raw))
  if (!parsed.success) {
    log.error("invalid settings file; preserving it and serving safe defaults", { issues: parsed.error.issues })
    return Preferences.parse({})
  }
  return parsed.data
}

async function mutate(fn: (current: Preferences) => Preferences): Promise<Preferences> {
  let result: Preferences | undefined
  await JsonStore.update(filepath, (raw) => {
    const current = Preferences.safeParse(normalizeDelegation(raw))
    if (!current.success) {
      throw new Error("The OpenScience settings file is invalid; refusing to overwrite it")
    }
    result = Preferences.parse(fn(current.data))
    return result as unknown as Record<string, unknown>
  })
  if (!result) throw new Error("OpenScience did not persist the settings update")
  return result
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
        log.info("update", { keys: Object.keys(patch) })
        return c.json(await mutate((current) => Preferences.parse({ ...current, ...patch })))
      },
    )
    .post(
      "/onboarding-operation",
      describeRoute({
        summary: "Get or create the durable operation for an exact desktop onboarding draft",
        operationId: "settings.preferences.onboardingOperation",
        responses: {
          200: {
            description: "Stable onboarding operation",
            content: { "application/json": { schema: resolver(OnboardingOperation) } },
          },
        },
      }),
      validator("json", OnboardingOperationInput),
      async (c) => {
        const { fingerprint } = c.req.valid("json")
        let operationID: string | undefined
        await mutate((current) => {
          operationID = current.desktop_onboarding_operations[fingerprint] ?? randomUUID()
          return Preferences.parse({
            ...current,
            desktop_onboarding_operations: {
              ...current.desktop_onboarding_operations,
              [fingerprint]: operationID,
            },
          })
        })
        return c.json(OnboardingOperation.parse({ operation_id: operationID }))
      },
    )
    .delete(
      "/onboarding-operation",
      describeRoute({
        summary: "Clear one completed desktop onboarding draft binding",
        operationId: "settings.preferences.clearOnboardingOperation",
        responses: { 204: { description: "Onboarding operation cleared" } },
      }),
      validator("json", OnboardingOperationInput),
      async (c) => {
        const { fingerprint } = c.req.valid("json")
        await mutate((current) => {
          const operations = { ...current.desktop_onboarding_operations }
          delete operations[fingerprint]
          return Preferences.parse({ ...current, desktop_onboarding_operations: operations })
        })
        return c.body(null, 204)
      },
    ),
)

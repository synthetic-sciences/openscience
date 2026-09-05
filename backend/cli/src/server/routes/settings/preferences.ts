import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import path from "path"
import { randomUUID } from "node:crypto"
import z from "zod"
import { Config } from "../../../config/config"
import { Global } from "../../../global"
import { CompactionSettings } from "../../../session/compaction-settings"
import { lazy } from "@synsci/util/lazy"
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

// Rows persisted verbatim to settings.json.
const Stored = z.object({
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
type Stored = z.infer<typeof Stored>

// Context-management rows are config, not app preferences: the session loop reads
// `compaction.*` through Config, so they live in the global openscience.json. The
// route exposes the effective values (defaults applied) so the workspace can read
// and write them without hand-editing the config file. Defaults mirror
// CompactionSettings.resolve so `Preferences.parse({})` equals a fresh install.
const Compaction = z.object({
  compaction_auto: z.boolean().default(true).describe("Automatic compaction when context is full (compaction.auto)"),
  compaction_threshold: z
    .number()
    .min(0)
    .max(1)
    .default(CompactionSettings.DEFAULT_THRESHOLD)
    .describe("Fraction of the model window that triggers automatic compaction (compaction.threshold)"),
})

export const Preferences = Stored.extend(Compaction.shape)
export type Preferences = z.infer<typeof Preferences>

const PreferencesPatch = z.object({
  reasoning_effort: Stored.shape.reasoning_effort.removeDefault().optional(),
  intent: Stored.shape.intent.removeDefault().optional(),
  extra_budget_usd: Stored.shape.extra_budget_usd.removeDefault().optional(),
  show_trace: Stored.shape.show_trace.removeDefault().optional(),
  show_local_models: Stored.shape.show_local_models.removeDefault().optional(),
  desktop_onboarding_version: Stored.shape.desktop_onboarding_version.removeDefault().optional(),
  atlas_enabled: Stored.shape.atlas_enabled.removeDefault().optional(),
  delegation_enabled: Stored.shape.delegation_enabled.removeDefault().optional(),
  delegation_specialist: Stored.shape.delegation_specialist.removeDefault().optional(),
  delegation_level: Stored.shape.delegation_level.removeDefault().optional(),
  delegation_worker_model: Stored.shape.delegation_worker_model.removeDefault().optional(),
  delegation_autonomy: Stored.shape.delegation_autonomy.removeDefault().optional(),
  delegation_diversity: Stored.shape.delegation_diversity.removeDefault().optional(),
  compaction_auto: Compaction.shape.compaction_auto.removeDefault().optional(),
  compaction_threshold: Compaction.shape.compaction_threshold.removeDefault().optional(),
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

async function stored(): Promise<Stored> {
  const raw = await JsonStore.read(filepath)
  const parsed = Stored.safeParse(normalizeDelegation(raw))
  if (!parsed.success) {
    log.error("invalid settings file; preserving it and serving safe defaults", { issues: parsed.error.issues })
    return Stored.parse({})
  }
  return parsed.data
}

// Effective compaction settings from the global config scope. Settings requests are
// not tied to a project Instance, so read the same scope the PATCH below writes.
async function compaction() {
  const config = await Config.getGlobal().catch((error) => {
    log.warn("global config unavailable; serving default compaction settings", { error: `${error}` })
    return {} as Config.Info
  })
  const effective = CompactionSettings.resolve(config)
  return {
    compaction_auto: effective.auto,
    compaction_threshold: effective.threshold,
  }
}

async function read(): Promise<Preferences> {
  const [current, context] = await Promise.all([stored(), compaction()])
  return { ...current, ...context }
}

async function mutate(fn: (current: Stored) => Stored): Promise<Stored> {
  let result: Stored | undefined
  await JsonStore.update(filepath, (raw) => {
    const current = Stored.safeParse(normalizeDelegation(raw))
    if (!current.success) {
      throw new Error("The OpenScience settings file is invalid; refusing to overwrite it")
    }
    result = Stored.parse(fn(current.data))
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
        const context = {
          ...(patch.compaction_auto === undefined ? {} : { auto: patch.compaction_auto }),
          ...(patch.compaction_threshold === undefined ? {} : { threshold: patch.compaction_threshold }),
        }
        const rows = Object.fromEntries(Object.entries(patch).filter(([key]) => !(key in Compaction.shape)))
        // Preserve instances: Config.state() re-reads on the global revision bump, so an
        // active session picks the new threshold up on its next turn without a teardown.
        if (Object.keys(context).length > 0) {
          await Config.updateGlobal({ compaction: context }, { preserveInstances: true })
        }
        if (Object.keys(rows).length > 0) await mutate((current) => Stored.parse({ ...current, ...rows }))
        return c.json(await read())
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
          return Stored.parse({
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
          return Stored.parse({ ...current, desktop_onboarding_operations: operations })
        })
        return c.body(null, 204)
      },
    ),
)

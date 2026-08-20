import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Flag } from "@/flag/flag"
import { OpenScience } from "@/openscience"
import { OutboundTelemetry } from "@/telemetry/outbound"
import { lazy } from "@/util/lazy"

const Telemetry = z.object({
  analyticsEnabled: z.boolean(),
  researchContentEnabled: z.literal(false),
  source: z.enum(["default", "local", "account"]),
  signedIn: z.boolean(),
  consentVersion: z.string(),
  pending: z.boolean(),
  corrupt: z.boolean(),
  deletionAvailable: z.boolean(),
})

const State = z.object({
  signedIn: z.boolean(),
  plan: z.object({ id: z.string(), label: z.string(), status: z.string().nullable() }),
  search: z.object({
    route: z.enum(["managed", "community"]),
    state: z.enum(["available", "near_limit", "critical", "exhausted", "conditional", "unavailable"]),
    enabled: z.boolean(),
    limit: z.number().int().nonnegative().nullable(),
    used: z.number().int().nonnegative().nullable(),
    remaining: z.number().int().nonnegative().nullable(),
    resetAt: z.string().nullable(),
    communityFlagEnabled: z.boolean(),
  }),
  telemetry: Telemetry,
})

function planLabel(id: string) {
  if (id === "ace") return "Ace"
  if (id === "ace_plus") return "Ace+"
  if (id === "pro") return "Legacy Pro"
  if (id === "starter") return "Legacy Starter"
  if (id === "teams") return "Teams"
  return "Free"
}

function allowanceState(input: {
  enabled: boolean
  limit: number | null
  used: number | null
  remaining: number | null
}) {
  if (!input.enabled) return "conditional" as const
  if (input.remaining === 0) return "exhausted" as const
  if (input.limit === null || input.used === null || input.limit <= 0) return "unavailable" as const
  const ratio = input.used / input.limit
  if (ratio >= 0.95) return "critical" as const
  if (ratio >= 0.8) return "near_limit" as const
  return "available" as const
}

async function read() {
  const session = await OpenScience.getSession().catch(() => null)
  const [profile, entitlements, telemetry] = await Promise.all([
    session ? OpenScience.getProfile().catch(() => null) : null,
    session ? OpenScience.getResearchEntitlements().catch(() => null) : null,
    OutboundTelemetry.status(true),
  ])
  const id = (entitlements?.plan ?? profile?.subscription_plan ?? "free").toLowerCase()
  const enabled = entitlements?.managed_search?.enabled === true
  const limit = entitlements?.managed_search?.limit ?? null
  const used = entitlements?.managed_search?.used ?? null
  const remaining = entitlements?.managed_search?.remaining ?? null
  return State.parse({
    signedIn: !!session,
    plan: { id, label: planLabel(id), status: entitlements?.status ?? profile?.subscription_status ?? null },
    search: {
      route: enabled ? "managed" : "community",
      state: allowanceState({ enabled, limit, used, remaining }),
      enabled,
      limit,
      used,
      remaining,
      resetAt: entitlements?.managed_search?.reset_at ?? null,
      communityFlagEnabled: Flag.OPENSCIENCE_ENABLE_EXA,
    },
    telemetry,
  })
}

export const ResearchToolsSettingsRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get plan, research-search, and data-sharing status",
        operationId: "settings.researchTools.get",
        responses: {
          200: { description: "Research tools status", content: { "application/json": { schema: resolver(State) } } },
        },
      }),
      async (c) => c.json(await read()),
    )
    .put(
      "/telemetry",
      describeRoute({
        summary: "Update structural usage sharing consent",
        operationId: "settings.researchTools.telemetry.update",
        responses: {
          200: {
            description: "Updated research tools status",
            content: { "application/json": { schema: resolver(State) } },
          },
        },
      }),
      validator("json", z.object({ analyticsEnabled: z.boolean() })),
      async (c) => {
        await OutboundTelemetry.setAnalytics(c.req.valid("json").analyticsEnabled)
        return c.json(await read())
      },
    )
    .delete(
      "/telemetry/account-data",
      describeRoute({
        summary: "Delete account-linked usage analytics",
        operationId: "settings.researchTools.telemetry.delete",
        responses: {
          200: {
            description: "Deletion status",
            content: {
              "application/json": { schema: resolver(z.object({ ok: z.boolean(), message: z.string().optional() })) },
            },
          },
        },
      }),
      async (c) => c.json(await OutboundTelemetry.requestDeletion()),
    ),
)

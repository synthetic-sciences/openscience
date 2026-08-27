import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Flag } from "@/flag/flag"
import { OpenScience } from "@/openscience"
import { OutboundTelemetry } from "@/telemetry/outbound"
import { lazy } from "@/util/lazy"

const Telemetry = z.object({
  analyticsEnabled: z.boolean(),
  researchContentEnabled: z.boolean(),
  userOwnedContentEnabled: z.boolean(),
  source: z.enum(["default", "local", "account"]),
  signedIn: z.boolean(),
  consentVersion: z.string(),
  pending: z.boolean(),
  corrupt: z.boolean(),
  deletionAvailable: z.boolean(),
  queuedEvents: z.number().int().nonnegative(),
  quarantinedEvents: z.number().int().nonnegative(),
})

const State = z.object({
  signedIn: z.boolean(),
  plan: z
    .object({ id: z.string(), label: z.string(), status: z.string().nullable() })
    .describe("@deprecated Compatibility summary. Billing is wallet-based and has no search quota."),
  search: z.object({
    route: z.enum(["credits", "managed", "community"]),
    state: z.enum(["available", "basic", "conditional", "near_limit", "critical", "exhausted", "unavailable"]),
    enabled: z.boolean(),
    balanceUsd: z.number().nullable(),
    limit: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe("@deprecated Always null; enhanced search draws from the shared wallet."),
    used: z
      .number()
      .int()
      .nonnegative()
      .nullable()
      .describe("@deprecated Always null; enhanced search draws from the shared wallet."),
    remaining: z.number().int().nonnegative().nullable().describe("@deprecated Always null; use balanceUsd."),
    resetAt: z.string().nullable().describe("@deprecated Always null; wallet credits do not reset."),
    communityFlagEnabled: z.boolean(),
  }),
  telemetry: Telemetry,
})

async function read() {
  const session = await OpenScience.getSession().catch(() => null)
  const [balance, telemetry] = await Promise.all([
    session ? OpenScience.getBalance().catch(() => null) : null,
    OutboundTelemetry.status(true),
  ])
  return State.parse({
    signedIn: !!session,
    plan: { id: "credits", label: "Credits", status: session ? "active" : null },
    search: {
      route: session ? "credits" : "community",
      state: !session ? "conditional" : balance === null || balance <= 0 ? "basic" : "available",
      enabled: !!session,
      balanceUsd: balance,
      limit: null,
      used: null,
      remaining: null,
      resetAt: null,
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
        summary: "Get credit-backed search and data-sharing status",
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
        summary: "Update OpenScience data-use consent",
        operationId: "settings.researchTools.telemetry.update",
        responses: {
          200: {
            description: "Updated research tools status",
            content: { "application/json": { schema: resolver(State) } },
          },
        },
      }),
      validator("json", z.object({ userOwnedContentEnabled: z.boolean() })),
      async (c) => {
        const input = c.req.valid("json")
        await OutboundTelemetry.setUserOwned(input.userOwnedContentEnabled)
        return c.json(await read())
      },
    )
    .delete(
      "/telemetry/account-data",
      describeRoute({
        summary: "Delete account-linked OpenScience trace data",
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

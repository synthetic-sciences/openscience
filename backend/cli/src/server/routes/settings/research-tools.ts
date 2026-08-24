import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
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
  wallet: z.object({
    mode: z.literal("payg"),
    balanceUsd: z.number().nullable(),
  }),
  search: z.object({
    route: z.enum(["enhanced", "community"]),
    enhancedAvailable: z.boolean(),
  }),
  telemetry: Telemetry,
})

async function read() {
  const session = await OpenScience.getSession().catch(() => null)
  const [balanceUsd, telemetry] = await Promise.all([
    session ? OpenScience.getBalance().catch(() => null) : null,
    OutboundTelemetry.status(true),
  ])
  const enhancedAvailable = !!session
  return State.parse({
    signedIn: enhancedAvailable,
    wallet: { mode: "payg", balanceUsd },
    search: {
      route: enhancedAvailable ? "enhanced" : "community",
      enhancedAvailable,
    },
    telemetry,
  })
}

export const ResearchToolsSettingsRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get wallet, enhanced-search, and data-sharing status",
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

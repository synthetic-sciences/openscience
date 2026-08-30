import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Config } from "../../../config/config"
import { OpenScience } from "../../../openscience"
import { lazy } from "../../../util/lazy"

export const BillingState = z.object({
  llm: z.enum(["managed", "byok"]).nullable(),
  compute: z.literal("byok"),
  wallet: z.object({ signedIn: z.boolean(), balanceUsd: z.number().nullable() }),
})
export type BillingState = z.infer<typeof BillingState>

const BillingPatch = z.object({
  llm: z.enum(["managed", "byok"]).nullable().optional(),
  compute: z.literal("byok").optional(),
})

async function readState(): Promise<BillingState> {
  // Routing is local-authoritative. Keep this read off the Atlas hot path so
  // opening Models and changing access never waits on account or Wallet I/O;
  // the dedicated Wallet endpoint owns the authoritative balance refresh.
  const [config, session] = await Promise.all([Config.getGlobal(), OpenScience.getSession().catch(() => null)])
  return {
    llm: config.billing?.llm ?? null,
    compute: "byok",
    wallet: { signedIn: !!session, balanceUsd: null },
  }
}

export const BillingSettingsRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get Ace/model billing state",
        operationId: "settings.billing.get",
        responses: {
          200: { description: "Billing state", content: { "application/json": { schema: resolver(BillingState) } } },
        },
      }),
      async (c) => c.json(await readState()),
    )
    .put(
      "/",
      describeRoute({
        summary: "Update Ace/model billing state",
        operationId: "settings.billing.update",
        responses: {
          200: { description: "Billing state", content: { "application/json": { schema: resolver(BillingState) } } },
        },
      }),
      validator("json", BillingPatch),
      async (c) => {
        const patch = c.req.valid("json")
        if (Object.hasOwn(patch, "llm")) await OpenScience.setBillingMode(patch.llm ?? "byok", patch.llm ?? null)
        const [config, session] = await Promise.all([Config.getGlobal(), OpenScience.getSession().catch(() => null)])
        return c.json({
          llm: config.billing?.llm ?? null,
          compute: "byok" as const,
          wallet: { signedIn: !!session, balanceUsd: null },
        })
      },
    ),
)

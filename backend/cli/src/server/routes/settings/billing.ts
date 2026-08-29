import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Config } from "../../../config/config"
import { OpenScience } from "../../../openscience"
import { lazy } from "../../../util/lazy"
import { Log } from "../../../util/log"

const log = Log.create({ service: "settings-billing" })

// The model-access control (Settings → Credits), backed by strict `billing.llm`
// config. "managed" runs on Credits; "byok" runs on the user's own keys/OAuth
// and is never billed. Null means auto-detect from the resolved credential.
export const BillingState = z.object({
  llm: z.enum(["managed", "byok"]).nullable(),
  compute: z
    .enum(["managed", "byok"])
    .describe("@deprecated Compatibility field. Compute always uses user-owned infrastructure."),
  wallet: z.object({
    signedIn: z.boolean().describe("Whether a Synthetic Sciences session is available"),
    balanceUsd: z.number().nullable().describe("Purchased Wallet balance in USD; null when signed out or unavailable"),
  }),
})
export type BillingState = z.infer<typeof BillingState>

// `llm: null` sets the toggle back to auto (auto-detect from the resolved
// credential); omitting a field leaves it untouched.
const BillingPatch = z.object({
  llm: z.enum(["managed", "byok"]).nullable().optional(),
  compute: z
    .enum(["managed", "byok"])
    .optional()
    .describe("@deprecated Accepted for 2.x clients and ignored. Compute always uses user-owned infrastructure."),
})

async function readState(): Promise<BillingState> {
  const [cfg, state] = await Promise.all([
    Config.getGlobal(),
    OpenScience.getReconciledFundingState().catch(() => null),
  ])
  const credits = state ? await OpenScience.getCredits(state.snapshot).catch(() => null) : null
  return {
    llm: cfg.billing?.llm ?? null,
    compute: "byok",
    wallet: { signedIn: !!state, balanceUsd: credits?.balanceUsd ?? null },
  }
}

export const BillingSettingsRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get LLM billing mode and wallet status",
        operationId: "settings.billing.get",
        responses: {
          200: {
            description: "Billing state",
            content: { "application/json": { schema: resolver(BillingState) } },
          },
        },
      }),
      async (c) => c.json(await readState()),
    )
    .put(
      "/",
      describeRoute({
        summary: "Update the LLM billing mode (managed vs BYOK)",
        operationId: "settings.billing.update",
        responses: {
          200: {
            description: "Updated billing state",
            content: { "application/json": { schema: resolver(BillingState) } },
          },
        },
      }),
      validator("json", BillingPatch),
      async (c) => {
        const patch = c.req.valid("json")
        // Explicit modes are local-authoritative. setBillingMode persists the
        // same Config field and mirrors it only to older Atlas deployments that
        // still expose the retired account-scoped endpoint. Automatic has no
        // legacy server equivalent, so it is a purely local delta.
        if (Object.hasOwn(patch, "llm")) {
          // Automatic is local null, but the rolling legacy server's `byok`
          // mode means own-key-first with managed fallback—the closest wire
          // equivalent. Current Atlas retires the mirror endpoint and the
          // background compatibility pass becomes a no-op.
          await OpenScience.setBillingMode(patch.llm ?? "byok", patch.llm ?? null)
        }
        log.info("update", { keys: Object.keys(patch) })
        const session = await OpenScience.getSession().catch(() => null)
        const saved = await Config.getGlobal()
        // Return the just-persisted mode immediately. Wallet refresh is an
        // independent read performed by the Settings panel and must not make a
        // local routing change wait on a stalled account service.
        return c.json({
          llm: saved.billing?.llm ?? null,
          compute: "byok",
          wallet: { signedIn: !!session, balanceUsd: null },
        } satisfies BillingState)
      },
    ),
)

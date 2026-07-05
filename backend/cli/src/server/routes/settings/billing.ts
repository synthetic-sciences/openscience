import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { Config } from "../../../config/config"
import { OpenScience } from "../../../openscience"
import { lazy } from "../../../util/lazy"
import { Log } from "../../../util/log"

const log = Log.create({ service: "settings-billing" })

// The two independent spend toggles (Settings → Spend), backed by the strict
// config (`billing.llm` / `billing.compute`). "managed" runs on the Atlas wallet;
// "byok" runs on the user's own keys/OAuth and is never billed. LLM is nullable
// (unset = auto-detect from the resolved credential); compute defaults to byok.
export const BillingState = z.object({
  llm: z.enum(["managed", "byok"]).nullable(),
  compute: z.enum(["managed", "byok"]),
  wallet: z.object({
    signedIn: z.boolean().describe("Whether an Atlas session (thk_ key) is available"),
    balanceUsd: z.number().describe("CLI wallet balance in USD; -1 when signed out or unavailable"),
  }),
})
export type BillingState = z.infer<typeof BillingState>

// `llm: null` sets the toggle back to auto (auto-detect from the resolved
// credential); omitting a field leaves it untouched.
const BillingPatch = z.object({
  llm: z.enum(["managed", "byok"]).nullable().optional(),
  compute: z.enum(["managed", "byok"]).optional(),
})

async function readState(): Promise<BillingState> {
  const cfg = await Config.getGlobal()
  const session = await OpenScience.getSession().catch(() => null)
  const balanceUsd = (session ? await OpenScience.getBalance().catch(() => null) : null) ?? -1
  return {
    llm: cfg.billing?.llm ?? null,
    compute: cfg.billing?.compute ?? "byok",
    wallet: { signedIn: !!session, balanceUsd },
  }
}

export const BillingSettingsRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "Get billing spend toggles + wallet status",
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
        summary: "Update billing spend toggles (managed vs BYOK)",
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
        // Persist only the delta. updateGlobal deep-merges into the raw file;
        // writing back Config.getGlobal() would bake resolved {env:}/{file:}
        // secrets into openscience.json in plaintext.
        await Config.updateGlobal({ billing: patch })
        log.info("update", { keys: Object.keys(patch) })

        // Mirror the LLM toggle to the account-scoped server billing mode, then force
        // a fresh sync so the right provider credentials (managed proxy token vs the
        // user's BYOK keys) are re-injected into the environment for the next call.
        // Auto (null) has no server-side counterpart — the account mode stays put and
        // the gate auto-detects from the resolved credential per call.
        if (patch.llm) {
          await OpenScience.setBillingMode(patch.llm).catch((e) =>
            log.warn("setBillingMode failed", { error: e instanceof Error ? e.message : String(e) }),
          )
          await OpenScience.syncServices().catch((e) =>
            log.warn("resync after billing change failed", { error: e instanceof Error ? e.message : String(e) }),
          )
        }
        return c.json(await readState())
      },
    ),
)

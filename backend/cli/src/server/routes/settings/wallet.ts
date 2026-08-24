import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { OpenScience } from "../../../openscience"
import { lazy } from "../../../util/lazy"

// Settings → Billing. Read-only view of pay-as-you-go Credits: balance,
// routing mode, lifetime spend, and the recent credit ledger. Adding funds is a
// hand-off to app.syntheticsciences.ai/billing -
// no payment UI in-app. Degrades to a signed-out shape when there's no Atlas
// session, and to empty sections when an Atlas endpoint is unavailable.
export const WalletState = z.object({
  signedIn: z.boolean(),
  balanceUsd: z.number().nullable().describe("Wallet balance in USD; null when signed out or unavailable"),
  billingMode: z.enum(["managed", "byok"]).nullable(),
  managedSupported: z.boolean(),
  lifetimeSpentUsd: z.number().nullable(),
  transactions: z.array(
    z.object({
      id: z.string(),
      amountCents: z.number(),
      source: z.string(),
      description: z.string(),
      createdAt: z.string(),
    }),
  ),
})
export type WalletState = z.infer<typeof WalletState>

const SIGNED_OUT: WalletState = {
  signedIn: false,
  balanceUsd: null,
  billingMode: null,
  managedSupported: false,
  lifetimeSpentUsd: null,
  transactions: [],
}

async function readWallet(): Promise<WalletState> {
  const session = await OpenScience.getSession().catch(() => null)
  if (!session) return SIGNED_OUT
  const [credits, mode, txns] = await Promise.all([
    OpenScience.getCredits().catch(() => null),
    OpenScience.getBillingMode().catch(() => null),
    OpenScience.getTransactions(20).catch(() => null),
  ])
  return {
    signedIn: true,
    // Financial display comes only from the authoritative Wallet response.
    // Compatibility mode metadata may synthesize zero when that read failed;
    // never turn an unavailable balance into "$0.00".
    balanceUsd: credits?.balanceUsd ?? null,
    billingMode: mode?.mode ?? null,
    managedSupported: mode?.managed_supported ?? false,
    lifetimeSpentUsd:
      credits?.lifetimeSpentCents === null || credits?.lifetimeSpentCents === undefined
        ? null
        : credits.lifetimeSpentCents / 100,
    transactions: (txns ?? []).map((t) => ({
      id: t.id,
      amountCents: t.amountCents,
      source: t.source,
      description: t.description,
      createdAt: t.createdAt,
    })),
  }
}

export const WalletSettingsRoutes = lazy(() =>
  new Hono().get(
    "/",
    describeRoute({
      summary: "Get wallet balance, routing mode, and recent transactions",
      operationId: "settings.wallet.get",
      responses: {
        200: {
          description: "Wallet state",
          content: { "application/json": { schema: resolver(WalletState) } },
        },
      },
    }),
    async (c) => c.json(await readWallet()),
  ),
)

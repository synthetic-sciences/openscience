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
  managedUnlocked: z.boolean(),
  aceEnabled: z.boolean(),
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
  managedUnlocked: false,
  aceEnabled: false,
  lifetimeSpentUsd: null,
  transactions: [],
}

async function readWallet(): Promise<WalletState> {
  const state = await OpenScience.getReconciledFundingState().catch(() => null)
  if (!state) return SIGNED_OUT
  const [credits, mode, txns] = await Promise.all([
    OpenScience.getCredits(state.snapshot).catch(() => null),
    OpenScience.getBillingMode(state.snapshot).catch(() => null),
    OpenScience.getTransactions(20, state.snapshot).catch(() => null),
  ])
  const balance = credits?.balanceUsd ?? null
  return {
    signedIn: true,
    // Financial display comes only from the authoritative Wallet response.
    // Compatibility mode metadata may synthesize zero when that read failed;
    // never turn an unavailable balance into "$0.00".
    balanceUsd: balance,
    billingMode: mode?.mode ?? null,
    managedSupported: mode?.managed_supported ?? false,
    // Keep funded accounts usable during a rolling Atlas deploy where the
    // older access response still tied managed_unlocked to Ace consent.
    managedUnlocked: Boolean(mode?.managed_unlocked || mode?.ace_enabled || (balance !== null && balance > 0)),
    aceEnabled: mode?.ace_enabled ?? false,
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

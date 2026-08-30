import { Hono } from "hono"
import { describeRoute, resolver } from "hono-openapi"
import z from "zod"
import { OpenScience } from "../../../openscience"
import { ACE_CONTRACT } from "../../../openscience/ace-contract"
import { lazy } from "../../../util/lazy"

export const WalletState = z.object({
  signedIn: z.boolean(),
  balanceUsd: z.number().nullable(),
  billingMode: z.enum(["managed", "byok"]).nullable(),
  managedSupported: z.boolean(),
  managedUnlocked: z.boolean(),
  aceEnabled: z.boolean(),
  aceContract: z.object({
    activationAuthorizationUsd: z.number().nonnegative(),
    reloadThresholdUsd: z.number().positive(),
    reloadAmountUsd: z.number().positive(),
    serviceMarginPercent: z.number().nonnegative(),
    processingFeeDisclosedSeparately: z.boolean(),
    reloadControlledByAce: z.boolean(),
  }),
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
  aceContract: { ...ACE_CONTRACT },
  lifetimeSpentUsd: null,
  transactions: [],
}

async function readWallet(): Promise<WalletState> {
  // The local immutable funding snapshot plus gateway response proof is the
  // authorization boundary. Avoid a separate auth-status round trip before
  // the three Wallet reads so the default Models panel can load them together.
  const snapshot = await OpenScience.getFundingSnapshot().catch(() => null)
  if (!snapshot) return SIGNED_OUT
  const creditsRequest = OpenScience.getCredits(snapshot).catch(() => null)
  const [credits, mode, transactions] = await Promise.all([
    creditsRequest,
    OpenScience.getBillingMode(snapshot, creditsRequest).catch(() => null),
    OpenScience.getTransactions(20, snapshot).catch(() => null),
  ])
  const balance = credits?.balanceUsd ?? null
  return {
    signedIn: true,
    balanceUsd: balance,
    billingMode: mode?.mode ?? null,
    managedSupported: mode?.managed_supported ?? false,
    managedUnlocked: Boolean(mode?.managed_unlocked || mode?.ace_enabled || (balance !== null && balance > 0)),
    aceEnabled: mode?.ace_enabled ?? false,
    aceContract: { ...ACE_CONTRACT },
    lifetimeSpentUsd: credits?.lifetimeSpentCents == null ? null : credits.lifetimeSpentCents / 100,
    transactions: transactions ?? [],
  }
}

export const WalletSettingsRoutes = lazy(() =>
  new Hono().get(
    "/",
    describeRoute({
      summary: "Get purchased wallet and Ace ledger",
      operationId: "settings.wallet.get",
      responses: {
        200: { description: "Wallet state", content: { "application/json": { schema: resolver(WalletState) } } },
      },
    }),
    async (c) => c.json(await readWallet()),
  ),
)

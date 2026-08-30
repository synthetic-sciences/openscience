import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { OpenScience } from "../../../openscience"
import { ACE_CONTRACT } from "../../../openscience/ace-contract"
import { lazy } from "../../../util/lazy"
import { withTimeout } from "../../../util/timeout"

const WALLET_BUDGET_MS = 2_500

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

async function readWallet(summary: boolean): Promise<WalletState> {
  // The local immutable funding snapshot plus gateway response proof is the
  // authorization boundary. Avoid a separate auth-status round trip before
  // the Wallet reads so the default Models panel can load them together. The
  // summary skips history and has a short budget; full ledger reads retain the
  // existing contract for callers that need transaction history.
  const snapshot = await OpenScience.getFundingSnapshot().catch(() => null)
  if (!snapshot) return SIGNED_OUT
  const creditsRequest = summary
    ? withTimeout(
        OpenScience.getCredits(snapshot, { timeoutMs: WALLET_BUDGET_MS, lifetimeSpent: false }),
        WALLET_BUDGET_MS,
      ).catch(() => null)
    : OpenScience.getCredits(snapshot).catch(() => null)
  const [credits, mode, transactions] = await Promise.all([
    creditsRequest,
    summary
      ? withTimeout(OpenScience.getBillingMode(snapshot, creditsRequest, WALLET_BUDGET_MS), WALLET_BUDGET_MS).catch(
          () => null,
        )
      : OpenScience.getBillingMode(snapshot, creditsRequest).catch(() => null),
    summary ? Promise.resolve([]) : OpenScience.getTransactions(20, snapshot).catch(() => null),
  ])
  const balance = credits?.balanceUsd ?? null
  return {
    signedIn: true,
    balanceUsd: balance,
    billingMode: mode?.mode ?? null,
    managedSupported: mode?.managed_supported ?? summary,
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
    validator(
      "query",
      z.object({
        summary: z.enum(["true", "false"]).optional().describe("Return a fast account summary without ledger history"),
      }),
    ),
    async (c) => c.json(await readWallet(c.req.valid("query").summary === "true")),
  ),
)

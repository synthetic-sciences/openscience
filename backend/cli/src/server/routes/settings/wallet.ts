import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { OpenScience } from "../../../openscience"
import { ACE_CONTRACT } from "../../../openscience/ace-contract"
import { lazy } from "../../../util/lazy"
import { withTimeout } from "../../../util/timeout"

export const WALLET_BUDGET_MS = 5_000

export const WalletState = z.object({
  signedIn: z.boolean(),
  balanceUsd: z.number().nullable(),
  balanceRedacted: z.boolean().optional(),
  accessVerified: z.boolean().optional(),
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

export async function readWallet(
  summary: boolean,
  account: Pick<
    typeof OpenScience,
    "getFundingSnapshot" | "getReconciledFundingState" | "getCredits" | "getBillingMode" | "getTransactions"
  > = OpenScience,
): Promise<WalletState> {
  // Reconcile a legacy unscoped device before any Wallet endpoint sees it.
  // The resulting immutable snapshot plus each gateway response proof is the
  // authorization boundary for every parallel read below.
  const snapshot = (await account.getReconciledFundingState().catch(() => null))?.snapshot
  if (!snapshot) return SIGNED_OUT
  const creditsRequest = summary
    ? withTimeout(
        account.getCredits(snapshot, { timeoutMs: WALLET_BUDGET_MS, lifetimeSpent: false }),
        WALLET_BUDGET_MS,
      ).catch(() => null)
    : account.getCredits(snapshot).catch(() => null)
  const [credits, mode, transactions] = await Promise.all([
    creditsRequest,
    summary
      ? withTimeout(account.getBillingMode(snapshot, creditsRequest, WALLET_BUDGET_MS), WALLET_BUDGET_MS).catch(
          () => null,
        )
      : account.getBillingMode(snapshot, creditsRequest).catch(() => null),
    summary ? Promise.resolve([]) : account.getTransactions(20, snapshot).catch(() => null),
  ])
  const current = await account.getFundingSnapshot()
  if (!current) return SIGNED_OUT
  if (
    current.api_key !== snapshot.api_key ||
    current.user_id !== snapshot.user_id ||
    current.organization_id !== snapshot.organization_id ||
    current.workspace_locked !== snapshot.workspace_locked
  ) {
    throw new Error("The selected account changed while refreshing the Wallet. Retry.")
  }
  const redacted = Boolean(credits?.balanceRedacted || mode?.balance_redacted)
  const balance = redacted ? null : (credits?.balanceUsd ?? (mode?.balance_verified ? mode.balance_usd : null))
  return {
    signedIn: true,
    balanceUsd: balance,
    balanceRedacted: redacted,
    accessVerified: mode?.access_verified === true,
    billingMode: mode?.mode ?? null,
    managedSupported: mode?.managed_supported ?? summary,
    // Explicit access denials outrank cash or reload consent. Neither implies
    // permission to spend from a workspace with a revoked role or usage limit.
    managedUnlocked: mode?.access_verified === true && mode.managed_supported && mode.managed_unlocked,
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

import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { OpenScience } from "../../../openscience"
import { ACE_CONTRACT } from "../../../openscience/ace-contract"
import { lazy } from "@synsci/util/lazy"

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
  /** True while the served values come from the stored summary and a newer one is being read. */
  refreshing: z.boolean(),
  /** When the served values were read from the account service. */
  refreshedAt: z.number().nullable(),
  /** Why the latest refresh failed, when stored values are served instead. */
  error: z.string().optional(),
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
  refreshing: false,
  refreshedAt: null,
}

type Read<T> = { value: T } | { error: string }

const settle = <T>(promise: Promise<T>): Promise<Read<T>> =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }),
  )

/** Project one signed-in account summary onto the Wallet contract. */
export function walletState(input: {
  snapshot: OpenScience.AccountSnapshot | null
  refreshing: boolean
  error?: string
  summary: boolean
  transactions: OpenScience.Transaction[]
}): WalletState {
  const credits = input.snapshot?.credits ?? null
  const mode = input.snapshot?.billing ?? null
  const redacted = Boolean(credits?.balanceRedacted || mode?.balance_redacted)
  const balance = redacted ? null : (credits?.balanceUsd ?? (mode?.balance_verified ? mode.balance_usd : null))
  return {
    signedIn: true,
    balanceUsd: balance,
    balanceRedacted: redacted,
    accessVerified: mode?.access_verified === true,
    billingMode: mode?.mode ?? null,
    managedSupported: mode?.managed_supported ?? input.summary,
    // Explicit access denials outrank cash or reload consent. Neither implies
    // permission to spend from a workspace with a revoked role or usage limit.
    managedUnlocked: mode?.access_verified === true && mode.managed_supported && mode.managed_unlocked,
    aceEnabled: mode?.ace_enabled ?? false,
    aceContract: { ...ACE_CONTRACT },
    lifetimeSpentUsd: credits?.lifetimeSpentCents == null ? null : credits.lifetimeSpentCents / 100,
    transactions: input.transactions,
    refreshing: input.refreshing,
    refreshedAt: input.snapshot?.at ?? null,
    ...(input.error ? { error: input.error } : {}),
  }
}

export async function readWallet(
  summary: boolean,
  account: Pick<
    typeof OpenScience,
    "getAccountSummary" | "getFundingSnapshot" | "refreshAccount" | "getTransactions"
  > = OpenScience,
  signal?: AbortSignal,
): Promise<WalletState> {
  if (summary) {
    // The stored summary is served at once; a stale one is refreshed in the
    // background and announced as `account.updated`. A first read waits under
    // the account deadline and the request's own signal.
    const read = await settle(account.getAccountSummary({ signal }))
    if ("error" in read) {
      return walletState({ snapshot: null, refreshing: false, error: read.error, summary: true, transactions: [] })
    }
    if (!read.value) return SIGNED_OUT
    return walletState({
      snapshot: read.value,
      refreshing: read.value.refreshing,
      error: read.value.error,
      summary: true,
      transactions: [],
    })
  }
  // The ledger view is always a fresh read; the summary it fetches is stored
  // for the next quick open. Both reads share the one account deadline.
  const session = await account.getFundingSnapshot()
  if (!session) return SIGNED_OUT
  const deadline = OpenScience.accountDeadline(signal)
  const [snapshot, transactions] = await Promise.all([
    settle(account.refreshAccount(session, { signal: deadline })),
    account.getTransactions(20, session, deadline).catch(() => null),
  ])
  return walletState({
    snapshot: "value" in snapshot ? snapshot.value : null,
    refreshing: false,
    error: "error" in snapshot ? snapshot.error : undefined,
    summary: false,
    transactions: transactions ?? [],
  })
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
    async (c) => c.json(await readWallet(c.req.valid("query").summary === "true", OpenScience, c.req.raw.signal)),
  ),
)

import { describe, expect, test } from "bun:test"
import { OpenScience, type FundingSnapshot } from "../../src/openscience"
import { readWallet, walletState } from "../../src/server/routes/settings/wallet"

const snapshot: FundingSnapshot = Object.freeze({
  api_key: "thk_wallet_fixture",
  user_id: "fixture",
  account: "fixture",
  organization_id: "workspace-a",
})
const credits: OpenScience.Credits = {
  balanceUsd: 20,
  balanceCents: 2000,
  cliBalanceCents: 2000,
  spendableBalanceCents: 2000,
  promotionalBalanceCents: 0,
  cycleCreditsRemainingCents: 0,
  lifetimeSpentCents: null,
}
const mode: OpenScience.BillingMode = {
  mode: "byok",
  balance_cents: 2000,
  balance_usd: 20,
  managed_supported: true,
  managed_unlocked: true,
  ace_enabled: false,
  access_verified: true,
}
const context = {
  type: "organization" as const,
  organization_id: snapshot.organization_id,
  available: true,
  locked: true,
  organizations: [],
}
const stored: OpenScience.AccountSnapshot = { at: 1_700_000_000_000, context, credits, billing: mode }
const project = (patch: Partial<OpenScience.AccountSnapshot>) =>
  walletState({ snapshot: { ...stored, ...patch }, refreshing: false, summary: true, transactions: [] })
const account = {
  getFundingSnapshot: async () => snapshot,
  getAccountSummary: async (): Promise<OpenScience.AccountSummary | null> => ({ ...stored, refreshing: false }),
  refreshAccount: async () => stored,
  getTransactions: async () => [],
}

describe("Wallet account summary", () => {
  test("serves the stored summary at once and reports that a refresh is running", async () => {
    const result = await readWallet(true, {
      ...account,
      getAccountSummary: async () => ({ ...stored, refreshing: true }),
      getTransactions: async () => {
        throw new Error("Summary must not fetch the ledger")
      },
      refreshAccount: async () => {
        throw new Error("Summary must not wait for a fresh read")
      },
    })
    expect(result.balanceUsd).toBe(20)
    expect(result.managedUnlocked).toBe(true)
    expect(result.refreshing).toBe(true)
    expect(result.refreshedAt).toBe(stored.at)
  })

  test("keeps the stored values and surfaces the reason when the latest refresh failed", async () => {
    const result = await readWallet(true, {
      ...account,
      getAccountSummary: async () => ({ ...stored, refreshing: false, error: "Account service unavailable" }),
    })
    expect(result.balanceUsd).toBe(20)
    expect(result.refreshing).toBe(false)
    expect(result.error).toBe("Account service unavailable")
  })

  test("a first read with nothing stored that fails stays signed in with no balance", async () => {
    const result = await readWallet(true, {
      ...account,
      getAccountSummary: async () => {
        throw new Error("The Ace account service is unavailable. Retry when connected.")
      },
    })
    expect(result.signedIn).toBe(true)
    expect(result.balanceUsd).toBeNull()
    expect(result.accessVerified).toBe(false)
    expect(result.managedUnlocked).toBe(false)
    expect(result.error).toContain("unavailable")
  })

  test("signed-out readers get the signed-out contract without any account read", async () => {
    const result = await readWallet(true, { ...account, getAccountSummary: async () => null })
    expect(result.signedIn).toBe(false)
    expect(result.refreshing).toBe(false)
    expect(result.refreshedAt).toBeNull()
  })

  test("the ledger view always reads fresh and includes transactions", async () => {
    const state = { refreshes: 0 }
    const result = await readWallet(false, {
      ...account,
      getAccountSummary: async () => {
        throw new Error("Ledger must not serve the stored summary")
      },
      refreshAccount: async (selected) => {
        expect(selected).toBe(snapshot)
        state.refreshes++
        return stored
      },
      getTransactions: async () => [
        { id: "t1", amountCents: -125, source: "ace", description: "Turn", createdAt: "2026-09-01T00:00:00Z" },
      ],
    })
    expect(state.refreshes).toBe(1)
    expect(result.refreshing).toBe(false)
    expect(result.transactions).toHaveLength(1)
    expect(result.balanceUsd).toBe(20)
  })

  test("never overrides an explicit access denial with cash or Ace reload consent", () => {
    const result = project({ billing: { ...mode, managed_unlocked: false, ace_enabled: true } })
    expect(result.balanceUsd).toBe(20)
    expect(result.managedUnlocked).toBe(false)
    expect(result.accessVerified).toBe(true)
  })

  test("a known purchased balance never substitutes for an unavailable access check", () => {
    for (const unavailable of [null, { ...mode, access_verified: false }]) {
      const result = project({ billing: unavailable })
      expect(result.balanceUsd).toBe(20)
      expect(result.accessVerified).toBe(false)
      expect(result.managedUnlocked).toBe(false)
    }
  })

  test("uses a proved access balance when the separate Wallet read temporarily fails", () => {
    const result = project({ credits: null, billing: { ...mode, balance_verified: true } })
    expect(result.balanceUsd).toBe(20)
    const unknown = project({ credits: null })
    expect(unknown.balanceUsd).toBeNull()
  })

  test("keeps a private workspace balance hidden without denying verified member access", () => {
    const result = project({ credits: { ...credits, balanceRedacted: true } })
    expect(result.balanceUsd).toBeNull()
    expect(result.balanceRedacted).toBe(true)
    expect(result.managedUnlocked).toBe(true)
    const changed = project({ billing: { ...mode, balance_redacted: true } })
    expect(changed.balanceUsd).toBeNull()
  })

  test("keeps selected-workspace response proof mandatory", async () => {
    const correct = Response.json(
      {},
      {
        headers: {
          "OpenScience-Funding-Protocol": "1",
          "OpenScience-Funding-Context": "organization:workspace-a",
        },
      },
    )
    expect(await OpenScience.validateFundingResponse(correct, snapshot)).toBe(correct)
    const wrong = Response.json(
      {},
      {
        headers: {
          "OpenScience-Funding-Protocol": "1",
          "OpenScience-Funding-Context": "organization:workspace-b",
        },
      },
    )
    await expect(OpenScience.validateFundingResponse(wrong, snapshot)).rejects.toThrow("verify the selected workspace")
  })
})

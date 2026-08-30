import { describe, expect, test } from "bun:test"
import { OpenScience, type FundingSnapshot } from "../../src/openscience"
import { readWallet, WALLET_BUDGET_MS } from "../../src/server/routes/settings/wallet"

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
const account = {
  getFundingSnapshot: async () => snapshot,
  getCredits: async () => credits,
  getBillingMode: async () => mode,
  getTransactions: async () => [],
}

describe("Wallet account summary", () => {
  test("accepts a 2.8-second successful balance within the bounded summary budget", async () => {
    const result = await readWallet(true, {
      ...account,
      getCredits: async (selected, options) => {
        expect(selected).toBe(snapshot)
        expect(options).toEqual({ timeoutMs: WALLET_BUDGET_MS, lifetimeSpent: false })
        await Bun.sleep(2800)
        return credits
      },
      getTransactions: async () => {
        throw new Error("Summary must not fetch the ledger")
      },
    })
    expect(result.balanceUsd).toBe(20)
    expect(result.managedUnlocked).toBe(true)
  })

  test("never overrides an explicit access denial with cash or Ace reload consent", async () => {
    const result = await readWallet(true, {
      ...account,
      getBillingMode: async () => ({ ...mode, managed_unlocked: false, ace_enabled: true }),
    })
    expect(result.balanceUsd).toBe(20)
    expect(result.managedUnlocked).toBe(false)
    expect(result.accessVerified).toBe(true)
  })

  test("a known purchased balance never substitutes for an unavailable access check", async () => {
    for (const unavailable of [null, { ...mode, access_verified: false }]) {
      const result = await readWallet(true, { ...account, getBillingMode: async () => unavailable })
      expect(result.balanceUsd).toBe(20)
      expect(result.accessVerified).toBe(false)
      expect(result.managedUnlocked).toBe(false)
    }
  })

  test("uses a proved access balance when the separate Wallet read temporarily fails", async () => {
    const result = await readWallet(true, {
      ...account,
      getCredits: async () => null,
      getBillingMode: async () => ({ ...mode, balance_verified: true }),
    })
    expect(result.balanceUsd).toBe(20)
    const unknown = await readWallet(true, { ...account, getCredits: async () => null })
    expect(unknown.balanceUsd).toBeNull()
  })

  test("keeps a private workspace balance hidden without denying verified member access", async () => {
    const result = await readWallet(true, {
      ...account,
      getCredits: async () => ({ ...credits, balanceRedacted: true }),
    })
    expect(result.balanceUsd).toBeNull()
    expect(result.balanceRedacted).toBe(true)
    expect(result.managedUnlocked).toBe(true)
    const changed = await readWallet(true, {
      ...account,
      getBillingMode: async () => ({ ...mode, balance_redacted: true }),
    })
    expect(changed.balanceUsd).toBeNull()
  })

  test("refuses to publish a result after the selected workspace changes", async () => {
    const state = { reads: 0 }
    await expect(
      readWallet(true, {
        ...account,
        getFundingSnapshot: async () =>
          ++state.reads === 1 ? snapshot : { ...snapshot, organization_id: "workspace-b" },
      }),
    ).rejects.toThrow("selected account changed")
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

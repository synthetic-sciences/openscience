import { test, expect, describe } from "bun:test"
import { OpenScience } from "../../src/openscience"

// Wallet balance bug: the CLI showed the CLI-only ledger, but managed mode
// debits the UNIFIED wallet (Atlas charges category="unified" — subscription
// pool, then the Atlas-web ledger, then the CLI ledger). A user with any
// Atlas-ledger balance saw managed calls drain that pool first while the
// displayed CLI wallet never moved ("my credits aren't being deducted").
// cliSpendableCents must report the unified spendable balance.

describe("cliSpendableCents", () => {
  test("prefers the unified spendable balance over the CLI-only ledger", () => {
    // Unified $156.34 (Atlas ledger $101.79 + CLI ledger $54.55). Managed spend
    // drains the Atlas ledger first, so the spendable figure is the unified one.
    expect(OpenScience.cliSpendableCents({ cli_balance_cents: 5455, unified_balance_cents: 15634 })).toBe(15634)
  })

  test("shows an empty unified balance as 0, even with a stale CLI-ledger figure", () => {
    expect(OpenScience.cliSpendableCents({ cli_balance_cents: 5455, unified_balance_cents: 0 })).toBe(0)
  })

  test("falls back to the aggregate, then the CLI ledger, when unified is absent", () => {
    expect(OpenScience.cliSpendableCents({ balance_cents: 300 })).toBe(300)
    expect(OpenScience.cliSpendableCents({ cli_balance_cents: 250 })).toBe(250)
    expect(OpenScience.cliSpendableCents({})).toBe(0)
  })
})

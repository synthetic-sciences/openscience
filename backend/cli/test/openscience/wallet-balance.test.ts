import { test, expect, describe } from "bun:test"
import { OpenScience } from "../../src/openscience"

describe("walletCents", () => {
  test("prefers the canonical balance over legacy fields", () => {
    expect(
      OpenScience.walletCents({
        balance_cents: 5000,
        cli_balance_cents: 250,
        unified_balance_cents: 16000,
      }),
    ).toBe(5000)
  })

  test("preserves a literal canonical zero", () => {
    expect(
      OpenScience.walletCents({
        balance_cents: 0,
        cli_balance_cents: 250,
        unified_balance_cents: 16000,
      }),
    ).toBe(0)
  })

  test("supports old Atlas responses", () => {
    expect(OpenScience.walletCents({ cli_balance_cents: 300 })).toBe(300)
    expect(OpenScience.walletCents({ unified_balance_cents: 500 })).toBe(500)
    expect(OpenScience.walletCents({})).toBe(0)
  })
})

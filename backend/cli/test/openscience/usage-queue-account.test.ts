import { describe, expect, test } from "bun:test"
import { OpenScience } from "../../src/openscience"

describe("OpenScience.shouldFlushForAccount", () => {
  test("flushes a row tagged for the current account", () => {
    expect(OpenScience.shouldFlushForAccount("user-1\u0000personal", "user-1\u0000personal", "user-1")).toBe(true)
  })

  test("refuses a row tagged for a DIFFERENT account (never bill the wrong one)", () => {
    expect(OpenScience.shouldFlushForAccount("user-1", "user-2\u0000personal", "user-2")).toBe(false)
  })

  test("flushes a legacy/accountless row under the current account (best-effort)", () => {
    expect(OpenScience.shouldFlushForAccount(undefined, "user-1\u0000personal", "user-1")).toBe(true)
    expect(OpenScience.shouldFlushForAccount("", "user-1\u0000personal", "user-1")).toBe(true)
  })

  test("never replays a pre-organization row against an organization Wallet", () => {
    expect(OpenScience.shouldFlushForAccount(undefined, "user-1\u0000organization:org-1")).toBe(false)
    expect(OpenScience.shouldFlushForAccount("user-1", "user-1\u0000organization:org-1")).toBe(false)
  })
})

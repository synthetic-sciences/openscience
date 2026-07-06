import { describe, expect, test } from "bun:test"
import { clampLimit, firstString, looksLikeAccession } from "../../src/science/connectors/proteins/util"

describe("looksLikeAccession", () => {
  test("accepts Swiss-Prot accessions that begin with O, P or Q", () => {
    // The O/P/Q prefixes cover most human proteins; the old [A-NR-Z0-9] class
    // excluded them, breaking the AlphaFold/SIFTS exact-ac fast path.
    for (const ac of ["P04637", "P38398", "O43426", "Q9Y6K9", "P00520"]) {
      expect(looksLikeAccession(ac)).toBe(true)
    }
  })

  test("accepts long (10-char) TrEMBL accessions", () => {
    expect(looksLikeAccession("A0A0B5AC95")).toBe(true)
  })

  test("trims surrounding whitespace before matching", () => {
    expect(looksLikeAccession("  P04637  ")).toBe(true)
  })

  test("rejects free-text names and out-of-range lengths", () => {
    expect(looksLikeAccession("p53")).toBe(false)
    expect(looksLikeAccession("tumor protein")).toBe(false)
    expect(looksLikeAccession("A")).toBe(false)
    expect(looksLikeAccession("A0A0B5AC95X1")).toBe(false)
  })
})

describe("clampLimit", () => {
  test("clamps into [1, max] and defaults when unset", () => {
    expect(clampLimit(undefined, 5, 25)).toBe(5)
    expect(clampLimit(0, 5, 25)).toBe(1)
    expect(clampLimit(999, 5, 25)).toBe(25)
    expect(clampLimit(3.9, 5, 25)).toBe(3)
  })
})

describe("firstString", () => {
  test("returns the first non-empty string", () => {
    expect(firstString(undefined, "", "  ", "hit", "next")).toBe("hit")
    expect(firstString(1, null, {})).toBeUndefined()
  })
})

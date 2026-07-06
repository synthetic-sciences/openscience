import { describe, expect, test } from "bun:test"
import { looksLikeAccession } from "../../src/science/connectors/proteins/util"

describe("looksLikeAccession", () => {
  // O/P/Q lead the majority of Swiss-Prot accessions. The docstring's own
  // example (P00520) starts with P, so these must be recognized.
  test.each(["P00520", "P04637", "P38398", "O43426", "Q9Y6K9", "A0A0B5AC95", "B7ZLR8", "P12345"])(
    "accepts accession %s",
    (accession) => {
      expect(looksLikeAccession(accession)).toBe(true)
    },
  )

  test("trims surrounding whitespace before matching", () => {
    expect(looksLikeAccession("  P04637  ")).toBe(true)
  })

  // The guard is a loose "6-10 alphanumerics" heuristic, so the rejects are
  // strings that fall outside that shape: too short, too long, or punctuated.
  test.each(["TP53", "p53", "", "P0", "P04-637", "TOOLONGACCESSION12"])("rejects non-accession %p", (value) => {
    expect(looksLikeAccession(value)).toBe(false)
  })
})

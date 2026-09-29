import { describe, expect, test } from "bun:test"
import { terminalMatches } from "./terminal-search"

describe("terminal scrollback search", () => {
  test("finds every match with case-insensitive row and column coordinates", () => {
    expect(terminalMatches(["Build complete", "build again", "idle"], "BUILD")).toEqual([
      { column: 0, row: 0, length: 5 },
      { column: 0, row: 1, length: 5 },
    ])
  })

  test("finds repeated and overlapping matches", () => {
    expect(terminalMatches(["aaaa"], "aa")).toEqual([
      { column: 0, row: 0, length: 2 },
      { column: 1, row: 0, length: 2 },
      { column: 2, row: 0, length: 2 },
    ])
  })

  test("returns no coordinates for an empty or missing query", () => {
    expect(terminalMatches(["output"], "")).toEqual([])
    expect(terminalMatches(["output"], "error")).toEqual([])
  })

  test("reports columns in the original line when folding changes its length", () => {
    // U+0130 is the only code point whose lowercase is longer, and it grows
    // under the default locale, so an offset found in the folded line is not
    // the cell xterm selects against the original buffer.
    expect(terminalMatches(["İST build"], "build")).toEqual([{ column: 4, row: 0, length: 5 }])
    expect(terminalMatches(["İST build"], "st")).toEqual([{ column: 1, row: 0, length: 2 }])
  })

  test("spans a whole astral character instead of cutting it in half", () => {
    // Deriving the end from the start of the last folded unit is a code unit
    // short here, which drew the highlight through half the emoji.
    expect(terminalMatches(["x😀"], "😀")).toEqual([{ column: 1, row: 0, length: 2 }])
    expect(terminalMatches(["😀 done"], "😀")).toEqual([{ column: 0, row: 0, length: 2 }])
  })

  test("still reports plain ASCII lines unchanged", () => {
    expect(terminalMatches(["abc build"], "build")).toEqual([{ column: 4, row: 0, length: 5 }])
  })
})

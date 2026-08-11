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
})

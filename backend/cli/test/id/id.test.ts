import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"

describe("Identifier", () => {
  test("creates fixed-length base62 identifiers", () => {
    const id = Identifier.ascending("session", undefined)

    expect(id).toMatch(/^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
    expect(id).toHaveLength(30)
  })

  test("does not reuse the random suffix", () => {
    const ids = Array.from({ length: 1_000 }, () => Identifier.ascending("message"))
    const suffixes = new Set(ids.map((id) => id.slice(-14)))

    expect(suffixes.size).toBe(ids.length)
  })
})

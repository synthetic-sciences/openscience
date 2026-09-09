import { describe, expect, test } from "bun:test"
import { Identifier } from "./id"

describe("Identifier.after", () => {
  test("keeps the natural id when it already sorts after the newest message", () => {
    const id = Identifier.after("message", "msg_000000000000aaaaaaaaaaaaaa")
    expect(id.startsWith("msg_")).toBe(true)
    expect(id > "msg_000000000000aaaaaaaaaaaaaa").toBe(true)
  })

  test("bumps past a pre-wrap id so the optimistic message lands where the server's will", () => {
    // Ids minted before the 2026-08-14 prefix wrap start near ffff…; a fresh
    // id starts near 08…, and would otherwise sort to the top of the session.
    const highest = "msg_f7a530c97ffevJ7VA4DFt994oF"
    const id = Identifier.after("message", highest)
    expect(id > highest).toBe(true)
    expect(id.slice(4, 16)).toBe("f7a530c97fff")
    expect(id).toHaveLength(highest.length)
  })

  test("with nothing known, an ordinary ascending id is returned", () => {
    expect(Identifier.after("message", undefined)).toMatch(/^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/)
  })
})

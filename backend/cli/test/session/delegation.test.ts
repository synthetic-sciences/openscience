import { describe, expect, test } from "bun:test"
import { SessionPrompt } from "../../src/session/prompt"

describe("composer delegation", () => {
  test("keeps delegation available by default and when explicitly requested", () => {
    expect(SessionPrompt.allowsDelegation(undefined, false)).toBe(true)
    expect(SessionPrompt.allowsDelegation(true, false)).toBe(true)
    expect(SessionPrompt.allowsDelegation(false, true)).toBe(true)
  })

  test("removes automatic delegation when the composer switch is off", () => {
    expect(SessionPrompt.allowsDelegation(false, false)).toBe(false)
  })
})

import { describe, expect, test } from "bun:test"
import { SessionPrompt } from "../../src/session/prompt"

describe("Research delegation compatibility", () => {
  test("both Research efforts retain Task even for legacy switch values", () => {
    expect(SessionPrompt.allowsDelegation(undefined, false)).toBe(true)
    expect(SessionPrompt.allowsDelegation(true, false)).toBe(true)
    expect(SessionPrompt.allowsDelegation(false, true)).toBe(true)
    expect(SessionPrompt.allowsDelegation(false, false)).toBe(true)
  })

  test("effort reminders expose bounded Normal and Ultra behavior", () => {
    expect(SessionPrompt.researchEffortReminder(undefined)).toContain("Research effort: NORMAL")
    expect(SessionPrompt.researchEffortReminder("normal")).toContain("limited to 2")
    expect(SessionPrompt.researchEffortReminder("ultra")).toContain("Research effort: ULTRA")
    expect(SessionPrompt.researchEffortReminder("ultra")).toContain("limited to 4")
  })
})

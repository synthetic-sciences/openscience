import { describe, expect, test } from "bun:test"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"

describe("Research delegation controls", () => {
  test("disables automatic Task calls while preserving explicit @agent requests", () => {
    expect(SessionPrompt.allowsDelegation(undefined, false)).toBe(true)
    expect(SessionPrompt.allowsDelegation(true, false)).toBe(true)
    expect(SessionPrompt.allowsDelegation(false, true)).toBe(true)
    expect(SessionPrompt.allowsDelegation(false, false)).toBe(false)
  })

  test("maps domain specialist selections onto a valid execute phase", () => {
    expect(SessionPrompt.delegationTarget("biology")).toEqual({ profile: "execute", specialist: "biology" })
    expect(SessionPrompt.delegationTarget("physics")).toEqual({ profile: "execute", specialist: "physics" })
    expect(SessionPrompt.delegationTarget("ml")).toEqual({ profile: "execute", specialist: "ml" })
    expect(SessionPrompt.delegationTarget("review")).toEqual({ profile: "execute" })
    expect(SessionPrompt.delegationTarget("legacy-specialist")).toEqual({ profile: "execute" })
  })

  test("effort reminders expose bounded Normal and Ultra behavior", () => {
    expect(SessionPrompt.researchEffortReminder(undefined)).toContain("Research effort: NORMAL")
    expect(SessionPrompt.researchEffortReminder("normal")).toContain("at most 3 Task calls total")
    expect(SessionPrompt.researchEffortReminder("normal")).toContain("including continuations")
    expect(SessionPrompt.researchEffortReminder("ultra")).toContain("Research effort: ULTRA")
    expect(SessionPrompt.researchEffortReminder("ultra")).toContain("at most 8 Task calls total")
    expect(SessionPrompt.researchEffortReminder("normal")).toContain("safe, reversible assumptions")
  })

  test("keeps delegation independent from reasoning effort and permissions", () => {
    const settings = MessageV2.resolveDelegationSettings({
      level: "light",
      workerModel: { providerID: "openrouter", modelID: "worker" },
      autonomy: "autonomous",
      diversity: "exploratory",
    })
    expect(MessageV2.delegationLimit(settings)).toBe(1)
    expect(settings.workerModel?.modelID).toBe("worker")
    expect(SessionPrompt.researchEffortReminder("ultra", settings)).toContain("at most 1 Task calls total")
    expect(SessionPrompt.researchEffortReminder("normal", { ...settings, level: "off" })).toContain(
      "Automatic delegation is off",
    )
  })
})

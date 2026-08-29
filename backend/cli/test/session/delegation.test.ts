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

  test("effort reminders expose natural Normal and Ultra behavior", () => {
    expect(SessionPrompt.researchEffortReminder(undefined)).toContain("Research effort: NORMAL")
    expect(SessionPrompt.researchEffortReminder("ultra")).toContain("Research effort: ULTRA")
    expect(SessionPrompt.researchEffortReminder("normal")).not.toContain("Task calls total")
    expect(SessionPrompt.researchEffortReminder("ultra")).not.toContain("Task calls total")
    expect(SessionPrompt.researchEffortReminder("normal")).toContain("safe, reversible options")
  })

  test("keeps delegation independent from reasoning effort and permissions", () => {
    const settings = MessageV2.resolveDelegationSettings({
      level: "light",
      workerModel: { providerID: "openrouter", modelID: "worker" },
      autonomy: "autonomous",
      diversity: "exploratory",
    })
    expect(settings.workerModel?.modelID).toBe("worker")
    expect(settings).not.toHaveProperty("diversity")
    expect(SessionPrompt.researchEffortReminder("ultra", settings)).not.toContain("Task calls total")
    expect(SessionPrompt.researchEffortReminder("normal", { ...settings, level: "off" })).toContain(
      "Automatic delegation is off",
    )
  })

  test("turn independence maps to an explicit decision policy with a recommendation", () => {
    expect(SessionPrompt.decisionPolicy("interactive")).toMatchObject({
      routine: "decide",
      consequential: "ask",
      blocked: "ask",
    })
    expect(SessionPrompt.decisionPolicy("interactive").instruction).toContain("recommended option first")
    expect(SessionPrompt.decisionPolicy("balanced")).toMatchObject({
      routine: "decide",
      consequential: "ask",
      blocked: "ask",
    })
    expect(SessionPrompt.decisionPolicy("autonomous")).toMatchObject({
      routine: "decide",
      consequential: "decide",
      blocked: "ask",
    })
    expect(SessionPrompt.decisionPolicy("autonomous").instruction).toContain("record the assumption")
  })
})

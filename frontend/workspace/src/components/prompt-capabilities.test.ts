import { describe, expect, test } from "bun:test"
import {
  delegatedSpecialist,
  migrateResearchEffortState,
  normalizeResearchEffort,
  RESEARCH_EFFORTS,
  researchEffortLabel,
} from "./prompt-capabilities"

describe("prompt capabilities", () => {
  test("offers one compact Normal or Ultra research-effort choice", () => {
    expect(RESEARCH_EFFORTS).toEqual(["normal", "ultra"])
    expect(researchEffortLabel("normal")).toBe("Normal")
    expect(researchEffortLabel("ultra")).toBe("Ultra")
  })

  test("fails legacy or malformed effort values closed to Normal", () => {
    expect(normalizeResearchEffort("ultra")).toBe("ultra")
    expect(normalizeResearchEffort("high")).toBe("normal")
    expect(normalizeResearchEffort(undefined)).toBe("normal")
  })

  test("migrates legacy effort shapes while preserving session overrides", () => {
    expect(migrateResearchEffortState("ultra")).toEqual({ workspace: "ultra", sessions: {} })
    expect(
      migrateResearchEffortState({ effort: "ultra", sessions: { first: "normal", second: "unexpected" } }),
    ).toEqual({ workspace: "ultra", sessions: { first: "normal", second: "normal" } })
  })

  test("retains the legacy specialist resolver for stored prompts without exposing it in the composer", () => {
    expect(delegatedSpecialist(true, "biology", [])).toBe("biology")
    expect(delegatedSpecialist(false, "biology", [])).toBeUndefined()
    expect(delegatedSpecialist(true, "biology", ["physics"])).toBeUndefined()
  })
})

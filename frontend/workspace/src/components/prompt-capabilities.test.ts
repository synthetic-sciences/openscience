import { describe, expect, test } from "bun:test"
import { CORE_SPECIALISTS, delegatedSpecialist, isCoreSpecialist, specialistLabel } from "./prompt-capabilities"

describe("prompt capabilities", () => {
  test("forces the selected specialist only while delegation is enabled", () => {
    expect(delegatedSpecialist(true, "biology", [])).toBe("biology")
    expect(delegatedSpecialist(false, "biology", [])).toBeUndefined()
    expect(delegatedSpecialist(true, null, [])).toBeUndefined()
  })

  test("keeps an explicit @specialist mention authoritative", () => {
    expect(delegatedSpecialist(true, "biology", ["physics"])).toBeUndefined()
  })

  test("uses concise product labels", () => {
    expect(specialistLabel("research")).toBe("Research")
    expect(specialistLabel("ml")).toBe("ML")
    expect(specialistLabel("custom-specialist")).toBe("custom specialist")
  })

  test("offers only the three delegated core specialists after Research", () => {
    expect(CORE_SPECIALISTS).toEqual(["biology", "physics", "ml"])
    expect(isCoreSpecialist("biology")).toBe(true)
    expect(isCoreSpecialist("reviewer")).toBe(false)
    expect(isCoreSpecialist("docs")).toBe(false)
  })
})

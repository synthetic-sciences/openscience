import { describe, expect, test } from "bun:test"
import { delegatedSpecialist, isCoreSpecialist, specialistLabel } from "./prompt-capabilities"

describe("prompt capabilities", () => {
  test("keeps the curated scientific specialists readable", () => {
    expect(isCoreSpecialist("biology")).toBe(true)
    expect(isCoreSpecialist("reviewer")).toBe(false)
    expect(specialistLabel("ml")).toBe("ML")
  })

  test("delegates only when enabled and no specialist was explicitly attached", () => {
    expect(delegatedSpecialist(true, "biology", [])).toBe("biology")
    expect(delegatedSpecialist(false, "biology", [])).toBeUndefined()
    expect(delegatedSpecialist(true, "biology", ["physics"])).toBeUndefined()
  })
})

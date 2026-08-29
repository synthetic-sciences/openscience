import { describe, expect, test } from "bun:test"
import { delegatedSpecialist, isCoreSpecialist, sameDelegationModel, specialistLabel } from "./prompt-capabilities"

describe("prompt capabilities", () => {
  test("keeps the curated scientific specialists readable", () => {
    expect(isCoreSpecialist("biology")).toBe(true)
    expect(isCoreSpecialist("critique")).toBe(false)
    expect(specialistLabel("ml")).toBe("ML")
  })

  test("delegates only when enabled and no specialist was explicitly attached", () => {
    expect(delegatedSpecialist(true, "biology", [])).toBe("biology")
    expect(delegatedSpecialist(false, "biology", [])).toBeUndefined()
    expect(delegatedSpecialist(true, "biology", ["physics"])).toBeUndefined()
  })

  test("treats controlled worker-model echoes as no-op selections", () => {
    const worker = { providerID: "openai", modelID: "gpt-5" }
    expect(sameDelegationModel(worker, { ...worker })).toBe(true)
    expect(sameDelegationModel(null, undefined)).toBe(true)
    expect(sameDelegationModel(worker, { ...worker, modelID: "gpt-5-pro" })).toBe(false)
    expect(sameDelegationModel(worker, undefined)).toBe(false)
  })
})

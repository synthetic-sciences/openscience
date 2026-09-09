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

describe("delegation strategy", () => {
  test("defaults to parallel and carries a stored fusion choice with the worker model", async () => {
    const { delegationSettings } = await import("./prompt-capabilities")
    expect(delegationSettings(undefined).strategy).toBe("parallel")
    const fusion = delegationSettings({
      delegation_enabled: true,
      delegation_specialist: null,
      delegation_strategy: "fusion",
      delegation_worker_model: { providerID: "openai", modelID: "gpt-5.6-terra" },
    })
    expect(fusion.strategy).toBe("fusion")
    expect(fusion.workerModel).toEqual({ providerID: "openai", modelID: "gpt-5.6-terra" })
  })
})

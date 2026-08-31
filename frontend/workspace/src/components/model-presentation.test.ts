import { describe, expect, test } from "bun:test"
import { effortOption, modelControl, serviceOption } from "./model-presentation"

describe("model control presentation", () => {
  test("keeps explicit Off separate from the provider's default", () => {
    expect(effortOption("default")).toEqual({ id: "default", label: "Provider default" })
    expect(effortOption("standard")).toEqual({ id: "standard", label: "Provider default" })
    expect(effortOption("none")).toEqual({ id: "none", label: "Off" })
    expect(effortOption("xhigh")).toEqual({ id: "xhigh", label: "Extra high" })
    expect(effortOption("4096-tokens")).toEqual({ id: "4096-tokens", label: "4,096 tokens" })
    const control = modelControl({
      name: "API model",
      variants: ["default", "none", "low", "high"],
      modes: [],
      currentEffort: "none",
    })
    expect(control.effort?.options.map((option) => option.id)).toEqual(["default", "none", "low", "high"])
    expect(control.effort?.current).toEqual({ id: "none", label: "Off" })
    expect(control.reset).toEqual({})
  })

  test("shows only the route's levels without injecting an unsupported standard or Off", () => {
    const control = modelControl({
      name: "Grok 4.6",
      variants: ["low", "medium", "high", "xhigh", "xhigh", ""],
      modes: ["standard", "fast"],
      currentEffort: "high",
      currentSpeed: "fast",
    })
    expect(control.rows).toEqual(["Model", "Effort", "Speed", "Advanced"])
    expect(control.effort?.options.map((option) => option.id)).toEqual(["low", "medium", "high", "xhigh"])
    expect(control.effort?.value).toBe("High")
    expect(control.speed?.value).toBe("Fast")
    expect(control.reset).toEqual({})
  })

  test("labels service tiers independently from effort defaults", () => {
    expect(serviceOption("standard")).toEqual({ id: "standard", label: "Standard" })
    expect(serviceOption("fast")).toEqual({ id: "fast", label: "Fast" })
    const control = modelControl({
      name: "Model",
      variants: ["default", "high"],
      modes: ["standard", "fast"],
      currentEffort: "stale",
      currentSpeed: "stale",
    })
    expect(control.effort?.value).toBe("Provider default")
    expect(control.speed?.value).toBe("Standard")
    expect(control.reset).toEqual({ effort: "default", speed: "standard" })
  })

  test("preserves every supported native level and omits unavailable controls", () => {
    expect(
      modelControl({ name: "Model", variants: ["low", "high", "max", "ultra"], modes: [], currentEffort: "ultra" })
        .effort?.value,
    ).toBe("Ultra")
    const control = modelControl({
      name: "Fixed model",
      variants: [],
      modes: ["standard"],
      advanced: [
        { id: "empty", label: "Empty", options: [] },
        { id: "format", label: "Format", options: ["text", "json"] },
      ],
    })
    expect(control.effort).toBeUndefined()
    expect(control.speed).toBeUndefined()
    expect(control.advanced).toEqual([{ id: "format", label: "Format", options: ["text", "json"] }])
  })
})

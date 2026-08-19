import { describe, expect, test } from "bun:test"
import { effortOption, modelControl, serviceOption } from "./model-presentation"

describe("model control presentation", () => {
  test("orders the consolidated rows and exposes their current values", () => {
    const control = modelControl({
      name: "Claude Opus 4.8",
      variants: ["standard", "high", "xhigh", "xhigh", ""],
      modes: ["standard", "fast", "fast", ""],
      currentEffort: "xhigh",
      currentSpeed: "fast",
      advanced: [],
    })

    expect(control).toEqual({
      rows: ["Model", "Effort", "Speed", "Advanced"],
      trigger: "Claude Opus 4.8",
      model: { label: "Model", value: "Claude Opus 4.8" },
      effort: {
        label: "Effort",
        value: "Extra high",
        current: { id: "xhigh", label: "Extra high" },
        options: [
          { id: "standard", label: "Standard" },
          { id: "high", label: "High" },
          { id: "xhigh", label: "Extra high" },
        ],
      },
      speed: {
        label: "Speed",
        value: "Fast",
        current: { id: "fast", label: "Fast" },
        options: [
          { id: "standard", label: "Standard" },
          { id: "fast", label: "Fast" },
        ],
      },
      advanced: [],
      reset: {},
    })
    expect(JSON.stringify(control)).not.toContain("OpenRouter")
    expect(JSON.stringify(control)).not.toContain("provider")
  })

  test("makes standard effort explicit without changing the provider-native value", () => {
    expect(effortOption("standard")).toEqual({ id: "standard", label: "Standard" })
    expect(effortOption("none")).toEqual({ id: "none", label: "Standard" })
    expect(effortOption("xhigh")).toEqual({ id: "xhigh", label: "Extra high" })
  })

  test("collapses provider none and standard effort into one visible choice", () => {
    const control = modelControl({
      name: "Reasoning model",
      variants: ["none", "standard", "low", "high"],
      modes: [],
      currentEffort: "none",
    })

    expect(control.effort?.options).toEqual([
      { id: "standard", label: "Standard" },
      { id: "low", label: "Low" },
      { id: "high", label: "High" },
    ])
    expect(control.effort?.current).toEqual({ id: "standard", label: "Standard" })
    expect(control.reset).toEqual({ effort: "standard" })
  })

  test("labels service modes without remapping their request values", () => {
    expect(serviceOption("standard")).toEqual({ id: "standard", label: "Standard" })
    expect(serviceOption("fast")).toEqual({ id: "fast", label: "Fast" })
    expect(serviceOption("pro")).toEqual({ id: "pro", label: "Pro" })
  })

  test("filters unsupported selections to valid defaults and reports the reset", () => {
    expect(
      modelControl({
        name: "Valid model",
        variants: ["standard", "high"],
        modes: ["standard", "fast"],
        currentEffort: "ultra",
        currentSpeed: "turbo",
      }),
    ).toMatchObject({
      effort: {
        value: "Standard",
        current: { id: "standard", label: "Standard" },
        options: [
          { id: "standard", label: "Standard" },
          { id: "high", label: "High" },
        ],
      },
      speed: {
        value: "Standard",
        current: { id: "standard", label: "Standard" },
        options: [
          { id: "standard", label: "Standard" },
          { id: "fast", label: "Fast" },
        ],
      },
      reset: { effort: "standard", speed: "standard" },
    })
  })

  test("omits unavailable effort and single-choice speed rows while filtering advanced controls", () => {
    expect(
      modelControl({
        name: "Fixed model",
        variants: [],
        modes: ["standard"],
        currentEffort: "standard",
        currentSpeed: "standard",
        advanced: [
          { id: "temperature", label: "Temperature", options: [] },
          { id: "format", label: "Format", options: ["text", "json"] },
        ],
      }),
    ).toEqual({
      rows: ["Model", "Advanced"],
      trigger: "Fixed model",
      model: { label: "Model", value: "Fixed model" },
      effort: undefined,
      speed: undefined,
      advanced: [{ id: "format", label: "Format", options: ["text", "json"] }],
      reset: {},
    })
  })
})

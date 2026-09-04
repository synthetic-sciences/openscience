import { describe, expect, test } from "bun:test"
import { THRESHOLD_OPTIONS, thresholdLabel, thresholdOptions } from "./context-preferences"

describe("General context preferences", () => {
  test("offers the four auto-compact percentages and keeps a hand-edited value selectable", () => {
    expect([...THRESHOLD_OPTIONS]).toEqual([0.5, 0.6, 0.75, 0.9])
    expect(thresholdOptions(0.75).map((option) => option.label)).toEqual(["50%", "60%", "75%", "90%"])
    expect(thresholdOptions().map((option) => option.value)).toEqual([0.5, 0.6, 0.75, 0.9])
    expect(thresholdOptions(0.8)).toEqual([
      { value: 0.5, label: "50%" },
      { value: 0.6, label: "60%" },
      { value: 0.75, label: "75%" },
      { value: 0.8, label: "80%" },
      { value: 0.9, label: "90%" },
    ])
    expect(thresholdLabel(0.6)).toBe("60%")
  })
})

import { describe, expect, test } from "bun:test"
import {
  THRESHOLD_OPTIONS,
  WARN_TOKENS_MIN,
  parseWarnTokens,
  thresholdLabel,
  thresholdOptions,
} from "./context-preferences"

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

  test("parses the warning token count leniently and rejects anything the backend would refuse", () => {
    expect(WARN_TOKENS_MIN).toBe(1_000)
    expect(parseWarnTokens("120000")).toBe(120_000)
    expect(parseWarnTokens(" 120,000 ")).toBe(120_000)
    expect(parseWarnTokens("120 000")).toBe(120_000)
    expect(parseWarnTokens("80k")).toBe(80_000)
    expect(parseWarnTokens("")).toBeUndefined()
    expect(parseWarnTokens("1.5")).toBeUndefined()
    expect(parseWarnTokens("-5")).toBeUndefined()
    expect(parseWarnTokens("999")).toBeUndefined()
    expect(parseWarnTokens("many")).toBeUndefined()
  })
})

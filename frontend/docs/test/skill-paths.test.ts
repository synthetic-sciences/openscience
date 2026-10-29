import { describe, expect, test } from "bun:test"
import { skillPath } from "../script/skill-paths"

describe("skillPath", () => {
  test("turns Windows glob output into the path form the catalogs are built from", () => {
    // Without this, encodeURIComponent escapes the backslashes and the
    // generated GitHub links become `.../skills/ml-training%5Cmlflow%5CSKILL.md`.
    expect(skillPath("ml-training\\mlflow\\SKILL.md")).toBe("ml-training/mlflow/SKILL.md")
    expect(skillPath("ml-training/mlflow/SKILL.md")).toBe("ml-training/mlflow/SKILL.md")
    expect(skillPath("biology\\cancer-genomics-analysis\\SKILL.md")).toBe("biology/cancer-genomics-analysis/SKILL.md")
  })

  test("leaves anything without separators alone", () => {
    expect(skillPath("SKILL.md")).toBe("SKILL.md")
    expect(skillPath("")).toBe("")
  })
})

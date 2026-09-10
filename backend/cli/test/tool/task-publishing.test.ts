import { describe, expect, test } from "bun:test"
import { publishingBrief } from "../../src/tool/task"

describe("task briefs that publish", () => {
  test("a push, an upload or a pull request stays with the lead", () => {
    expect(publishingBrief("Push results\nCommit the notebook and git push origin main")).toBe(true)
    expect(publishingBrief("Publish dataset\nupload the cleaned dataset to Hugging Face under acme/data")).toBe(true)
    expect(publishingBrief("Release\nopen a pull request with the fix")).toBe(true)
  })

  test("ordinary research language is not publishing", () => {
    expect(publishingBrief("Survey\nfind published benchmarks on protein folding")).toBe(false)
    expect(publishingBrief("Analysis\npush the regression through the full dataset and report coefficients")).toBe(
      false,
    )
    expect(publishingBrief("Docs\nupload notes to the results folder")).toBe(false)
  })
})

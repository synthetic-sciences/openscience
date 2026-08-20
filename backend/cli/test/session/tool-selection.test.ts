import { describe, expect, test } from "bun:test"
import { PermissionNext } from "../../src/permission/next"
import { ToolSelection } from "../../src/session/tool-selection"

describe("tool selection", () => {
  const permission = PermissionNext.fromConfig({
    "*": "allow",
    edit: "deny",
    read: "allow",
  })

  test("applies permission aliases before tools are initialized", () => {
    expect(ToolSelection.enabled("apply_patch", { permission })).toBe(false)
    expect(ToolSelection.enabled("edit", { permission })).toBe(false)
    expect(ToolSelection.enabled("read", { permission })).toBe(true)
  })

  test("applies per-turn tool controls", () => {
    expect(ToolSelection.enabled("read", { permission, tools: { read: false } })).toBe(false)
    expect(ToolSelection.enabled("read", { permission, tools: { "*": false, read: true } })).toBe(false)
  })

  test("removes research-only contracts from unambiguous repository work", () => {
    const input = { agent: "research", message: "Inspect this Git repository branch and run its test suite." }
    expect(ToolSelection.relevant("bash", input)).toBe(true)
    expect(ToolSelection.relevant("compute_job", input)).toBe(false)
    expect(ToolSelection.relevant("python", input)).toBe(false)
    expect(ToolSelection.relevant("provenance_review", input)).toBe(false)
    expect(ToolSelection.relevant("science_search", input)).toBe(false)
  })

  test("keeps the full registry for scientific and mixed work", () => {
    expect(
      ToolSelection.relevant("compute_job", {
        agent: "research",
        message: "Fix the repository pipeline for this genomic dataset experiment.",
      }),
    ).toBe(true)
    expect(ToolSelection.relevant("python", { agent: "research", message: "Analyze this dataset." })).toBe(true)
    expect(ToolSelection.relevant("science_search", { agent: "biology", message: "Fix this file." })).toBe(true)
    expect(ToolSelection.relevant("science_search", { agent: "research", message: "Summarize this source." })).toBe(
      true,
    )
  })

  test("keeps explicitly named or enabled domain capabilities", () => {
    const message = "Use the Python kernel and GPU cluster while fixing this repository."
    expect(ToolSelection.relevant("python", { agent: "research", message })).toBe(true)
    expect(ToolSelection.relevant("compute_job", { agent: "research", message })).toBe(true)
    expect(
      ToolSelection.relevant("research_contract", {
        agent: "research",
        message: "Use Python to calculate the sum of these integers.",
      }),
    ).toBe(false)
    expect(
      ToolSelection.relevant("research_contract", {
        agent: "research",
        message: "Inspect this repository.",
        tools: { research_contract: true },
      }),
    ).toBe(true)
  })
})

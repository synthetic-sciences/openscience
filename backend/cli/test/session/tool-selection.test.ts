import { describe, expect, test } from "bun:test"
import { PermissionNext } from "../../src/permission/next"
import { ToolSelection } from "../../src/session/tool-selection"

describe("tool selection", () => {
  test("keeps the first user turn fresh across assistant tool-loop steps", () => {
    expect(ToolSelection.fresh(["user"])).toBe(true)
    expect(ToolSelection.fresh(["user", "assistant", "assistant"])).toBe(true)
    expect(ToolSelection.fresh(["user", "assistant", "user"])).toBe(false)
  })

  test("compacts only built-in inspection tool descriptions", () => {
    const original = "long global description"
    expect(ToolSelection.description("read", original)).toBe(original)
    expect(ToolSelection.description("read", original, true)).toContain("absolute path")
    expect(ToolSelection.description("grep", original, true)).toContain("regular expression")
    expect(ToolSelection.description("glob", original, true)).toContain("glob pattern")
    expect(ToolSelection.description("invalid", original, true)).toBe(original)
  })

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
    expect(
      ToolSelection.relevant("research_contract", {
        agent: "research",
        message: "Update the Python harness and benchmark the model against a baseline metric.",
      }),
    ).toBe(true)
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

  test("recognizes only fresh self-contained conceptual questions as direct answers", () => {
    expect(
      ToolSelection.direct({
        agent: "research",
        message: "In two sentences, explain why randomization matters in an experiment.",
        fresh: true,
      }),
    ).toBe(true)
    expect(ToolSelection.direct({ agent: "research", message: "What is a p-value?", fresh: true })).toBe(true)
    expect(ToolSelection.direct({ agent: "research", message: "What is the latest trial result?", fresh: true })).toBe(
      false,
    )
    expect(ToolSelection.direct({ agent: "research", message: "Explain this dataset.", fresh: true })).toBe(false)
    expect(ToolSelection.direct({ agent: "research", message: "Explain how Python works.", fresh: true })).toBe(false)
    expect(
      ToolSelection.direct({
        agent: "research",
        message: "Why does randomization matter?",
        fresh: true,
        attachments: true,
      }),
    ).toBe(false)
    expect(ToolSelection.direct({ agent: "research", message: "Why does randomization matter?", fresh: false })).toBe(
      false,
    )
    expect(
      ToolSelection.direct({
        agent: "research",
        message: "Why does randomization matter?",
        fresh: true,
        tools: { python: true },
      }),
    ).toBe(false)
  })

  test("direct answers advertise no implicit tools while explicit enables still win", () => {
    const input = { agent: "research", message: "What is a p-value?", direct: true }
    expect(ToolSelection.relevant("bash", input)).toBe(false)
    expect(ToolSelection.relevant("context7_query-docs", input)).toBe(false)
    expect(ToolSelection.relevant("python", input)).toBe(false)
    expect(ToolSelection.relevant("python", { ...input, tools: { python: true } })).toBe(true)
  })

  test("explicit local read-only inspection advertises only file discovery tools", () => {
    const message =
      "Inspect the root package.json and backend/cli/package.json. Report the exact Bun version and test script. Do not modify any files."
    const tools = [
      "apply_patch",
      "artifact",
      "bash",
      "context7_query-docs",
      "glob",
      "grep",
      "invalid",
      "question",
      "read",
      "skill",
      "task",
      "todowrite",
      "webfetch",
    ]
    expect(tools.filter((tool) => ToolSelection.relevant(tool, { agent: "research", message }))).toEqual([
      "glob",
      "grep",
      "invalid",
      "read",
    ])
    expect(
      ToolSelection.relevant("bash", {
        agent: "research",
        message: "Run the test script, but do not modify any files.",
      }),
    ).toBe(true)
    expect(
      ToolSelection.relevant("webfetch", {
        agent: "research",
        message: "Inspect https://example.com and do not modify any files.",
      }),
    ).toBe(true)
    expect(
      ToolSelection.relevant("webfetch", {
        agent: "research",
        message: "Review package.json for out-of-date dependencies without modifying files.",
      }),
    ).toBe(true)
    expect(
      ToolSelection.relevant("python", {
        agent: "research",
        message: "Inspect dataset.csv and report summary statistics without modifying files.",
      }),
    ).toBe(true)
    expect(
      ToolSelection.relevant("bash", {
        agent: "research",
        message,
        tools: { bash: true },
      }),
    ).toBe(true)
    expect(
      ToolSelection.inspection({
        agent: "research",
        message,
        fresh: true,
      }),
    ).toBe(true)
    expect(
      ToolSelection.inspection({
        agent: "research",
        message,
        fresh: false,
      }),
    ).toBe(false)
    expect(
      ToolSelection.inspection({
        agent: "research",
        message,
        fresh: true,
        tools: { bash: true },
      }),
    ).toBe(false)
  })
})

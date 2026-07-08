import { describe, test, expect } from "bun:test"
import { humanizeToolName, skillName, stripRedactedReasoning } from "./tool-display"

describe("humanizeToolName", () => {
  test("titlecases a simple id", () => {
    expect(humanizeToolName("websearch")).toBe("Websearch")
    expect(humanizeToolName("multi_edit")).toBe("Multi Edit")
  })
  test("splits an mcp namespace_tool id", () => {
    expect(humanizeToolName("playwright_browser_click")).toBe("playwright · browser click")
  })
})

describe("skillName", () => {
  test("prefers metadata.name", () => {
    expect(skillName({ metadata: { name: "deep-research" }, input: { name: "x" } })).toBe("deep-research")
  })
  test("falls back to input.name", () => {
    expect(skillName({ input: { name: "brainstorming" } })).toBe("brainstorming")
  })
  test("strips the title prefix", () => {
    expect(skillName({ title: "Loaded skill: qa" })).toBe("qa")
  })
  test("defaults to 'skill'", () => {
    expect(skillName({})).toBe("skill")
  })
})

describe("stripRedactedReasoning", () => {
  test("drops a whole-encrypted placeholder to empty", () => {
    expect(stripRedactedReasoning("[REDACTED]")).toBe("")
  })
  test("keeps the readable summary, strips the trailing placeholder", () => {
    expect(stripRedactedReasoning("I'll sort it out![REDACTED]")).toBe("I'll sort it out!")
  })
  test("handles multiple placeholders and whitespace", () => {
    expect(stripRedactedReasoning("[REDACTED]\n\n[REDACTED]")).toBe("")
  })
  test("leaves normal reasoning untouched", () => {
    expect(stripRedactedReasoning("plain reasoning text")).toBe("plain reasoning text")
  })
})

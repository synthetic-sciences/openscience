import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { isVisibleSpecialist } from "./specialist-catalog"

const source = () => readFileSync(fileURLToPath(new URL("./Specialists.tsx", import.meta.url)), "utf8")

describe("specialist catalog", () => {
  test("shows built-in subagents while hiding implementation agents and plan mode", () => {
    expect(isVisibleSpecialist({ name: "write" })).toBe(true)
    expect(isVisibleSpecialist({ name: "literature-review" })).toBe(true)
    expect(isVisibleSpecialist({ name: "reviewer" })).toBe(true)
    expect(isVisibleSpecialist({ name: "artifact-reviewer", hidden: true })).toBe(false)
    expect(isVisibleSpecialist({ name: "title" })).toBe(false)
    expect(isVisibleSpecialist({ name: "compaction" })).toBe(false)
    expect(isVisibleSpecialist({ name: "plan" })).toBe(false)
  })

  test("uses sentence case for specialist actions", () => {
    const specialists = source()

    expect(specialists).toContain('label="Add specialist"')
    expect(specialists).toContain('label: "Write from scratch"')
    expect(specialists).toContain('"Create specialist"')
    expect(specialists).toContain('label="Cancel"')
    expect(specialists).not.toContain('label="add specialist"')
  })
})

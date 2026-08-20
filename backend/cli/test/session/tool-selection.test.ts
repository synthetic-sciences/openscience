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
})

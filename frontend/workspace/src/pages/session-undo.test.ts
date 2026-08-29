import { describe, expect, test } from "bun:test"
import { shouldConfirmUndo, undoPreview, undoSummary } from "./session-undo"

describe("session undo preview", () => {
  const messages = [
    { id: "m1", role: "user" as const },
    { id: "m2", role: "assistant" as const },
    { id: "m3", role: "user" as const },
    { id: "m4", role: "assistant" as const },
  ]
  const parts = {
    m2: [{ type: "patch", files: ["/repo/a.txt", "/repo/b.txt"] }],
    m4: [{ type: "patch", files: ["/repo/b.txt", "/repo/nested/c.txt"] }, { type: "text" }],
  }

  test("previews every affected turn and deduplicated project-relative file", () => {
    expect(undoPreview(messages, parts, "m1", "/repo")).toEqual({
      turns: 2,
      files: ["a.txt", "b.txt", "nested/c.txt"],
    })
    expect(undoPreview(messages, parts, "m3", "/repo")).toEqual({
      turns: 1,
      files: ["b.txt", "nested/c.txt"],
    })
  })

  test("confirms multi-turn or file-changing undo but keeps a plain last turn immediate", () => {
    expect(shouldConfirmUndo({ turns: 1, files: [] })).toBe(false)
    expect(shouldConfirmUndo({ turns: 2, files: [] })).toBe(true)
    expect(shouldConfirmUndo({ turns: 1, files: ["a.txt"] })).toBe(true)
  })

  test("formats compact stable counts", () => {
    expect(undoSummary({ turns: 1, files: ["a.txt"] })).toBe("1 turn · 1 file")
    expect(undoSummary({ turns: 2, files: [] })).toBe("2 turns · 0 files")
  })
})

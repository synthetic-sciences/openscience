import { describe, expect, test } from "bun:test"
import { sessionEntryTarget, type SessionEntry } from "./session-entry"

describe("project session entry", () => {
  test("resumes the remembered root session when it is still available", () => {
    const sessions: SessionEntry[] = [
      { id: "ses_old", time: { updated: 10 } },
      { id: "ses_new", time: { updated: 20 } },
    ]

    expect(sessionEntryTarget(sessions, "ses_old")).toBe("ses_old")
  })

  test("falls back to the most recently active root session", () => {
    const sessions: SessionEntry[] = [
      { id: "ses_archived", time: { updated: 50, archived: 51 } },
      { id: "ses_child", parentID: "ses_parent", time: { updated: 40 } },
      { id: "ses_recent", time: { created: 5, updated: 30 } },
      { id: "ses_older", time: { created: 10, updated: 20 } },
    ]

    expect(sessionEntryTarget(sessions, "ses_missing")).toBe("ses_recent")
  })

  test("starts new research only when no root session can be resumed", () => {
    expect(sessionEntryTarget([], undefined)).toBe("new")
    expect(sessionEntryTarget([{ id: "ses_child", parentID: "ses_parent" }], undefined)).toBe("new")
  })
})

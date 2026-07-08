import { describe, test, expect } from "bun:test"
import { activeSubagents, subagentStatusKind, activeCount } from "./subagents"

const s = (id: string, parentID: string | undefined, updated: number, title = id) => ({
  id,
  parentID,
  title,
  time: { updated },
})

describe("subagentStatusKind", () => {
  test("busy → active, retry → pending, idle/missing → done", () => {
    expect(subagentStatusKind({ type: "busy" })).toBe("active")
    expect(subagentStatusKind({ type: "retry" })).toBe("pending")
    expect(subagentStatusKind({ type: "idle" })).toBe("done")
    expect(subagentStatusKind(undefined)).toBe("done")
  })
})

describe("activeSubagents", () => {
  test("filters by parent, joins status, sorts recent first", () => {
    const sessions = [s("c1", "p", 10), s("c2", "p", 30), s("root", undefined, 99), s("other", "q", 50)]
    const statuses = { c1: { type: "busy" }, c2: { type: "idle" } }
    const rows = activeSubagents(sessions as any, statuses as any, "p")
    expect(rows.map((r) => r.sessionId)).toEqual(["c2", "c1"])
    expect(rows.find((r) => r.sessionId === "c1")!.status).toBe("active")
    expect(activeCount(rows)).toBe(1)
  })
})

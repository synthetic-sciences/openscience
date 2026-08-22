import { describe, expect, test } from "bun:test"
import { SessionProcessor } from "../../src/session/processor"

const tool = (name: string, input: unknown, status = "completed"): any => ({
  type: "tool",
  tool: name,
  callID: "c",
  state: { status, input },
})
const reasoning = (): any => ({ type: "reasoning", text: "thinking..." })
const text = (): any => ({ type: "text", text: "hi" })
const message = (id: string, parentID: string, parts: any[]): any => ({
  info: { id, role: "assistant", parentID },
  parts,
})

describe("SessionProcessor.isDoomLoop", () => {
  test("fires when the last 3 TOOL calls are identical, even with reasoning/text between them", () => {
    // A reasoning model interleaves a reasoning part before every tool call —
    // the old last-3-raw-parts check never saw 3 consecutive tool parts.
    const parts = [
      reasoning(),
      tool("bash", { cmd: "ls" }),
      reasoning(),
      tool("bash", { cmd: "ls" }),
      text(),
      reasoning(),
      tool("bash", { cmd: "ls" }),
    ]
    expect(SessionProcessor.isDoomLoop(parts, "bash", { cmd: "ls" })).toBe(true)
  })

  test("does not fire when the inputs differ", () => {
    const parts = [tool("bash", { cmd: "a" }), tool("bash", { cmd: "b" }), tool("bash", { cmd: "c" })]
    expect(SessionProcessor.isDoomLoop(parts, "bash", { cmd: "c" })).toBe(false)
  })

  test("does not fire below the threshold of 3 tool calls", () => {
    const parts = [reasoning(), tool("bash", { cmd: "ls" }), reasoning(), tool("bash", { cmd: "ls" })]
    expect(SessionProcessor.isDoomLoop(parts, "bash", { cmd: "ls" })).toBe(false)
  })

  test("does not fire when a different tool breaks the streak", () => {
    const parts = [tool("bash", { cmd: "ls" }), tool("read", { path: "x" }), tool("bash", { cmd: "ls" })]
    expect(SessionProcessor.isDoomLoop(parts, "bash", { cmd: "ls" })).toBe(false)
  })

  test("ignores a pending tool call (not yet a confirmed repeat)", () => {
    const parts = [tool("bash", { cmd: "ls" }), tool("bash", { cmd: "ls" }), tool("bash", { cmd: "ls" }, "pending")]
    expect(SessionProcessor.isDoomLoop(parts, "bash", { cmd: "ls" })).toBe(false)
  })

  test("sees repeated calls spread across assistant steps for one user request", () => {
    const messages = [
      message("assistant-1", "user-1", [reasoning(), tool("invalid", { tool: "bash", error: "incomplete" })]),
      message("assistant-2", "user-1", [text(), tool("invalid", { tool: "bash", error: "incomplete" })]),
      message("assistant-other", "user-2", [tool("invalid", { tool: "bash", error: "incomplete" })]),
    ]
    const parts = SessionProcessor.turnParts(messages, "user-1")
    expect(SessionProcessor.isDoomLoop(parts, "invalid", { tool: "bash", error: "incomplete" }, 2)).toBe(true)
    expect(parts).toHaveLength(4)
  })
})

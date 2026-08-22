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
const user = (id: string, epoch: string): any => ({
  info: { id, role: "user", internal: id === epoch ? { type: "prompt", epoch } : { type: "continuation", epoch } },
  parts: id === epoch ? [{ type: "text", text: "external prompt" }] : [],
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

  test("keys malformed calls by canonical tool and failure class instead of provider error text", () => {
    const parts = [
      tool("invalid", { tool: "BASH", failure: "invalid_input", error: "raw validator payload one" }),
      tool("invalid", { tool: "bash", failure: "invalid_input", error: "different raw validator payload" }),
    ]
    expect(
      SessionProcessor.isMalformedLoop(parts, {
        tool: "bash",
        failure: "invalid_input",
        error: "third provider rendering",
      }),
    ).toBe(true)
    expect(SessionProcessor.isMalformedLoop(parts, { tool: "bash", failure: "unknown_tool" })).toBe(false)
    expect(SessionProcessor.isMalformedLoop(parts, { tool: "read", failure: "invalid_input" })).toBe(false)
  })

  test("restores malformed-call accounting across continuation and compaction messages in one durable epoch", () => {
    const messages = [
      user("epoch-1", "epoch-1"),
      message("assistant-1", "epoch-1", [tool("invalid", { tool: "bash", failure: "invalid_input" })]),
      user("continuation-1", "epoch-1"),
      message("assistant-2", "continuation-1", [tool("invalid", { tool: "bash", failure: "invalid_input" })]),
    ]
    const parts = SessionProcessor.turnParts(messages, "continuation-1")
    expect(parts).toHaveLength(2)
    expect(SessionProcessor.isMalformedLoop(parts, { tool: "bash", failure: "invalid_input" })).toBe(true)
  })

  test("orders a newest-first durable transcript before evaluating the malformed-call breaker", () => {
    const messages = [
      message("assistant-2", "continuation-1", [tool("invalid", { tool: "bash", failure: "invalid_input" })]),
      user("continuation-1", "epoch-1"),
      message("assistant-1", "epoch-1", [tool("invalid", { tool: "bash", failure: "invalid_input" })]),
      user("epoch-1", "epoch-1"),
    ]
    const parts = SessionProcessor.turnParts(messages, "continuation-1")
    expect(parts).toHaveLength(2)
    expect(SessionProcessor.isMalformedLoop(parts, { tool: "bash", failure: "invalid_input" })).toBe(true)
  })

  test("does not carry malformed-call accounting into a fresh external prompt epoch", () => {
    const messages = [
      user("epoch-1", "epoch-1"),
      message("assistant-1", "epoch-1", [tool("invalid", { tool: "bash", failure: "invalid_input" })]),
      user("epoch-2", "epoch-2"),
      message("assistant-2", "epoch-2", [tool("invalid", { tool: "bash", failure: "invalid_input" })]),
    ]
    const parts = SessionProcessor.turnParts(messages, "epoch-2")
    expect(parts).toHaveLength(1)
    expect(SessionProcessor.isMalformedLoop(parts, { tool: "bash", failure: "invalid_input" })).toBe(false)
  })
})

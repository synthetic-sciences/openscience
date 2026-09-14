import { describe, expect, test } from "bun:test"
import type { Part, ToolPart } from "@synsci/sdk/v2/client"
import { liveActivity, toolDetail } from "./session-turn-live"

const tool = (name: string, state: Partial<ToolPart["state"]>, input: Record<string, unknown> = {}) =>
  ({
    id: `prt_${name}`,
    sessionID: "ses_l",
    messageID: "msg_l",
    type: "tool",
    tool: name,
    callID: `call_${name}`,
    state: { status: "running", input, time: { start: 5_000 }, ...state },
  }) as unknown as ToolPart

describe("the live line", () => {
  test("names the running call and what it works on, with its own start time", () => {
    expect(
      liveActivity([
        tool("read", { status: "completed", time: { start: 1_000, end: 2_000 } } as never, { filePath: "/p/a.md" }),
        tool("bash", { title: "Install current Transformers" }),
      ]),
    ).toEqual({ label: "Running Install current Transformers", since: 5_000 })
    expect(liveActivity([tool("read", {}, { filePath: "/research/creative_rl/judge.py" })])?.label).toBe(
      "Reading judge.py",
    )
    expect(liveActivity([tool("grep", {}, { pattern: "cite" })])?.label).toBe("Searching cite")
    expect(liveActivity([tool("task", {}, { description: "Build policy training backend" })])?.label).toBe(
      "Delegating Build policy training backend",
    )
    expect(liveActivity([tool("query_uniprot", {}, { query: "P69905" })])?.label).toBe("Using query uniprot P69905")
  })

  test("falls back to the phase the model is in, and to nothing while the provider is silent", () => {
    const reasoning = {
      id: "r",
      sessionID: "s",
      messageID: "m",
      type: "reasoning",
      text: "…",
      time: { start: 3 },
    } as Part
    const writing = { id: "t", sessionID: "s", messageID: "m", type: "text", text: "The", time: { start: 4 } } as Part
    expect(liveActivity([reasoning])).toEqual({ label: "Thinking", since: 3 })
    expect(liveActivity([reasoning, writing])).toEqual({ label: "Writing", since: 4 })
    const finished = { ...reasoning, time: { start: 3, end: 9 } } as Part
    expect(liveActivity([finished])).toBeUndefined()
    expect(liveActivity([tool("read", { status: "pending", input: {} } as never)])).toBeUndefined()
    expect(liveActivity([])).toBeUndefined()
  })

  test("a tool's detail prefers its recorded title and truncates a long first line", () => {
    const long = "x".repeat(100)
    expect(toolDetail(tool("bash", {}, { command: `${long}\nsecond line` }))).toBe(`${"x".repeat(71)}…`)
    expect(toolDetail(tool("bash", { title: "Short" }, { command: long }))).toBe("Short")
  })
})

import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { Token } from "../../src/util/token"
import type { Provider } from "../../src/provider/provider"

const sessionID = "session"

const model = {
  id: "test-model",
  providerID: "test",
  api: { id: "test-model", url: "https://example.com", npm: "@ai-sdk/openai" },
  name: "Test",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  limit: { context: 0, input: 0, output: 0 },
  options: {},
} as unknown as Provider.Model

function assistantInfo(id: string, parentID: string): MessageV2.Assistant {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 0 },
    parentID,
    modelID: "test-model",
    providerID: "test",
    mode: "",
    agent: "agent",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as MessageV2.Assistant
}

const completedTool = (
  tool: string,
  input: Record<string, unknown>,
  output: string,
  opts?: { title?: string; compacted?: boolean; attachments?: MessageV2.FilePart[] },
): MessageV2.ToolStateCompleted => ({
  status: "completed",
  input,
  output,
  title: opts?.title ?? "",
  metadata: {},
  time: { start: 0, end: 1, ...(opts?.compacted ? { compacted: 2 } : {}) },
  ...(opts?.attachments ? { attachments: opts.attachments } : {}),
})

const toolPart = (messageID: string, id: string, tool: string, state: MessageV2.ToolStateCompleted): MessageV2.Part =>
  ({ id, sessionID, messageID, type: "tool", callID: id, tool, state }) as MessageV2.Part

describe("session.message-v2.toolSummary", () => {
  test("uses the title as the descriptor and reports the output line count", () => {
    const s = MessageV2.toolSummary("bash", completedTool("bash", { command: "npm test" }, "a\nb\nc", { title: "npm test" }))
    expect(s).toBe("[bash] npm test → cleared (3 lines)")
  })

  test("falls back to key=value args when there is no title", () => {
    const s = MessageV2.toolSummary("bash", completedTool("bash", { command: "ls" }, "x"))
    expect(s).toBe("[bash] command=ls → cleared (1 line)")
  })

  test("reports zero lines for empty output and omits an empty descriptor", () => {
    const s = MessageV2.toolSummary("read", completedTool("read", {}, ""))
    expect(s).toBe("[read] → cleared (0 lines)")
  })
})

describe("session.message-v2.toModelMessages — compacted tool rendering (P2.2)", () => {
  test("a compacted tool part renders the 1-line tool-aware summary, not the blunt stub", () => {
    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo("a1", "u1"),
        parts: [toolPart("a1", "t1", "bash", completedTool("bash", { command: "npm test" }, "a\nb\nc", { title: "npm test", compacted: true }))],
      },
    ]
    const s = JSON.stringify(MessageV2.toModelMessages(input, model))
    expect(s).toContain("[bash] npm test → cleared (3 lines)")
    expect(s).not.toContain("[Old tool result content cleared]")
  })

  test("a non-compacted tool part still renders its full output", () => {
    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo("a1", "u1"),
        parts: [toolPart("a1", "t1", "bash", completedTool("bash", { command: "npm test" }, "full output here", { title: "npm test" }))],
      },
    ]
    const s = JSON.stringify(MessageV2.toModelMessages(input, model))
    expect(s).toContain("full output here")
    expect(s).not.toContain("cleared")
  })
})

describe("session.message-v2.truncateArgs (P2.3)", () => {
  test("truncates a string value longer than the cap and marks how much was dropped", () => {
    const out = MessageV2.truncateArgs({ content: "x".repeat(1000) }, 200)
    expect(out.content).toBe("x".repeat(200) + "…[+800 chars]")
  })

  test("leaves short strings and non-string values untouched", () => {
    const out = MessageV2.truncateArgs({ filePath: "/a", count: 5, deep: { a: 1 } }, 200)
    expect(out).toEqual({ filePath: "/a", count: 5, deep: { a: 1 } })
  })
})

describe("session.message-v2.toModelMessages — compacted tool args (P2.3)", () => {
  test("truncates oversized args of a compacted tool call, keeps small ones", () => {
    const state = completedTool("write", { filePath: "/a", content: "x".repeat(1000) }, "ok", { compacted: true })
    const input: MessageV2.WithParts[] = [{ info: assistantInfo("a1", "u1"), parts: [toolPart("a1", "t1", "write", state)] }]
    const s = JSON.stringify(MessageV2.toModelMessages(input, model))
    expect(s).not.toContain("x".repeat(1000))
    expect(s).toContain("chars]") // truncation marker present
    expect(s).toContain("/a") // small arg preserved
  })

  test("does NOT truncate args of a live (non-compacted) tool call", () => {
    const state = completedTool("write", { filePath: "/a", content: "x".repeat(1000) }, "ok")
    const input: MessageV2.WithParts[] = [{ info: assistantInfo("a1", "u1"), parts: [toolPart("a1", "t1", "write", state)] }]
    const s = JSON.stringify(MessageV2.toModelMessages(input, model))
    expect(s).toContain("x".repeat(1000))
  })
})

describe("session.message-v2.supersededOutputs (P2.1)", () => {
  const two = (o1: string, o2: string, attach?: MessageV2.FilePart[]): MessageV2.WithParts[] => [
    { info: assistantInfo("a1", "u1"), parts: [toolPart("a1", "t1", "read", completedTool("read", { p: "x" }, o1, { attachments: attach }))] },
    { info: assistantInfo("a2", "u1"), parts: [toolPart("a2", "t2", "read", completedTool("read", { p: "x" }, o2))] },
  ]

  test("marks the older of two identical outputs as superseded, keeps the newest", () => {
    const set = MessageV2.supersededOutputs(two("y".repeat(300), "y".repeat(300)), 200)
    expect(set.has("t1")).toBe(true)
    expect(set.has("t2")).toBe(false)
  })

  test("does not dedupe distinct outputs", () => {
    const set = MessageV2.supersededOutputs(two("a".repeat(300), "b".repeat(300)), 200)
    expect(set.size).toBe(0)
  })

  test("does not dedupe outputs shorter than the minimum", () => {
    const set = MessageV2.supersededOutputs(two("z".repeat(50), "z".repeat(50)), 200)
    expect(set.size).toBe(0)
  })

  test("does not dedupe a part that carries attachments", () => {
    const att = [{ id: "att", sessionID, messageID: "a1", type: "file", mime: "image/png", filename: "x.png", url: "data:image/png;base64,Zm9v" }] as unknown as MessageV2.FilePart[]
    const set = MessageV2.supersededOutputs(two("y".repeat(300), "y".repeat(300), att), 200)
    expect(set.size).toBe(0)
  })
})

describe("session.message-v2.toModelMessages — duplicate output back-reference (P2.1)", () => {
  test("the older identical output becomes a back-reference; the newest keeps the full body", () => {
    const big = "y".repeat(300)
    const input: MessageV2.WithParts[] = [
      { info: assistantInfo("a1", "u1"), parts: [toolPart("a1", "t1", "read", completedTool("read", { p: "x" }, big))] },
      { info: assistantInfo("a2", "u1"), parts: [toolPart("a2", "t2", "read", completedTool("read", { p: "x" }, big))] },
    ]
    const s = JSON.stringify(MessageV2.toModelMessages(input, model))
    expect(s.split(big).length - 1).toBe(1) // full body shipped exactly once (the newest)
    expect(s).toContain("Duplicate tool output")
  })
})

describe("session.message-v2.composition — stays in sync with compacted rendering", () => {
  test("a compacted tool counts the summary length, matching what is actually sent", () => {
    const state = completedTool("bash", { command: "npm test" }, "a\nb\nc", { title: "npm test", compacted: true })
    const input: MessageV2.WithParts[] = [{ info: assistantInfo("a1", "u1"), parts: [toolPart("a1", "t1", "bash", state)] }]
    const summary = MessageV2.toolSummary("bash", state)
    const expected = Token.estimate(JSON.stringify(state.input)) + Token.estimate(summary)
    expect(MessageV2.composition(input).tool).toBe(expected)
  })
})

import { expect, test } from "bun:test"
import type { AssistantMessage, Message, Part, TextPart, ToolPart, UserMessage } from "@synsci/sdk/v2/client"
import { contextComposition } from "./context-composition"

const user = (id: string, system?: string): UserMessage => ({
  id,
  role: "user",
  sessionID: "session",
  time: { created: 1 },
  agent: "research",
  model: { providerID: "provider", modelID: "model" },
  system,
})
const assistant = (id: string, parentID = "user"): AssistantMessage => ({
  id,
  parentID,
  role: "assistant",
  sessionID: "session",
  time: { created: 2, completed: 3 },
  modelID: "model",
  providerID: "provider",
  mode: "research",
  agent: "research",
  path: { cwd: "/project", root: "/project" },
  cost: 0,
  tokens: { input: 100, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
  finish: "stop",
})
const text = (messageID: string, value: string, ignored = false): TextPart => ({
  id: `${messageID}-text`,
  sessionID: "session",
  messageID,
  type: "text",
  text: value,
  ignored,
})
const tool = (messageID: string, compacted?: number): ToolPart => ({
  id: `${messageID}-tool`,
  sessionID: "session",
  messageID,
  type: "tool",
  tool: "read",
  callID: "call",
  state: {
    status: "completed",
    input: { path: "a".repeat(120) },
    output: "data".repeat(100),
    metadata: {},
    title: "Read data",
    time: { start: 1, end: 2, compacted },
  },
})

test("the first call excludes its own output and later messages or instructions", () => {
  const call = assistant("answer")
  const messages: Message[] = [user("user"), call, user("next", "future instructions")]
  const parts = {
    user: [text("user", "data")],
    answer: [text("answer", "A long generated answer".repeat(500))],
    next: [text("next", "future prompt".repeat(50))],
  }
  expect(contextComposition(messages, parts, call)).toEqual([{ key: "user", tokens: 1, share: 1 }])
})

test("available text shares do not pretend to allocate input or cached provider tokens", () => {
  const call = assistant("answer")
  const messages = [user("user", "rule"), call]
  const parts = { user: [text("user", "data")] }
  const expected: ReturnType<typeof contextComposition> = [
    { key: "instructions", tokens: 1, share: 0.5 },
    { key: "user", tokens: 1, share: 0.5 },
  ]
  expect(contextComposition(messages, parts, call)).toEqual(expected)
  expect(
    contextComposition(messages, parts, {
      ...call,
      tokens: { input: 0, output: 90_000, reasoning: 30_000, cache: { read: 200_000, write: 50_000 } },
    }),
  ).toEqual(expected)
})

test("tool estimates use actual argument content and omit pruned output", () => {
  const call = assistant("answer")
  const messages = [user("user"), assistant("step"), call]
  const normal = tool("step")
  const compacted = tool("step", 123)
  const full = contextComposition(messages, { step: [normal] }, call)
  const pruned = contextComposition(messages, { step: [compacted] }, call)
  expect(full[0]?.tokens).toBe(Math.ceil((4 + JSON.stringify(normal.state.input).length + 400) / 4))
  expect(pruned[0]?.tokens).toBe(Math.ceil((4 + JSON.stringify(normal.state.input).length) / 4))
  expect(full[0]!.tokens - pruned[0]!.tokens).toBe(100)
})

test("ignored text, media, reasoning, and pending tool calls are not invented as input text", () => {
  const call = assistant("answer")
  const messages = [user("user"), assistant("step"), call]
  const pending = tool("step")
  pending.state = { status: "pending", input: {}, raw: "not yet executed" }
  const parts: Record<string, Part[]> = {
    user: [text("user", "hidden".repeat(500), true)],
    step: [
      pending,
      {
        id: "reason",
        sessionID: "session",
        messageID: "step",
        type: "reasoning",
        text: "thoughts",
        time: { start: 1 },
      },
      {
        id: "image",
        sessionID: "session",
        messageID: "step",
        type: "file",
        mime: "image/png",
        url: "data:image/png;base64,AA==",
      },
    ],
  }
  expect(contextComposition(messages, parts, call)).toEqual([])
})

test("a completed compaction excludes replaced history while preserving its declared tail", () => {
  const call = assistant("answer", "next")
  const summary = { ...assistant("summary", "carrier"), summary: true, tailStartId: "tail" }
  const messages = [user("old"), user("tail"), user("carrier"), summary, user("next"), call]
  const parts: Record<string, Part[]> = {
    old: [text("old", "replaced".repeat(500))],
    tail: [text("tail", "tail")],
    carrier: [{ id: "compaction", messageID: "carrier", sessionID: "session", type: "compaction", auto: true }],
    summary: [text("summary", "memo")],
    next: [text("next", "next")],
    answer: [text("answer", "new output")],
  }
  expect(contextComposition(messages, parts, call)).toEqual([
    { key: "user", tokens: 2, share: 2 / 3 },
    { key: "assistant", tokens: 1, share: 1 / 3 },
  ])
  expect(
    contextComposition(
      messages.map((message) => (message.id === summary.id ? { ...summary, tailStartId: undefined } : message)),
      parts,
      call,
    ),
  ).toEqual([
    { key: "user", tokens: 1, share: 0.5 },
    { key: "assistant", tokens: 1, share: 0.5 },
  ])
})

test("an unsuccessful empty summary does not erase available history", () => {
  const call = assistant("answer", "next")
  const summary = { ...assistant("summary", "carrier"), summary: true }
  const messages = [user("old"), user("carrier"), summary, user("next"), call]
  expect(contextComposition(messages, { old: [text("old", "data")] }, call)).toEqual([
    { key: "user", tokens: 1, share: 1 },
  ])
  expect(contextComposition(messages, {}, call)).toEqual([])
  expect(contextComposition(messages, { old: [text("old", "data")] }, summary)).toEqual([])
  expect(contextComposition([], {}, call)).toEqual([])
})

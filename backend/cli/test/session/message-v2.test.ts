import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import type { Provider } from "../../src/provider/provider"

const sessionID = "session"
const model: Provider.Model = {
  id: "test-model",
  providerID: "test",
  api: {
    id: "test-model",
    url: "https://example.com",
    npm: "@ai-sdk/openai",
  },
  name: "Test Model",
  capabilities: {
    temperature: true,
    reasoning: false,
    attachment: false,
    toolcall: true,
    input: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    output: {
      text: true,
      audio: false,
      image: false,
      video: false,
      pdf: false,
    },
    interleaved: false,
  },
  cost: {
    input: 0,
    output: 0,
    cache: {
      read: 0,
      write: 0,
    },
  },
  limit: {
    context: 0,
    input: 0,
    output: 0,
  },
  status: "active",
  options: {},
  headers: {},
  release_date: "2026-01-01",
}

function userInfo(id: string): MessageV2.User {
  return {
    id,
    sessionID,
    role: "user",
    time: { created: 0 },
    agent: "user",
    model: { providerID: "test", modelID: "test" },
    tools: {},
    mode: "",
  } as unknown as MessageV2.User
}

function assistantInfo(
  id: string,
  parentID: string,
  error?: MessageV2.Assistant["error"],
  meta?: { providerID: string; modelID: string },
): MessageV2.Assistant {
  const infoModel = meta ?? { providerID: model.providerID, modelID: model.api.id }
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 0 },
    error,
    parentID,
    modelID: infoModel.modelID,
    providerID: infoModel.providerID,
    mode: "",
    agent: "agent",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  } as unknown as MessageV2.Assistant
}

function basePart(messageID: string, id: string) {
  return {
    id,
    sessionID,
    messageID,
  }
}

describe("session.message-v2.isContinuing", () => {
  test("tool-calls and unknown mean the agent will keep working", () => {
    expect(MessageV2.isContinuing("tool-calls")).toBe(true)
    expect(MessageV2.isContinuing("unknown")).toBe(true)
  })

  test("stop / length / other finish reasons are a completed turn", () => {
    expect(MessageV2.isContinuing("stop")).toBe(false)
    expect(MessageV2.isContinuing("length")).toBe(false)
    expect(MessageV2.isContinuing("content-filter")).toBe(false)
  })

  test("a missing finish reason is not a continuation", () => {
    expect(MessageV2.isContinuing(undefined)).toBe(false)
    expect(MessageV2.isContinuing("")).toBe(false)
  })
})

describe("session.message-v2.toModelMessage — media budgeting", () => {
  const imagePart = (id: string, name: string) => ({
    ...basePart("m-imgs", id),
    type: "file" as const,
    mime: "image/png",
    filename: name,
    url: "data:image/png;base64,Zm9v",
  })
  const imagesInput = (): MessageV2.WithParts[] => [
    {
      info: userInfo("m-imgs"),
      parts: [imagePart("i1", "a.png"), imagePart("i2", "b.png"), imagePart("i3", "c.png")] as MessageV2.Part[],
    },
  ]

  test("keepRecentImages keeps only the last N images; older ones become placeholders", () => {
    const out = MessageV2.toModelMessages(imagesInput(), model, { keepRecentImages: 1 })
    const s = JSON.stringify(out)
    expect((s.match(/"type":"file"/g) ?? []).length).toBe(1) // only the newest image kept in full
    expect((s.match(/older image omitted/g) ?? []).length).toBe(2) // the two older ones stripped
  })

  test("stripMedia replaces every image with a placeholder (compaction summary path)", () => {
    const out = MessageV2.toModelMessages(imagesInput(), model, { stripMedia: true })
    const s = JSON.stringify(out)
    expect(s).not.toContain('"type":"file"')
    expect((s.match(/image omitted/g) ?? []).length).toBe(3)
    expect(s).not.toContain("Zm9v") // no base64 reaches the summarizer
  })

  test("no options → all images pass through unchanged (back-compat)", () => {
    const s = JSON.stringify(MessageV2.toModelMessages(imagesInput(), model))
    expect((s.match(/"type":"file"/g) ?? []).length).toBe(3)
    expect(s).not.toContain("image omitted")
  })
})

describe("session.message-v2.toModelMessage", () => {
  test("filters out messages with no parts", () => {
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo("m-empty"),
        parts: [],
      },
      {
        info: userInfo("m-user"),
        parts: [
          {
            ...basePart("m-user", "p1"),
            type: "text",
            text: "hello",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ])
  })

  test("filters out messages with only ignored parts", () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "ignored",
            ignored: true,
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("includes synthetic text parts", () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "hello",
            synthetic: true,
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo("m-assistant", messageID),
        parts: [
          {
            ...basePart("m-assistant", "a1"),
            type: "text",
            text: "assistant",
            synthetic: true,
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "assistant" }],
      },
    ])
  })

  test("converts user text/file parts and injects compaction/subtask prompts", () => {
    const messageID = "m-user"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(messageID),
        parts: [
          {
            ...basePart(messageID, "p1"),
            type: "text",
            text: "hello",
          },
          {
            ...basePart(messageID, "p2"),
            type: "text",
            text: "ignored",
            ignored: true,
          },
          {
            ...basePart(messageID, "p3"),
            type: "file",
            mime: "image/png",
            filename: "img.png",
            url: "https://example.com/img.png",
          },
          {
            ...basePart(messageID, "p4"),
            type: "file",
            mime: "text/plain",
            filename: "note.txt",
            url: "https://example.com/note.txt",
          },
          {
            ...basePart(messageID, "p5"),
            type: "file",
            mime: "application/x-directory",
            filename: "dir",
            url: "https://example.com/dir",
          },
          {
            ...basePart(messageID, "p6"),
            type: "compaction",
            auto: true,
          },
          {
            ...basePart(messageID, "p7"),
            type: "subtask",
            prompt: "prompt",
            description: "desc",
            agent: "agent",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [
          { type: "text", text: "hello" },
          {
            type: "file",
            mediaType: "image/png",
            filename: "img.png",
            data: "https://example.com/img.png",
          },
          { type: "text", text: "What did we do so far?" },
          { type: "text", text: "The following tool was executed by the user" },
        ],
      },
    ])
  })

  test("converts assistant tool completion into tool-call + tool-result messages with attachments", () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "done",
            metadata: { openai: { assistant: "meta" } },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "ok",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1 },
              attachments: [
                {
                  ...basePart(assistantID, "file-1"),
                  type: "file",
                  mime: "image/png",
                  filename: "attachment.png",
                  url: "data:image/png;base64,Zm9v",
                },
              ],
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "done", providerOptions: { openai: { assistant: "meta" } } },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: {
              type: "content",
              value: [
                { type: "text", text: "ok" },
                { type: "media", mediaType: "image/png", data: "Zm9v" },
              ],
            },
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
    ])
  })

  test("omits provider metadata when assistant model differs", () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID, undefined, { providerID: "other", modelID: "other" }),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "done",
            metadata: { openai: { assistant: "meta" } },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "ok",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1 },
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          { type: "text", text: "done" },
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "ok" },
          },
        ],
      },
    ])
  })

  test("replaces compacted tool output with a 1-line tool-aware summary", () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "completed",
              input: { cmd: "ls" },
              output: "this should be cleared",
              title: "Bash",
              metadata: {},
              time: { start: 0, end: 1, compacted: 1 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "text", value: "[bash] Bash → cleared (1 line)" },
          },
        ],
      },
    ])
  })

  test("converts assistant tool error into error-text tool result", () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "error",
              input: { cmd: "ls" },
              error: "nope",
              time: { start: 0, end: 1 },
              metadata: {},
            },
            metadata: { openai: { tool: "meta" } },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-1",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-1",
            toolName: "bash",
            output: { type: "error-text", value: "nope" },
            providerOptions: { openai: { tool: "meta" } },
          },
        ],
      },
    ])
  })

  test("filters assistant messages with non-abort errors", () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(
          assistantID,
          "m-parent",
          new MessageV2.APIError({ message: "boom", isRetryable: true }).toObject() as MessageV2.APIError,
        ),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "text",
            text: "should not render",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("includes aborted assistant messages only when they have non-step-start/reasoning content", () => {
    const assistantID1 = "m-assistant-1"
    const assistantID2 = "m-assistant-2"

    const aborted = new MessageV2.AbortedError({ message: "aborted" }).toObject() as MessageV2.Assistant["error"]

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID1, "m-parent", aborted),
        parts: [
          {
            ...basePart(assistantID1, "a1"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
          },
          {
            ...basePart(assistantID1, "a2"),
            type: "text",
            text: "partial answer",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID2, "m-parent", aborted),
        parts: [
          {
            ...basePart(assistantID2, "b1"),
            type: "step-start",
          },
          {
            ...basePart(assistantID2, "b2"),
            type: "reasoning",
            text: "thinking",
            time: { start: 0 },
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking", providerOptions: undefined },
          { type: "text", text: "partial answer" },
        ],
      },
    ])
  })

  test("splits assistant messages on step-start boundaries", () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "text",
            text: "first",
          },
          {
            ...basePart(assistantID, "p2"),
            type: "step-start",
          },
          {
            ...basePart(assistantID, "p3"),
            type: "text",
            text: "second",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([
      {
        role: "assistant",
        content: [{ type: "text", text: "first" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "second" }],
      },
    ])
  })

  test("drops messages that only contain step-start parts", () => {
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo(assistantID, "m-parent"),
        parts: [
          {
            ...basePart(assistantID, "p1"),
            type: "step-start",
          },
        ] as MessageV2.Part[],
      },
    ]

    expect(MessageV2.toModelMessages(input, model)).toStrictEqual([])
  })

  test("converts pending/running tool calls to error results to prevent dangling tool_use", () => {
    const userID = "m-user"
    const assistantID = "m-assistant"

    const input: MessageV2.WithParts[] = [
      {
        info: userInfo(userID),
        parts: [
          {
            ...basePart(userID, "u1"),
            type: "text",
            text: "run tool",
          },
        ] as MessageV2.Part[],
      },
      {
        info: assistantInfo(assistantID, userID),
        parts: [
          {
            ...basePart(assistantID, "a1"),
            type: "tool",
            callID: "call-pending",
            tool: "bash",
            state: {
              status: "pending",
              input: { cmd: "ls" },
              raw: "",
            },
          },
          {
            ...basePart(assistantID, "a2"),
            type: "tool",
            callID: "call-running",
            tool: "read",
            state: {
              status: "running",
              input: { path: "/tmp" },
              time: { start: 0 },
            },
          },
        ] as MessageV2.Part[],
      },
    ]

    const result = MessageV2.toModelMessages(input, model)

    expect(result).toStrictEqual([
      {
        role: "user",
        content: [{ type: "text", text: "run tool" }],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "call-pending",
            toolName: "bash",
            input: { cmd: "ls" },
            providerExecuted: undefined,
          },
          {
            type: "tool-call",
            toolCallId: "call-running",
            toolName: "read",
            input: { path: "/tmp" },
            providerExecuted: undefined,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call-pending",
            toolName: "bash",
            output: { type: "error-text", value: "[Tool execution was interrupted]" },
          },
          {
            type: "tool-result",
            toolCallId: "call-running",
            toolName: "read",
            output: { type: "error-text", value: "[Tool execution was interrupted]" },
          },
        ],
      },
    ])
  })
})

describe("session.message-v2.filterCompacted — verbatim tail (P3.2)", () => {
  async function* streamOf(msgs: MessageV2.WithParts[]) {
    for (const m of msgs) yield m
  }
  const mk = (
    id: string,
    role: "user" | "assistant",
    parts: MessageV2.Part[],
    extra: Record<string, unknown> = {},
  ): MessageV2.WithParts => ({
    info: {
      id,
      sessionID: "s",
      role,
      time: { created: 0 },
      ...(role === "user"
        ? { agent: "a", model: { providerID: "p", modelID: "m" } }
        : {
            parentID: "p",
            modelID: "m",
            providerID: "p",
            mode: "",
            agent: "a",
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          }),
      ...extra,
    } as unknown as MessageV2.WithParts["info"],
    parts: parts as unknown as MessageV2.Part[],
  })
  const txt = (mid: string, t: string) =>
    ({ id: `${mid}t`, sessionID: "s", messageID: mid, type: "text", text: t }) as unknown as MessageV2.Part
  const compactionCarrier = (id: string) =>
    mk(id, "user", [
      { id: `${id}c`, sessionID: "s", messageID: id, type: "compaction", auto: true } as unknown as MessageV2.Part,
    ])

  test("keeps the tail messages verbatim after the summary", async () => {
    // history: [old1 old2] [tail: u-tail a-tail] [compaction carrier] [summary(tailStartId=u-tail)] [continuation]
    // fixtures are NEWEST-first because MessageV2.stream (the real caller's input) yields newest-first.
    const msgs: MessageV2.WithParts[] = [
      mk("cont", "assistant", [txt("cont", "continuing")], { finish: "stop", parentID: "cc" }),
      mk("sum", "assistant", [txt("sum", "HANDOFF")], { summary: true, finish: "stop", parentID: "cc", tailStartId: "utail" }),
      compactionCarrier("cc"),
      mk("atail", "assistant", [txt("atail", "recent work")]),
      mk("utail", "user", [txt("utail", "current request")]),
      mk("old2", "assistant", [txt("old2", "old a")]),
      mk("old1", "user", [txt("old1", "old q")]),
    ]
    const out = await MessageV2.filterCompacted(streamOf(msgs))
    const ids = out.map((m) => m.info.id)
    expect(ids).not.toContain("old1")
    expect(ids).not.toContain("old2")
    // tail preserved verbatim, ordered after the summary
    expect(ids).toEqual(["cc", "sum", "utail", "atail", "cont"])
  })

  test("without tailStartId, behavior is unchanged (drops everything before the boundary)", async () => {
    // NEWEST-first, matching MessageV2.stream.
    const msgs: MessageV2.WithParts[] = [
      mk("cont", "assistant", [txt("cont", "go")], { finish: "stop", parentID: "cc" }),
      mk("sum", "assistant", [txt("sum", "HANDOFF")], { summary: true, finish: "stop", parentID: "cc" }),
      compactionCarrier("cc"),
      mk("old1", "user", [txt("old1", "old")]),
    ]
    const out = await MessageV2.filterCompacted(streamOf(msgs))
    expect(out.map((m) => m.info.id)).toEqual(["cc", "sum", "cont"])
  })

  test("an empty (failed-overflow) summary is NOT a boundary — history is preserved, not dropped", async () => {
    // A compaction whose own summary request overflowed: the summary message is left
    // marked summary:true + finish (here "compact") but carries NO text. It must not be
    // treated as a real compaction boundary — doing so would drop the entire history and
    // replace it with an empty summary (the P0 data-loss bug).
    const msgs: MessageV2.WithParts[] = [
      mk("sum", "assistant", [], { summary: true, finish: "compact", parentID: "cc" }),
      compactionCarrier("cc"),
      mk("a1", "assistant", [txt("a1", "real work")], { finish: "stop", parentID: "u1" }),
      mk("u1", "user", [txt("u1", "real request")]),
    ]
    const out = await MessageV2.filterCompacted(streamOf(msgs))
    const ids = out.map((m) => m.info.id)
    expect(ids).toContain("u1")
    expect(ids).toContain("a1")
  })

  test("a missing tailStartId falls back to [carrier, summary, continuation] — never the whole history", async () => {
    // The summary references a tail anchor that is no longer in the stream (e.g. the tail
    // messages were reverted/migrated away). The retain scan can't find it; the re-splice
    // must still honour the compaction boundary and drop pre-carrier history, not return
    // the entire un-truncated history.
    const msgs: MessageV2.WithParts[] = [
      mk("cont", "assistant", [txt("cont", "go")], { finish: "stop", parentID: "cc" }),
      mk("sum", "assistant", [txt("sum", "HANDOFF")], {
        summary: true,
        finish: "stop",
        parentID: "cc",
        tailStartId: "gone",
      }),
      compactionCarrier("cc"),
      mk("old2", "assistant", [txt("old2", "old a")]),
      mk("old1", "user", [txt("old1", "old q")]),
    ]
    const out = await MessageV2.filterCompacted(streamOf(msgs))
    expect(out.map((m) => m.info.id)).toEqual(["cc", "sum", "cont"])
  })
})

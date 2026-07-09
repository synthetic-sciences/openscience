import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionCompaction } from "../../src/session/compaction"

const sessionID = "session"

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

function assistantInfo(id: string, parentID: string): MessageV2.Assistant {
  return {
    id,
    sessionID,
    role: "assistant",
    time: { created: 0 },
    parentID,
    modelID: "test",
    providerID: "test",
    mode: "",
    agent: "agent",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  } as unknown as MessageV2.Assistant
}

const base = (id: string, messageID: string) => ({ id, sessionID, messageID })

const textPart = (messageID: string, id: string, text: string, flags?: { ignored?: boolean; synthetic?: boolean }) =>
  ({ ...base(id, messageID), type: "text", text, ...flags }) as MessageV2.Part

const reasoningPart = (messageID: string, id: string, text: string) =>
  ({ ...base(id, messageID), type: "reasoning", text, time: { start: 0 } }) as MessageV2.Part

const imageFilePart = (messageID: string, id: string, name: string) =>
  ({
    ...base(id, messageID),
    type: "file",
    mime: "image/png",
    filename: name,
    url: "data:image/png;base64,Zm9v",
  }) as MessageV2.Part

const toolPart = (
  messageID: string,
  id: string,
  tool: string,
  input: Record<string, unknown>,
  output: string,
  opts?: { images?: number; compacted?: boolean },
) =>
  ({
    ...base(id, messageID),
    type: "tool",
    callID: id,
    tool,
    state: {
      status: "completed",
      input,
      output,
      title: "",
      metadata: {},
      time: { start: 0, end: 1, ...(opts?.compacted ? { compacted: 2 } : {}) },
      attachments: Array.from({ length: opts?.images ?? 0 }, (_, i) =>
        imageFilePart(messageID, `${id}-att${i}`, "x.png"),
      ),
    },
  }) as MessageV2.Part

const IMG = SessionCompaction.IMAGE_TOKEN_ESTIMATE // 1600

describe("session.message-v2.composition", () => {
  test("counts user + assistant text under `text`, excludes ignored, includes synthetic", () => {
    const input: MessageV2.WithParts[] = [
      { info: userInfo("u1"), parts: [textPart("u1", "p1", "a".repeat(40))] }, // 10
      {
        info: assistantInfo("a1", "u1"),
        parts: [
          textPart("a1", "p2", "b".repeat(20), { synthetic: true }), // 5
          textPart("a1", "p3", "c".repeat(80), { ignored: true }), // excluded
        ],
      },
    ]
    const c = MessageV2.composition(input)
    expect(c.text).toBe(15)
    expect(c.total).toBe(15)
    expect(c.images).toBe(0)
  })

  test("counts reasoning parts under `reasoning`", () => {
    const input: MessageV2.WithParts[] = [
      { info: assistantInfo("a1", "u1"), parts: [reasoningPart("a1", "r1", "r".repeat(40))] },
    ]
    const c = MessageV2.composition(input)
    expect(c.reasoning).toBe(10)
    expect(c.total).toBe(10)
  })

  test("counts image file parts as a flat per-image estimate under `image`", () => {
    const input: MessageV2.WithParts[] = [{ info: userInfo("u1"), parts: [imageFilePart("u1", "i1", "a.png")] }]
    const c = MessageV2.composition(input)
    expect(c.image).toBe(IMG)
    expect(c.images).toBe(1)
    expect(c.total).toBe(IMG)
  })

  test("counts tool args + output under `tool`, attachment images under `image`", () => {
    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo("a1", "u1"),
        parts: [toolPart("a1", "t1", "bash", { cmd: "ls" }, "o".repeat(40), { images: 1 })],
      },
    ]
    const c = MessageV2.composition(input)
    // args {"cmd":"ls"} = 12 chars → 3; output 40 chars → 10
    expect(c.tool).toBe(13)
    expect(c.image).toBe(IMG)
    expect(c.images).toBe(1)
    expect(c.total).toBe(13 + IMG)
  })

  test("buckets skill tool calls under `skills`, not `tool`", () => {
    const input: MessageV2.WithParts[] = [
      { info: assistantInfo("a1", "u1"), parts: [toolPart("a1", "s1", "skill", { name: "x" }, "s".repeat(40))] },
    ]
    const c = MessageV2.composition(input)
    // args {"name":"x"} = 12 chars → 3; output 40 → 10
    expect(c.skills).toBe(13)
    expect(c.tool).toBe(0)
    expect(c.total).toBe(13)
  })

  test("a compacted tool part collapses to its 1-line summary and drops its attachments", () => {
    const full = {
      info: assistantInfo("a1", "u1"),
      parts: [toolPart("a1", "t1", "bash", { cmd: "ls" }, "o".repeat(4000), { images: 1 })],
    }
    const compacted = {
      info: assistantInfo("a2", "u1"),
      parts: [toolPart("a2", "t2", "bash", { cmd: "ls" }, "o".repeat(4000), { images: 1, compacted: true })],
    }
    const cFull = MessageV2.composition([full])
    const cComp = MessageV2.composition([compacted])
    expect(cFull.tool).toBeGreaterThan(900) // ~1000 tokens for a 4000-char output
    expect(cComp.tool).toBeLessThan(20) // args + a single summary line
    expect(cComp.image).toBe(0) // attachments dropped once compacted
    expect(cComp.images).toBe(0)
  })

  test("counts the system prompt strings under `system`", () => {
    const c = MessageV2.composition([], { system: ["s".repeat(40), "t".repeat(20)] })
    expect(c.system).toBe(15) // 10 + 5
    expect(c.total).toBe(15)
  })

  test("total is the sum of every bucket across a mixed session", () => {
    const input: MessageV2.WithParts[] = [
      { info: userInfo("u1"), parts: [textPart("u1", "p1", "a".repeat(40)), imageFilePart("u1", "i1", "a.png")] },
      {
        info: assistantInfo("a1", "u1"),
        parts: [
          reasoningPart("a1", "r1", "r".repeat(40)),
          toolPart("a1", "t1", "bash", { cmd: "ls" }, "o".repeat(40)),
          toolPart("a1", "s1", "skill", { name: "x" }, "s".repeat(40)),
        ],
      },
    ]
    const c = MessageV2.composition(input, { system: ["y".repeat(40)] })
    expect(c.system).toBe(10)
    expect(c.text).toBe(10)
    expect(c.reasoning).toBe(10)
    expect(c.tool).toBe(13)
    expect(c.skills).toBe(13)
    expect(c.image).toBe(IMG)
    expect(c.images).toBe(1)
    expect(c.total).toBe(10 + 10 + 10 + 13 + 13 + IMG)
  })
})

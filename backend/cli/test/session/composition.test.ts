import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionCompaction } from "../../src/session/compaction"
import { Token } from "../../src/util/token"

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

  test("counts duplicate inline images once and reports the omitted copy", () => {
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo("u1"),
        parts: [imageFilePart("u1", "i1", "a.png"), imageFilePart("u1", "i2", "copy.png")],
      },
    ]
    const c = MessageV2.composition(input)
    expect(c.image).toBe(IMG)
    expect(c.images).toBe(1)
    expect(c.text).toBeGreaterThan(0)
  })

  test("accounts for inline images as media rather than base64 text", () => {
    const part = imageFilePart("u1", "i1", "large.png") as MessageV2.FilePart
    part.url = `data:image/png;base64,${"A".repeat(400_000)}`
    const c = MessageV2.composition([{ info: userInfo("u1"), parts: [part] }])
    expect(c.image).toBe(MessageV2.IMAGE_TOKENS)
    expect(c.total).toBe(MessageV2.IMAGE_TOKENS)
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

/** A syntactically minimal PDF with `pages` page objects, padded so its data
 * URL is far larger than the tokens a provider bills for it. */
export function pdfDataURL(pages: number, padding = 0) {
  const kids = Array.from({ length: pages }, (_, index) => `${index + 3} 0 R`).join(" ")
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${pages} >>`,
    ...Array.from({ length: pages }, () => "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>"),
    ...(padding ? [`<< /Length ${padding} >>\nstream\n${"\u00ff".repeat(padding)}\nendstream`] : []),
  ]
  const body = objects.map((object, index) => `${index + 1} 0 obj\n${object}\nendobj\n`).join("")
  const bytes = Buffer.from(`%PDF-1.4\n${body}trailer\n<< /Root 1 0 R >>\n%%EOF\n`, "latin1")
  return `data:application/pdf;base64,${bytes.toString("base64")}`
}

describe("session.message-v2.composition — documents", () => {
  const filePart = (messageID: string, id: string, mime: string, url: string) =>
    ({ ...base(id, messageID), type: "file", mime, filename: "attachment", url }) as MessageV2.Part

  test("counts PDF pages, never their base64 transport bytes", () => {
    expect(MessageV2.pdfPages(pdfDataURL(3))).toBe(3)
    expect(MessageV2.pdfPages(pdfDataURL(1))).toBe(1)
    expect(MessageV2.pdfPages(pdfDataURL(0))).toBe(1)
    expect(MessageV2.pdfPages("data:application/pdf;base64," + Buffer.from("not a pdf").toString("base64"))).toBe(1)
    const scan = pdfDataURL(3, 300_000)
    expect(Token.estimate(scan)).toBeGreaterThan(90_000)
    expect(MessageV2.documentTokens("application/pdf", scan)).toBe(3 * MessageV2.PDF_PAGE_TOKENS)
    expect(MessageV2.PDF_PAGE_TOKENS).toBe(3_000)
  })

  test("keeps the character estimate for files without a per-page contract", () => {
    const url = "data:application/octet-stream;base64," + "A".repeat(4000)
    expect(MessageV2.documentTokens("application/octet-stream", url)).toBe(Token.estimate(url))
  })

  test("reports attached documents under `document` and in the total", () => {
    const scan = pdfDataURL(2, 100_000)
    const input: MessageV2.WithParts[] = [
      {
        info: userInfo("u1"),
        parts: [
          textPart("u1", "p1", "a".repeat(40)),
          filePart("u1", "f1", "application/pdf", scan),
          filePart("u1", "f2", "text/plain", "data:text/plain;base64," + "A".repeat(4000)),
        ],
      },
      {
        info: assistantInfo("a1", "u1"),
        parts: [
          {
            ...toolPart("a1", "t1", "science_fetch", {}, "fetched"),
            state: {
              ...(toolPart("a1", "t1", "science_fetch", {}, "fetched") as MessageV2.ToolPart).state,
              attachments: [filePart("a1", "t1-att0", "application/pdf", pdfDataURL(4))],
            },
          } as MessageV2.Part,
        ],
      },
    ]
    const c = MessageV2.composition(input)
    expect(c.document).toBe((2 + 4) * MessageV2.PDF_PAGE_TOKENS)
    expect(c.text).toBe(10)
    expect(c.total).toBe(c.system + c.text + c.reasoning + c.tool + c.skills + c.image + c.document)
    expect(c.total).toBeLessThan(Token.estimate(scan))
  })

  test("a compacted tool result no longer carries its document attachments", () => {
    const completed = toolPart("a1", "t1", "science_fetch", {}, "fetched", { compacted: true }) as MessageV2.ToolPart
    const input: MessageV2.WithParts[] = [
      {
        info: assistantInfo("a1", "u1"),
        parts: [
          {
            ...completed,
            state: {
              ...completed.state,
              attachments: [filePart("a1", "t1-att0", "application/pdf", pdfDataURL(4))],
            },
          } as MessageV2.Part,
        ],
      },
    ]
    expect(MessageV2.composition(input).document).toBe(0)
  })
})

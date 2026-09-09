import { describe, expect, test } from "bun:test"
import type { Prompt } from "./prompt"
import { attachBytes, detachBytes, dropBytelessAttachments } from "./prompt-attachments"

const image = (id: string, dataUrl: string) => ({
  type: "image" as const,
  id,
  filename: `${id}.png`,
  mime: "image/png",
  dataUrl,
  size: dataUrl.length,
})

describe("composer attachment bytes", () => {
  test("the persisted draft carries the attachment's identity, never its bytes", () => {
    const bytes = "data:image/png;base64," + "A".repeat(6 * 1024 * 1024)
    const prompt: Prompt = [{ type: "text", content: "see ", start: 0, end: 4 }, image("img_1", bytes)]
    const stored = detachBytes(prompt)
    expect(stored[1]).toMatchObject({ type: "image", id: "img_1", dataUrl: "" })
    expect(JSON.stringify(stored).length).toBeLessThan(1024)
    // Readers get the bytes back for the preview and the send.
    expect(attachBytes(stored)[1]).toMatchObject({ id: "img_1", dataUrl: bytes })
    // A later set without bytes (a clone of the stored shape) keeps them.
    expect(attachBytes(detachBytes(stored))[1]).toMatchObject({ dataUrl: bytes })
  })

  test("a reloaded draft drops attachments whose bytes did not survive the page", () => {
    const draft = { prompt: [{ type: "text", content: "hi", start: 0, end: 2 }, image("img_gone", "")], cursor: 2 }
    expect(dropBytelessAttachments(draft)).toEqual({
      prompt: [{ type: "text", content: "hi", start: 0, end: 2 }],
      cursor: 2,
    })
    // Attachments this page still holds bytes for stay.
    detachBytes([image("img_here", "data:image/png;base64,AAAA")])
    const kept = { prompt: [image("img_here", "")] }
    expect(dropBytelessAttachments(kept)).toBe(kept)
    expect(dropBytelessAttachments("not a draft")).toBe("not a draft")
  })
})

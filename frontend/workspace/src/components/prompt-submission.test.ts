import { describe, expect, test } from "bun:test"
import type { Prompt } from "@/context/prompt"
import { canRestoreFailedSubmission } from "./prompt-submission"

const empty = (): Prompt => [{ type: "text", content: "", start: 0, end: 0 }]
const text = (content: string): Prompt => [{ type: "text", content, start: 0, end: content.length }]

describe("failed composer submissions", () => {
  test("restores the sent message when a delayed failure finds the composer untouched", async () => {
    let composer = empty()
    let rejectRequest!: (reason: Error) => void
    const request = new Promise<void>((_, reject) => {
      rejectRequest = reject
    }).catch(() => {
      if (canRestoreFailedSubmission(composer, "normal")) composer = text("original message")
    })

    rejectRequest(new Error("delayed failure"))
    await request

    expect(composer).toEqual(text("original message"))
  })

  test("preserves a new draft typed before a delayed failure settles", async () => {
    let composer = empty()
    let rejectRequest!: (reason: Error) => void
    const request = new Promise<void>((_, reject) => {
      rejectRequest = reject
    }).catch(() => {
      if (canRestoreFailedSubmission(composer, "normal")) composer = text("original message")
    })

    composer = text("new draft")
    rejectRequest(new Error("delayed failure"))
    await request

    expect(composer).toEqual(text("new draft"))
  })

  test("treats attachments and a newly selected shell mode as newer composer state", () => {
    const attachment: Prompt = [
      {
        type: "image",
        id: "image-next",
        filename: "next.png",
        mime: "image/png",
        dataUrl: "data:image/png;base64,AA==",
      },
    ]

    expect(canRestoreFailedSubmission(attachment, "normal")).toBe(false)
    expect(canRestoreFailedSubmission(empty(), "shell")).toBe(false)
  })
})

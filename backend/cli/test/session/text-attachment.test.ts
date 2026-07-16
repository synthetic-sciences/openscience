import { describe, expect, test } from "bun:test"
import { SessionPrompt } from "../../src/session/prompt"

const data = (text: string) => `data:text/plain;base64,${Buffer.from(text, "utf8").toString("base64")}`

describe("SessionPrompt.decodeDataUrlText", () => {
  test("decodes base64 and percent-encoded data URLs", () => {
    const text = "café — π ≈ 3.14 🚀"
    expect(SessionPrompt.decodeDataUrlText(data(text))).toBe(text)
    expect(SessionPrompt.decodeDataUrlText(`data:text/plain,${encodeURIComponent(text)}`)).toBe(text)
  })

  test("accepts a bare base64 payload", () => {
    expect(SessionPrompt.decodeDataUrlText(Buffer.from("bare").toString("base64"))).toBe("bare")
  })

  test("normalizes newlines and strips control characters", () => {
    expect(SessionPrompt.decodeDataUrlText(data("a\x00b\x1b[31mc\td\r\ne"))).toBe("ab[31mc\td\ne")
  })

  test("caps text and names the truncated attachment", () => {
    const text = "x".repeat(SessionPrompt.TEXT_ATTACHMENT_MAX_CHARS + 5_000)
    const value = SessionPrompt.decodeDataUrlText(data(text), "big.md")
    expect(value.startsWith("x".repeat(SessionPrompt.TEXT_ATTACHMENT_MAX_CHARS))).toBe(true)
    expect(value).toContain("truncated big.md at 256 KB")
    expect(value.length).toBeLessThan(text.length)
  })
})

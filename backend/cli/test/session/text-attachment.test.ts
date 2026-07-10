import { describe, expect, test } from "bun:test"
import { SessionPrompt } from "../../src/session/prompt"

const dataUrl = (text: string) => `data:text/plain;base64,${Buffer.from(text, "utf8").toString("base64")}`

describe("SessionPrompt.decodeTextAttachment", () => {
  test("round-trips ascii text from a data URL", () => {
    expect(SessionPrompt.decodeTextAttachment(dataUrl("# Title\n\nhello world"))).toBe("# Title\n\nhello world")
  })

  test("strips the data-URL prefix (does not decode it as payload)", () => {
    // The old code base64url-decoded the whole URL including `data:...,` — the
    // prefix must not leak into the output.
    const out = SessionPrompt.decodeTextAttachment(dataUrl("plain text"))
    expect(out).toBe("plain text")
    expect(out).not.toContain("data:")
  })

  test("decodes UTF-8 (accents + emoji) correctly", () => {
    const text = "café — π ≈ 3.14 🚀"
    expect(SessionPrompt.decodeTextAttachment(dataUrl(text))).toBe(text)
  })

  test("accepts a bare base64 payload with no comma", () => {
    const payload = Buffer.from("bare", "utf8").toString("base64")
    expect(SessionPrompt.decodeTextAttachment(payload)).toBe("bare")
  })

  test("truncates past the cap and appends a note", () => {
    const big = "x".repeat(SessionPrompt.TEXT_ATTACHMENT_MAX_CHARS + 5_000)
    const out = SessionPrompt.decodeTextAttachment(dataUrl(big), "big.md")
    expect(out.length).toBeLessThan(big.length)
    expect(out.startsWith("x".repeat(SessionPrompt.TEXT_ATTACHMENT_MAX_CHARS))).toBe(true)
    expect(out).toContain("truncated big.md")
  })

  test("leaves text at or under the cap untouched", () => {
    const text = "y".repeat(SessionPrompt.TEXT_ATTACHMENT_MAX_CHARS)
    expect(SessionPrompt.decodeTextAttachment(dataUrl(text))).toBe(text)
  })

  test("strips control chars (NUL, ANSI escapes) but keeps tab/newline", () => {
    const out = SessionPrompt.decodeTextAttachment(dataUrl("a\x00b\x1b[31mc\td\r\ne"))
    expect(out).toBe("ab[31mc\td\ne")
    expect(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(out)).toBe(false)
  })
})

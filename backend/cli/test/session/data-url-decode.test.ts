import { describe, expect, test } from "bun:test"
import { SessionPrompt } from "../../src/session/prompt"

// An uploaded .txt/.md arrives as a data: URL; only the payload after the comma is
// the content. The old code base64url-decoded the whole URL, prefixing the inlined
// text with ~12 bytes of garbage from "data:text/plain," (#170).
describe("SessionPrompt.decodeDataUrlText", () => {
  const dataUrl = (mime: string, text: string) => `data:${mime};base64,${Buffer.from(text).toString("base64")}`

  test("round-trips a base64 text/plain upload (no garbage prefix)", () => {
    const text = "line1\nline2\ttab, and a comma"
    expect(SessionPrompt.decodeDataUrlText(dataUrl("text/plain", text))).toBe(text)
  })

  test("round-trips a base64 markdown upload with unicode", () => {
    const md = "# Title\n\nHello **world** — resolution 3µm."
    expect(SessionPrompt.decodeDataUrlText(dataUrl("text/markdown", md))).toBe(md)
  })

  test("decodes a percent-encoded (non-base64) data URL", () => {
    expect(SessionPrompt.decodeDataUrlText("data:text/plain,hello%20world%2C%20done")).toBe("hello world, done")
  })

  test("regression: does NOT reproduce the base64url-of-whole-url garbage prefix", () => {
    const text = "actual file contents here"
    const url = dataUrl("text/plain", text)
    const buggy = Buffer.from(url, "base64url").toString()
    expect(buggy).not.toBe(text) // the old behavior was wrong
    expect(SessionPrompt.decodeDataUrlText(url)).toBe(text) // the fix is right
  })
})

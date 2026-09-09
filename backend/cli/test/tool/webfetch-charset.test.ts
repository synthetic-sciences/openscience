import { expect, test } from "bun:test"
import { decodeBody, responseCharset } from "../../src/tool/webfetch"

const latin1 = (text: string) => Uint8Array.from(text, (char) => char.charCodeAt(0))

test("decodes a body in the charset the response declares", () => {
  const bytes = latin1("caf\xe9 na\xefve")
  expect(decodeBody(bytes, "text/plain; charset=iso-8859-1", "text/plain")).toBe("café naïve")
  expect(decodeBody(bytes, 'text/html; charset="windows-1252"', "text/html")).toBe("café naïve")
})

test("falls back to a meta charset inside an HTML body, then to UTF-8", () => {
  const html = latin1('<html><head><meta charset="iso-8859-1"></head><body>caf\xe9</body></html>')
  expect(responseCharset("text/html", "text/html", html)).toBe("iso-8859-1")
  expect(decodeBody(html, "text/html", "text/html")).toContain("café")
  const utf8 = new TextEncoder().encode("naïve")
  expect(decodeBody(utf8, "text/plain", "text/plain")).toBe("naïve")
})

test("an unknown charset label does not break decoding", () => {
  const utf8 = new TextEncoder().encode("plain")
  expect(decodeBody(utf8, "text/plain; charset=x-unknown-9", "text/plain")).toBe("plain")
})

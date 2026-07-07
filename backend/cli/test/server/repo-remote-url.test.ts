import { describe, expect, test } from "bun:test"
import { assertSafeRemoteUrl } from "../../src/server/routes/repo"

describe("assertSafeRemoteUrl", () => {
  test("accepts normal https / ssh / git@ remotes", () => {
    for (const url of [
      "https://github.com/owner/name.git",
      "http://gitlab.example.com/g/n",
      "ssh://git@github.com/owner/name.git",
      "git@github.com:owner/name.git",
    ]) {
      expect(assertSafeRemoteUrl(url)).toBe(url)
    }
  })

  test("trims surrounding whitespace", () => {
    expect(assertSafeRemoteUrl("  https://github.com/o/n  ")).toBe("https://github.com/o/n")
  })

  test("rejects the code-executing git helper transports", () => {
    expect(() => assertSafeRemoteUrl('ext::sh -c "id"')).toThrow("unsupported remote transport")
    expect(() => assertSafeRemoteUrl("fake::whatever")).toThrow("unsupported remote transport")
  })

  test("rejects argument injection (leading dash)", () => {
    expect(() => assertSafeRemoteUrl("--upload-pack=touch /tmp/pwned")).toThrow("invalid remote URL")
  })

  test("rejects unknown / non-remote schemes", () => {
    expect(() => assertSafeRemoteUrl("file:///etc/passwd")).toThrow("unsupported remote URL scheme")
    expect(() => assertSafeRemoteUrl("not a url")).toThrow("unsupported remote URL scheme")
    expect(() => assertSafeRemoteUrl("")).toThrow("remote URL required")
  })
})

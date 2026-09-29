import { describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { expandPath } from "../../src/server/routes/folder-resolve"

const windows = process.platform === "win32"

describe("folder-resolve expandPath", () => {
  test("a drive-letter file URL is a drive path on Windows and a literal path elsewhere", () => {
    // URL.pathname yields "/C:/Users/me", which resolved to "C:\C:\Users\me" on Windows.
    expect(expandPath("file:///C:/Users/me/Desktop")).toBe(windows ? "C:\\Users\\me\\Desktop" : "/C:/Users/me/Desktop")
    expect(expandPath("file:///c:/x")).toBe(windows ? "c:\\x" : "/c:/x")
    expect(expandPath("file://localhost/C:/x")).toBe(windows ? "C:\\x" : "/C:/x")
  })

  test.if(windows)("a UNC file URL keeps its server", () => {
    expect(expandPath("file://server/share/dir")).toBe("\\\\server\\share\\dir")
  })

  test("a percent-escaped file URL decodes to the real path", () => {
    expect(expandPath("file:///work/My%20Files")).toBe(path.resolve("/work/My Files"))
    expect(expandPath("file:///work/100%25")).toBe(path.resolve("/work/100%"))
  })

  test("a file URL to a non-ASCII folder decodes to its name", () => {
    // URL percent-encodes non-ASCII even when the input is raw Unicode.
    expect(expandPath("file:///Users/me/café")).toBe(path.resolve("/Users/me/café"))
    expect(expandPath("file:///Users/me/caf%C3%A9")).toBe(path.resolve("/Users/me/café"))
    expect(expandPath("file:///Users/me/数据")).toBe(path.resolve("/Users/me/数据"))
    expect(expandPath("file:///Users/me/%E6%95%B0%E6%8D%AE")).toBe(path.resolve("/Users/me/数据"))
  })

  test("a file URL with a stray percent resolves as written", () => {
    // decodeURIComponent threw URIError, which surfaced as a failed request
    // rather than as a path that simply does not exist.
    expect(expandPath("file:///work/a%zz")).toBe(path.resolve("/work/a%zz"))
    expect(expandPath("file:///work/a%")).toBe(path.resolve("/work/a%"))
    expect(expandPath("file:///work/caf%C3%A9%zz")).toBe(path.resolve("/work/café%zz"))
    expect(expandPath("file:///work/a%E6")).toBe(path.resolve("/work/a%E6"))
  })

  test("a POSIX file URL resolves normally", () => {
    expect(expandPath("file:///home/me/data")).toBe(path.resolve("/home/me/data"))
  })

  test("a plain path and a tilde path are unchanged", () => {
    expect(expandPath("C:/Users/me/Desktop")).toBe(path.resolve("C:/Users/me/Desktop"))
    expect(expandPath("~/projects")).toBe(path.join(os.homedir(), "projects"))
    expect(expandPath("~")).toBe(os.homedir())
    expect(expandPath("")).toBe("")
  })
})

import { describe, expect, test } from "bun:test"
import { getDirectory, getFileExtension } from "@synsci/util/path"

describe("getDirectory", () => {
  test("a bare filename has no directory", () => {
    // The join ran on an empty slice, so a relative name became the filesystem
    // root. A root-level file is not in "/".
    expect(getDirectory("foo")).toBe("")
    expect(getDirectory("foo.ts")).toBe("")
  })

  test("keeps the directory of a nested path", () => {
    expect(getDirectory("a/b")).toBe("a/")
    expect(getDirectory("a/b/c.ts")).toBe("a/b/")
    expect(getDirectory("a\\b\\c.ts")).toBe("a/b/")
  })

  test("the root and an empty input stay as they are", () => {
    expect(getDirectory("/")).toBe("/")
    expect(getDirectory("/foo.ts")).toBe("/")
    expect(getDirectory("")).toBe("")
    expect(getDirectory(undefined)).toBe("")
  })
})

describe("getFileExtension", () => {
  test("an extensionless or dotfile name has no extension", () => {
    // Splitting the whole path on "." returned the name itself when there was
    // no dot, and the name minus its leading dot for a dotfile.
    expect(getFileExtension("README")).toBe("")
    expect(getFileExtension(".gitignore")).toBe("")
  })

  test("reads the extension from the filename, not from a directory", () => {
    expect(getFileExtension("a.ts")).toBe("ts")
    expect(getFileExtension("a/b/c.ts")).toBe("ts")
    expect(getFileExtension("archive.tar.gz")).toBe("gz")
    expect(getFileExtension("/a.b/c")).toBe("")
  })

  test("an empty or missing path has no extension", () => {
    expect(getFileExtension("")).toBe("")
    expect(getFileExtension(undefined)).toBe("")
  })
})

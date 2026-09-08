import { describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { Filesystem } from "../../src/util/filesystem"

describe("util.filesystem", () => {
  test("exists() is true for files and directories", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "openscience-filesystem-"))
    const dir = path.join(tmp, "dir")
    const file = path.join(tmp, "file.txt")
    const missing = path.join(tmp, "missing")

    await mkdir(dir, { recursive: true })
    await Bun.write(file, "hello")

    const cases = await Promise.all([Filesystem.exists(dir), Filesystem.exists(file), Filesystem.exists(missing)])

    expect(cases).toEqual([true, true, false])

    await rm(tmp, { recursive: true, force: true })
  })

  test("isDir() is true only for directories", async () => {
    const tmp = await mkdtemp(path.join(os.tmpdir(), "openscience-filesystem-"))
    const dir = path.join(tmp, "dir")
    const file = path.join(tmp, "file.txt")
    const missing = path.join(tmp, "missing")

    await mkdir(dir, { recursive: true })
    await Bun.write(file, "hello")

    const cases = await Promise.all([Filesystem.isDir(dir), Filesystem.isDir(file), Filesystem.isDir(missing)])

    expect(cases).toEqual([true, false, false])

    await rm(tmp, { recursive: true, force: true })
  })

  test("trimSeparator() keeps filesystem roots intact on every platform", () => {
    expect(Filesystem.trimSeparator("C:\\", path.win32)).toBe("C:\\")
    expect(Filesystem.trimSeparator("C:\\Users\\me\\", path.win32)).toBe("C:\\Users\\me")
    expect(Filesystem.trimSeparator("C:\\Users\\me", path.win32)).toBe("C:\\Users\\me")
    expect(Filesystem.trimSeparator("\\\\server\\share\\", path.win32)).toBe("\\\\server\\share\\")
    expect(Filesystem.trimSeparator("/", path.posix)).toBe("/")
    expect(Filesystem.trimSeparator("/Users/me/", path.posix)).toBe("/Users/me")
    // A drive-relative "C:" would resolve against the process cwd later.
    expect(path.win32.resolve(Filesystem.trimSeparator("C:\\", path.win32))).toBe("C:\\")
  })
})

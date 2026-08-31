import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import { constants } from "node:fs"
import path from "node:path"
import { SafeFileIO } from "../../src/file/safe-io"
import { tmpdir } from "../fixture/fixture"

describe("SafeFileIO", () => {
  test.skipIf(process.platform === "win32")("rejects a FIFO before waiting for a writer", async () => {
    await using tmp = await tmpdir()
    const target = path.join(tmp.path, "output.txt")
    const create = Bun.spawn(["mkfifo", target], { stdout: "ignore", stderr: "pipe" })
    expect(await create.exited).toBe(0)
    const pending = SafeFileIO.read(target).then(
      () => ({ error: undefined }),
      (error: Error) => ({ error }),
    )
    const result = await Promise.race([pending, Bun.sleep(500).then(() => undefined)])
    // Reap even a regressed blocking read, so a failed test never leaves an
    // open FIFO request/thread behind in the shared test process.
    if (!result) {
      const peer = await fs.open(target, constants.O_RDWR | constants.O_NONBLOCK)
      await pending
      await peer.close()
    }
    expect(result?.error?.message).toContain("Only regular files can be accessed")
  })

  test.skipIf(process.platform === "win32")("rejects a FIFO swapped in after the regular-file check", async () => {
    await using tmp = await tmpdir()
    const target = path.join(tmp.path, "output.txt")
    await fs.writeFile(target, "original")
    using barrier = SafeFileIO.testing({
      afterReadStat: async () => {
        await fs.rename(target, path.join(tmp.path, "retained.txt"))
        const create = Bun.spawn(["mkfifo", target], { stdout: "ignore", stderr: "pipe" })
        expect(await create.exited).toBe(0)
      },
    })
    const pending = SafeFileIO.open(target).then(
      async (source) => {
        await source.close()
        return { error: undefined }
      },
      (error: Error) => ({ error }),
    )
    const result = await Promise.race([pending, Bun.sleep(500).then(() => undefined)])
    if (!result) {
      const peer = await fs.open(target, constants.O_RDWR | constants.O_NONBLOCK)
      await pending
      await peer.close()
    }
    expect(result?.error?.message).toContain("Only regular files can be accessed")
    expect(await fs.readFile(path.join(tmp.path, "retained.txt"), "utf8")).toBe("original")
  })

  test.skipIf(process.platform === "win32")(
    "rejects an indirect symlink spelling even when the final component is regular",
    async () => {
      await using tmp = await tmpdir({
        init: async (directory) => {
          await Bun.write(path.join(directory, "real", "paper.md"), "# Paper")
          await fs.symlink(path.join(directory, "real"), path.join(directory, "alias"))
        },
      })

      await expect(SafeFileIO.read(path.join(tmp.path, "alias", "paper.md"))).rejects.toThrow("indirect symbolic link")
      await expect(SafeFileIO.read(await fs.realpath(path.join(tmp.path, "alias", "paper.md")))).resolves.toMatchObject(
        {
          bytes: Buffer.from("# Paper"),
        },
      )
    },
  )

  test.skipIf(process.platform !== "win32")("rejects a Windows junction as a write parent", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        await fs.mkdir(path.join(directory, "real"))
        await fs.symlink(path.join(directory, "real"), path.join(directory, "alias"), "junction")
      },
    })

    await expect(SafeFileIO.write(path.join(tmp.path, "alias", "paper.md"), "blocked")).rejects.toThrow(
      "indirect Windows path",
    )
    expect(await Bun.file(path.join(tmp.path, "real", "paper.md")).exists()).toBe(false)
  })

  test("rejects a streamed snapshot when its authorized path is replaced", async () => {
    await using tmp = await tmpdir({
      init: (directory) => Bun.write(path.join(directory, "paper.pdf"), "original"),
    })
    const file = path.join(tmp.path, "paper.pdf")
    const moved = path.join(tmp.path, "moved.pdf")
    const source = await SafeFileIO.open(file)
    await fs.rename(file, moved)
    await Bun.write(file, "replacement")

    await expect(new Response(source.stream()).arrayBuffer()).rejects.toThrow("changed during access")
  })

  test("revalidates a partially consumed stream before cancellation returns", async () => {
    await using tmp = await tmpdir({
      init: async (directory) => {
        await Bun.write(path.join(directory, "source.txt"), "a".repeat(256 * 1024))
      },
    })
    const target = path.join(tmp.path, "source.txt")
    const source = await SafeFileIO.open(target)
    const reader = source.stream().getReader()

    expect((await reader.read()).value?.byteLength).toBeGreaterThan(0)
    await fs.rename(target, path.join(tmp.path, "original.txt"))
    await Bun.write(target, "replacement")

    await expect(reader.cancel()).rejects.toThrow("changed during access")
  })

  test("runs a supplied authority gate around every streamed file chunk", async () => {
    await using tmp = await tmpdir({
      init: (directory) => Bun.write(path.join(directory, "source.txt"), "a".repeat(256 * 1024)),
    })
    const gates = { value: 0 }
    const source = await SafeFileIO.open(path.join(tmp.path, "source.txt"), {
      during: async (action) => {
        gates.value += 1
        return action()
      },
    })

    expect((await new Response(source.stream()).arrayBuffer()).byteLength).toBe(256 * 1024)
    expect(gates.value).toBeGreaterThan(1)
  })

  test("rejects an in-place rewrite even when size and mtime are restored", async () => {
    await using tmp = await tmpdir({
      init: (directory) => Bun.write(path.join(directory, "paper.pdf"), "original"),
    })
    const file = path.join(tmp.path, "paper.pdf")
    const before = await fs.stat(file)
    const source = await SafeFileIO.open(file)
    await Bun.sleep(10)
    await Bun.write(file, "rewritten")
    await fs.utimes(file, before.atime, before.mtime)

    await expect(new Response(source.stream()).arrayBuffer()).rejects.toThrow("changed during access")
  })

  test.skipIf(process.platform === "win32")(
    "does not create a new file when its verified parent is swapped for an external symlink",
    async () => {
      await using outside = await tmpdir()
      await using tmp = await tmpdir({
        init: (directory) => fs.mkdir(path.join(directory, "exports"), { recursive: true }),
      })
      const parent = path.join(tmp.path, "exports")
      const retained = path.join(tmp.path, "retained")
      using barrier = SafeFileIO.testing({
        afterDirectoryVerify: async () => {
          await fs.rename(parent, retained)
          await fs.symlink(outside.path, parent)
        },
      })

      await expect(SafeFileIO.write(path.join(parent, "paper.pdf"), "publication")).rejects.toThrow(
        "directory identity changed",
      )
      expect(await Bun.file(path.join(outside.path, "paper.pdf")).exists()).toBe(false)
      expect(await Bun.file(path.join(retained, "paper.pdf")).exists()).toBe(false)
      expect((await fs.readdir(retained)).filter((file) => file.startsWith(".openscience-"))).toEqual([])
    },
  )

  test.skipIf(process.platform === "win32")(
    "does not replace an external file when an approved file's parent is swapped",
    async () => {
      await using outside = await tmpdir({
        init: (directory) => Bun.write(path.join(directory, "report.md"), "external"),
      })
      await using tmp = await tmpdir({
        init: (directory) => Bun.write(path.join(directory, "paper", "report.md"), "approved"),
      })
      const parent = path.join(tmp.path, "paper")
      const retained = path.join(tmp.path, "retained")
      const target = path.join(parent, "report.md")
      const approved = await SafeFileIO.read(target)
      using barrier = SafeFileIO.testing({
        afterDirectoryVerify: async () => {
          await fs.rename(parent, retained)
          await fs.symlink(outside.path, parent)
        },
      })

      await expect(SafeFileIO.write(target, "replacement", approved)).rejects.toThrow("directory identity changed")
      expect(await Bun.file(path.join(outside.path, "report.md")).text()).toBe("external")
      expect(await Bun.file(path.join(retained, "report.md")).text()).toBe("approved")
      expect((await fs.readdir(retained)).filter((file) => file.startsWith(".openscience-"))).toEqual([])
    },
  )

  test("does not overwrite a file created after the absence check", async () => {
    await using tmp = await tmpdir()
    const target = path.join(tmp.path, "result.txt")
    using barrier = SafeFileIO.testing({
      afterDirectoryVerify: async () => {
        await Bun.write(target, "concurrent")
      },
    })

    await expect(SafeFileIO.write(target, "replacement")).rejects.toThrow("unapproved file")
    expect(await Bun.file(target).text()).toBe("concurrent")
    expect((await fs.readdir(tmp.path)).filter((file) => file.startsWith(".openscience-"))).toEqual([])
  })

  test("restores a concurrently changed approved file instead of replacing it", async () => {
    await using tmp = await tmpdir({
      init: (directory) => Bun.write(path.join(directory, "result.txt"), "approved"),
    })
    const target = path.join(tmp.path, "result.txt")
    const approved = await SafeFileIO.read(target)
    using barrier = SafeFileIO.testing({
      afterDirectoryVerify: async () => {
        await Bun.write(target, "concurrent")
      },
    })

    await expect(SafeFileIO.write(target, "replacement", approved)).rejects.toThrow(
      "approved file changed before replacement",
    )
    expect(await Bun.file(target).text()).toBe("concurrent")
    expect((await fs.readdir(tmp.path)).filter((file) => file.startsWith(".openscience-"))).toEqual([])
  })

  test("rejects file growth before reading a replacement snapshot", async () => {
    await using tmp = await tmpdir()
    const target = path.join(tmp.path, "result.txt")
    await fs.writeFile(target, "approved")
    const approved = await SafeFileIO.read(target)
    await fs.truncate(target, 32 * 1024 * 1024)
    await expect(SafeFileIO.write(target, "replacement", approved)).rejects.toThrow("file changed after approval")
    expect((await fs.stat(target)).size).toBe(32 * 1024 * 1024)
  })

  test.skipIf(process.platform === "win32")(
    "rolls back growth after approval without reading the enlarged backup",
    async () => {
      await using tmp = await tmpdir()
      const target = path.join(tmp.path, "result.txt")
      await fs.writeFile(target, "approved")
      const approved = await SafeFileIO.read(target)
      using barrier = SafeFileIO.testing({ afterDirectoryVerify: () => fs.truncate(target, 32 * 1024 * 1024) })
      await expect(SafeFileIO.write(target, "replacement", approved)).rejects.toThrow(
        "approved file changed before replacement",
      )
      expect((await fs.stat(target)).size).toBe(32 * 1024 * 1024)
      expect((await fs.readdir(tmp.path)).filter((file) => file.startsWith(".openscience-"))).toEqual([])
    },
  )

  test("creates missing direct directories and permits names beginning with dots", async () => {
    await using tmp = await tmpdir()
    const target = path.join(tmp.path, "..hidden", "nested", "result.txt")

    await SafeFileIO.write(target, "contained")

    expect(await Bun.file(target).text()).toBe("contained")
  })

  test("replaces only the exact approved file through its held parent", async () => {
    await using tmp = await tmpdir({
      init: (directory) => Bun.write(path.join(directory, "result.txt"), "approved"),
    })
    const target = path.join(tmp.path, "result.txt")
    const approved = await SafeFileIO.read(target)

    await SafeFileIO.write(target, "replacement", approved)

    expect(await Bun.file(target).text()).toBe("replacement")
    expect((await fs.readdir(tmp.path)).filter((file) => file.startsWith(".openscience-"))).toEqual([])
  })

  test.skipIf(process.platform !== "win32")("pins a Windows parent while the native write is active", async () => {
    await using tmp = await tmpdir({
      init: (directory) => fs.mkdir(path.join(directory, "exports")),
    })
    const parent = path.join(tmp.path, "exports")
    const moved = path.join(tmp.path, "moved")
    const blocked = { value: false }
    using barrier = SafeFileIO.testing({
      afterDirectoryVerify: async () => {
        await fs.rename(parent, moved).then(
          () => {
            throw new Error("Windows parent unexpectedly moved while its native handle was held")
          },
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "EBUSY" && error.code !== "EPERM" && error.code !== "EACCES") throw error
            blocked.value = true
          },
        )
      },
    })

    await SafeFileIO.write(path.join(parent, "result.txt"), "protected")

    expect(blocked.value).toBe(true)
    expect(await Bun.file(path.join(parent, "result.txt")).text()).toBe("protected")
    expect(await Bun.file(path.join(moved, "result.txt")).exists()).toBe(false)
  })
})

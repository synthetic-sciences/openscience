import { expect, test } from "bun:test"
import { dlopen, FFIType } from "bun:ffi"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { AtomicRename } from "../../src/util/atomic-rename"

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-atomic-rename-"))
  const source = path.join(root, "replacement.tmp")
  const destination = path.join(root, "committed.json")
  const sibling = path.join(root, "unrelated.tmp")
  await fs.writeFile(source, "replacement\n")
  await fs.writeFile(destination, "original\n")
  await fs.writeFile(sibling, "unrelated\n")
  return {
    root,
    source,
    destination,
    sibling,
    async [Symbol.asyncDispose]() {
      await fs.rm(root, { recursive: true, force: true })
    },
  }
}

function lock(file: string) {
  const library = dlopen("kernel32.dll", {
    CreateFileW: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u64],
      returns: FFIType.u64,
    },
    CloseHandle: { args: [FFIType.u64], returns: FFIType.i32 },
    GetLastError: { args: [], returns: FFIType.u32 },
  })
  // A reader/scanner may share ordinary reads and writes but deny replacement
  // by omitting FILE_SHARE_DELETE. Node's default handles do not reproduce it.
  const handle = library.symbols.CreateFileW(Buffer.from(`${file}\0`, "utf16le"), 0x80000000, 3, null, 3, 0, 0)
  if (BigInt(handle) === 0xffffffffffffffffn) {
    const code = library.symbols.GetLastError()
    library.close()
    throw new Error(`Could not hold Windows file handle: ${code}`)
  }
  let closed = false
  return {
    close() {
      if (closed) return
      closed = true
      const result = library.symbols.CloseHandle(handle)
      library.close()
      if (!result) throw new Error("Could not release Windows file handle")
    },
  }
}

for (const held of ["source", "destination"] as const) {
  test.skipIf(process.platform !== "win32")(`retries a real Windows ${held} handle until it closes`, async () => {
    await using data = await fixture()
    // A source lock also covers first publication, where no committed file
    // exists yet (for example a new data-root operation marker).
    if (held === "source") await fs.rm(data.destination)
    const handle = lock(data[held])
    try {
      const error = await fs.rename(data.source, data.destination).then(
        () => undefined,
        (error: NodeJS.ErrnoException) => error,
      )
      expect(["EPERM", "EACCES", "EBUSY"]).toContain(error?.code ?? "")
      let settled = false
      const pending = AtomicRename.replace(data.source, data.destination).then(
        () => {
          settled = true
          return undefined
        },
        (error: Error) => {
          settled = true
          return error
        },
      )
      try {
        await Bun.sleep(100)
        expect(settled).toBe(false)
        expect(await fs.readFile(data.source, "utf8")).toBe("replacement\n")
        if (held === "destination") expect(await fs.readFile(data.destination, "utf8")).toBe("original\n")
        else expect(await Bun.file(data.destination).exists()).toBe(false)
      } finally {
        handle.close()
        expect(await pending).toBeUndefined()
      }
      expect(await fs.readFile(data.destination, "utf8")).toBe("replacement\n")
      expect(await Bun.file(data.source).exists()).toBe(false)
      expect(await fs.readFile(data.sibling, "utf8")).toBe("unrelated\n")
    } finally {
      handle.close()
    }
  })
}

test.skipIf(process.platform !== "win32")(
  "a persistent Windows handle preserves both files until an explicit retry",
  async () => {
    await using data = await fixture()
    const handle = lock(data.destination)
    try {
      const started = performance.now()
      const error = await AtomicRename.replace(data.source, data.destination).then(
        () => undefined,
        (error: NodeJS.ErrnoException) => error,
      )
      expect(["EPERM", "EACCES", "EBUSY"]).toContain(error?.code ?? "")
      expect(performance.now() - started).toBeGreaterThanOrEqual(1_900)
      expect(performance.now() - started).toBeLessThan(6_000)
      expect(await fs.readFile(data.destination, "utf8")).toBe("original\n")
      expect(await fs.readFile(data.source, "utf8")).toBe("replacement\n")
      expect(await fs.readFile(data.sibling, "utf8")).toBe("unrelated\n")
    } finally {
      handle.close()
    }
    await AtomicRename.replace(data.source, data.destination)
    expect(await fs.readFile(data.destination, "utf8")).toBe("replacement\n")
    expect(await Bun.file(data.source).exists()).toBe(false)
    expect(await fs.readFile(data.sibling, "utf8")).toBe("unrelated\n")
  },
)

import { constants as FS } from "node:fs"
import fs, { type FileHandle } from "node:fs/promises"
import path from "node:path"

export namespace ModalUpload {
  export const LIMIT = 100 * 1024 * 1024
  export const COUNT_LIMIT = 10_000

  export type Entry = {
    path: string
    canonical: string
    size: number
    sha256?: string
  }

  export type Snapshot = {
    size: number
    dev: number
    ino: number
    mtimeMs: number
    ctimeMs: number
  }

  export type Expected = Partial<Snapshot> & {
    size: number
    sha256?: string
  }

  type Hooks = {
    read?: (file: string) => void | Promise<void>
  }

  const hooks = { value: undefined as Hooks | undefined }

  /** Deterministic assertion that a rejected manifest never starts a content read. */
  export function testing(input: Hooks) {
    if (process.env.NODE_ENV !== "test" && !process.env.OPENSCIENCE_TEST_HOME) {
      throw new Error("Modal upload test hooks are disabled outside tests")
    }
    const prior = hooks.value
    hooks.value = input
    return {
      [Symbol.dispose]() {
        if (hooks.value === input) hooks.value = prior
      },
    }
  }

  function changed(file: string, label: string) {
    return new Error(`${label} input changed during secure access: ${file}`)
  }

  function valid(info: Snapshot) {
    return Number.isSafeInteger(info.size) && info.size >= 0
  }

  async function stable(file: string, handle: FileHandle, before: Snapshot, label: string) {
    const [after, current, canonical] = await Promise.all([handle.stat(), fs.lstat(file), fs.realpath(file)])
    if (
      !after.isFile() ||
      current.isSymbolicLink() ||
      canonical !== path.resolve(file) ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      current.dev !== after.dev ||
      current.ino !== after.ino
    ) {
      throw changed(file, label)
    }
  }

  async function opened(file: string, label: string) {
    const expected = path.resolve(file)
    const canonical = await fs.realpath(file)
    if (canonical !== expected) throw new Error(`${label} input may not be an indirect symbolic link: ${file}`)
    const requested = await fs.lstat(file)
    if (requested.isSymbolicLink()) throw new Error(`${label} input may not be a symbolic link: ${file}`)
    if (!requested.isFile()) throw new Error(`${label} input must be a regular file: ${file}`)
    const handle = await fs.open(file, FS.O_RDONLY | (FS.O_NOFOLLOW ?? 0) | (FS.O_NONBLOCK ?? 0))
    const result = await Promise.resolve()
      .then(async () => {
        const info = await handle.stat()
        const current = await fs.lstat(file)
        const confirmed = await fs.realpath(file)
        if (
          !info.isFile() ||
          current.isSymbolicLink() ||
          confirmed !== expected ||
          requested.dev !== info.dev ||
          requested.ino !== info.ino ||
          current.dev !== info.dev ||
          current.ino !== info.ino
        ) {
          throw changed(file, label)
        }
        const snapshot = {
          size: info.size,
          dev: info.dev,
          ino: info.ino,
          mtimeMs: info.mtimeMs,
          ctimeMs: info.ctimeMs,
        }
        if (!valid(snapshot)) throw new Error(`${label} input has an invalid size: ${file}`)
        if (snapshot.size > LIMIT) throw new Error(`${label} input exceeds the 100 MiB approval limit: ${file}`)
        return { handle, snapshot }
      })
      .catch(async (error) => {
        await handle.close()
        throw error
      })
    return result
  }

  function expected(current: Snapshot, approved: Expected | undefined, file: string, label: string) {
    if (!approved) return
    if (
      current.size !== approved.size ||
      (approved.dev !== undefined && current.dev !== approved.dev) ||
      (approved.ino !== undefined && current.ino !== approved.ino) ||
      (approved.mtimeMs !== undefined && current.mtimeMs !== approved.mtimeMs) ||
      (approved.ctimeMs !== undefined && current.ctimeMs !== approved.ctimeMs)
    ) {
      throw new Error(`${label} input changed after approval: ${file}`)
    }
  }

  export function validate(files: Entry[], label = "Modal") {
    if (files.length > COUNT_LIMIT) throw new Error(`${label} uploads exceed the ${COUNT_LIMIT}-file approval limit`)
    const paths = new Set<string>()
    const sources = new Set<string>()
    const total = { value: 0 }
    for (const file of files) {
      const normalized = file.path.split(path.sep).join("/")
      if (
        !file.path ||
        file.path.includes("\\") ||
        file.path !== normalized ||
        path.posix.isAbsolute(file.path) ||
        file.path.split("/").some((part) => part === "" || part === "." || part === "..")
      ) {
        throw new Error(`${label} upload path must stay inside the remote workspace: ${file.path}`)
      }
      if (paths.has(file.path)) throw new Error(`${label} upload path is duplicated: ${file.path}`)
      paths.add(file.path)
      if (!path.isAbsolute(file.canonical)) throw new Error(`${label} upload source must be absolute: ${file.path}`)
      const source = path.resolve(file.canonical)
      if (sources.has(source)) throw new Error(`${label} upload source is duplicated: ${file.path}`)
      sources.add(source)
      if (!Number.isSafeInteger(file.size) || file.size < 0) {
        throw new Error(`${label} input has an invalid size: ${file.path}`)
      }
      if (file.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(file.sha256)) {
        throw new Error(`${label} input has an invalid checksum: ${file.path}`)
      }
      if (file.size > LIMIT) throw new Error(`${label} input exceeds the 100 MiB approval limit: ${file.path}`)
      if (file.size > LIMIT - total.value) throw new Error(`${label} uploads exceed the 100 MiB approval limit`)
      total.value += file.size
    }
    return total.value
  }

  export async function inspect(file: string, label = "Modal"): Promise<Snapshot> {
    const source = await opened(file, label)
    try {
      await stable(file, source.handle, source.snapshot, label)
      return source.snapshot
    } finally {
      await source.handle.close()
    }
  }

  async function consume(
    file: string,
    approved: Expected | undefined,
    label: string,
    write?: (chunk: Uint8Array) => Promise<void>,
  ) {
    const source = await opened(file, label)
    const digest = new Bun.CryptoHasher("sha256")
    const offset = { value: 0 }
    try {
      expected(source.snapshot, approved, file, label)
      await hooks.value?.read?.(file)
      const chunk = Buffer.allocUnsafe(64 * 1024)
      while (offset.value < source.snapshot.size) {
        const length = Math.min(chunk.byteLength, source.snapshot.size - offset.value)
        const result = await source.handle.read(chunk, 0, length, offset.value)
        if (!result.bytesRead) throw changed(file, label)
        const bytes = chunk.subarray(0, result.bytesRead)
        digest.update(bytes)
        await write?.(bytes)
        offset.value += result.bytesRead
      }
      await stable(file, source.handle, source.snapshot, label)
      if (offset.value !== source.snapshot.size) throw changed(file, label)
      const sha256 = digest.digest("hex")
      if (approved?.sha256 && sha256 !== approved.sha256) {
        throw new Error(`${label} input changed after approval: ${file}`)
      }
      return { size: offset.value, sha256 }
    } finally {
      await source.handle.close()
    }
  }

  export function hash(file: string, approved?: Expected, label = "Modal") {
    return consume(file, approved, label)
  }

  export async function stage(file: string, target: string, approved: Expected, label = "Modal") {
    return Promise.resolve()
      .then(async () => {
        const output = await fs.open(target, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL, 0o600)
        const offset = { value: 0 }
        try {
          return await consume(file, approved, label, async (chunk) => {
            const cursor = { value: 0 }
            while (cursor.value < chunk.byteLength) {
              const result = await output.write(chunk, cursor.value, chunk.byteLength - cursor.value, offset.value)
              if (!result.bytesWritten) throw new Error(`${label} input could not be staged: ${file}`)
              cursor.value += result.bytesWritten
              offset.value += result.bytesWritten
            }
          })
        } finally {
          await output.close()
        }
      })
      .catch(async (error) => {
        await fs.rm(target, { force: true })
        throw error
      })
  }
}

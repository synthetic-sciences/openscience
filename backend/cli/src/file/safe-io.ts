import { constants as FS } from "node:fs"
import fs, { type FileHandle } from "node:fs/promises"
import path from "node:path"
import { SafeDirectoryIO } from "./safe-directory-io"

/** Final-component symlink-safe file I/O for host broker operations. */
export namespace SafeFileIO {
  type TestHooks = {
    afterDirectoryVerify?: (target: string) => void | Promise<void>
    afterRenameVerify?: (source: string, target: string) => void | Promise<void>
    afterRenameMutation?: (source: string, target: string) => void | Promise<void>
  }

  const hooks = { value: undefined as TestHooks | undefined }

  /** Deterministic race barrier for the real handle-relative write path. */
  export function testing(input: TestHooks) {
    if (!process.env.OPENSCIENCE_TEST_HOME) throw new Error("SafeFileIO test hooks are disabled outside tests")
    const prior = hooks.value
    hooks.value = input
    return {
      [Symbol.dispose]() {
        if (hooks.value === input) hooks.value = prior
      },
    }
  }

  export class LimitError extends Error {
    constructor(
      readonly maxBytes: number,
      readonly size: number,
    ) {
      super(`File exceeds the ${maxBytes}-byte read limit`)
    }
  }

  export type Snapshot = {
    bytes: Buffer
    size: number
    dev: number
    ino: number
    mode: number
    mtimeMs: number
  }

  export type Entry = SafeDirectoryIO.Entry

  export type Range = {
    start: number
    end: number
  }

  export type Source = Omit<Snapshot, "bytes"> & {
    stream(range?: Range): ReadableStream<Uint8Array>
    close(): Promise<void>
  }

  type Options = {
    maxBytes?: number
    prefixBytes?: number
  }

  type OpenOptions = {
    maxBytes?: number
    during?: <T>(action: () => Promise<T>) => Promise<T>
    onClose?: () => void
  }

  async function bounded(handle: FileHandle, size: number, position = 0) {
    const bytes = Buffer.allocUnsafe(size)
    const read = { offset: 0 }
    while (read.offset < size) {
      const result = await handle.read(bytes, read.offset, size - read.offset, position + read.offset)
      if (!result.bytesRead) break
      read.offset += result.bytesRead
    }
    return bytes.subarray(0, read.offset)
  }

  async function opened(filepath: string, options?: Options) {
    const expected = path.resolve(filepath)
    const canonical = await fs.realpath(filepath)
    if (canonical !== expected) throw new Error(`Refusing to follow an indirect symbolic link: ${filepath}`)
    const requested = await fs.lstat(filepath)
    if (requested.isSymbolicLink()) throw new Error(`Refusing to follow a symbolic link: ${filepath}`)
    const handle = await fs.open(filepath, FS.O_RDONLY | FS.O_NOFOLLOW)
    try {
      const before = await handle.stat()
      const current = await fs.lstat(filepath)
      const confirmed = await fs.realpath(filepath)
      if (!before.isFile()) throw new Error(`Only regular files can be accessed: ${filepath}`)
      if (
        requested.dev !== before.dev ||
        requested.ino !== before.ino ||
        current.isSymbolicLink() ||
        current.dev !== before.dev ||
        current.ino !== before.ino ||
        confirmed !== expected
      ) {
        throw new Error(`Refusing to access ${filepath}: the file identity changed during access`)
      }
      if (options?.maxBytes !== undefined && before.size > options.maxBytes) {
        throw new LimitError(options.maxBytes, before.size)
      }
      return { handle, before }
    } catch (error) {
      await handle.close()
      throw error
    }
  }

  async function stable(filepath: string, handle: FileHandle, before: Awaited<ReturnType<FileHandle["stat"]>>) {
    const [after, current, canonical] = await Promise.all([handle.stat(), fs.lstat(filepath), fs.realpath(filepath)])
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      current.isSymbolicLink() ||
      current.dev !== after.dev ||
      current.ino !== after.ino ||
      canonical !== path.resolve(filepath)
    ) {
      throw new Error(`Refusing to read ${filepath}: the file changed during access`)
    }
    return after
  }

  export async function read(filepath: string, options?: Options): Promise<Snapshot> {
    const file = await opened(filepath, options)
    try {
      const length = Math.min(file.before.size, options?.prefixBytes ?? file.before.size)
      const bytes = await bounded(file.handle, length)
      const after = await stable(filepath, file.handle, file.before)
      if (bytes.byteLength !== length) {
        throw new Error(`Refusing to read ${filepath}: the file changed during access`)
      }
      return {
        bytes,
        size: after.size,
        dev: after.dev,
        ino: after.ino,
        mode: after.mode & 0o777,
        mtimeMs: after.mtimeMs,
      }
    } finally {
      await file.handle.close()
    }
  }

  export async function open(filepath: string, options?: OpenOptions): Promise<Source> {
    const file = await opened(filepath, options)
    const state = { started: false, closed: false }
    const close = async () => {
      if (state.closed) return
      state.closed = true
      try {
        await file.handle.close()
      } finally {
        options?.onClose?.()
      }
    }
    return {
      size: file.before.size,
      dev: file.before.dev,
      ino: file.before.ino,
      mode: file.before.mode & 0o777,
      mtimeMs: file.before.mtimeMs,
      close,
      stream(input) {
        if (state.started) throw new Error(`A safe file stream can only be consumed once: ${filepath}`)
        if (state.closed) throw new Error(`The safe file stream is already closed: ${filepath}`)
        const range = input ?? { start: 0, end: Math.max(0, file.before.size - 1) }
        if (
          !Number.isSafeInteger(range.start) ||
          !Number.isSafeInteger(range.end) ||
          range.start < 0 ||
          range.end < range.start ||
          (file.before.size > 0 && range.end >= file.before.size) ||
          (file.before.size === 0 && (range.start !== 0 || range.end !== 0))
        ) {
          throw new RangeError(`Invalid byte range ${range.start}-${range.end} for ${file.before.size}-byte file`)
        }
        state.started = true
        const cursor = { offset: range.start }
        const finish = async () => {
          try {
            await stable(filepath, file.handle, file.before)
          } finally {
            await close()
          }
        }
        return new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const read = async () => {
                if (file.before.size === 0 || cursor.offset > range.end) {
                  await finish()
                  controller.close()
                  return
                }
                const length = Math.min(64 * 1024, range.end - cursor.offset + 1)
                const chunk = Buffer.allocUnsafe(length)
                const result = await file.handle.read(chunk, 0, length, cursor.offset)
                if (!result.bytesRead) throw new Error(`Refusing to read ${filepath}: the file changed during access`)
                cursor.offset += result.bytesRead
                controller.enqueue(chunk.subarray(0, result.bytesRead))
                if (cursor.offset <= range.end) return
                await finish()
                controller.close()
              }
              if (options?.during) await options.during(read)
              else await read()
            } catch (error) {
              await close().catch(() => undefined)
              controller.error(error)
            }
          },
          async cancel() {
            await finish()
          },
        })
      },
    }
  }

  export async function optional(filepath: string, options?: Options) {
    return read(filepath, options).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined
      throw error
    })
  }

  export async function absent(filepath: string) {
    const exists = await fs.lstat(filepath).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false
        throw error
      },
    )
    if (exists) throw new Error(`Refusing to overwrite an unapproved file: ${filepath}`)
  }

  export async function assert(filepath: string, approved: Snapshot) {
    const current = await read(filepath)
    if (current.dev !== approved.dev || current.ino !== approved.ino) {
      throw new Error(`Refusing to write ${filepath}: the file identity changed after approval`)
    }
    if (!current.bytes.equals(approved.bytes)) {
      throw new Error(`Refusing to write ${filepath}: the file changed after approval`)
    }
  }

  export async function write(filepath: string, content: string | Uint8Array, approved?: Snapshot) {
    if (!approved) {
      await absent(filepath)
      await SafeDirectoryIO.write(filepath, content, {
        mode: 0o644,
        afterVerify: hooks.value?.afterDirectoryVerify,
      })
      return
    }

    await assert(filepath, approved)
    await SafeDirectoryIO.write(filepath, content, {
      mode: approved.mode,
      approved,
      afterVerify: hooks.value?.afterDirectoryVerify,
    })
  }

  export function inspect(filepath: string) {
    return SafeDirectoryIO.inspect(filepath)
  }

  export function rename(source: string, target: string, expected: Entry) {
    return SafeDirectoryIO.moveNoReplace(source, target, expected, {
      afterVerify: hooks.value?.afterRenameVerify,
      afterMutation: hooks.value?.afterRenameMutation,
    })
  }
}

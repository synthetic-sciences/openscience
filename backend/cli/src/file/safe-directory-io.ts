import crypto from "node:crypto"
import nodefs, { constants as FS, type Stats } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { dlopen, FFIType, toArrayBuffer, type Pointer } from "bun:ffi"
import { WindowsSafeIO } from "./windows-safe-io"

/**
 * Handle-relative writes for paths whose parent directory can be renamed by a
 * concurrent process. Path checks select and verify the directory once; every
 * mutation after that is anchored to the held directory descriptor.
 */
export namespace SafeDirectoryIO {
  type Snapshot = {
    bytes: Buffer
    dev: number
    ino: number
  }

  export type Entry = {
    dev: number
    ino: number
    type: "file" | "directory"
  }

  export type Options = {
    mode: number
    approved?: Snapshot
    afterVerify?: (target: string) => void | Promise<void>
  }

  export type MoveOptions = {
    afterVerify?: (source: string, target: string) => void | Promise<void>
    afterMutation?: (source: string, target: string) => void | Promise<void>
  }

  export type SwapOptions = {
    afterVerify?: (left: string, right: string) => void | Promise<void>
    afterMutation?: (left: string, right: string) => void | Promise<void>
  }

  type Directory = {
    fd: number
    expected: string
    before: Stats
    close(): Promise<void>
  }

  type Native = {
    library: ReturnType<typeof dlopen>
    openat(dir: number, name: Buffer, flags: number, mode: number): number
    mkdirat(dir: number, name: Buffer, mode: number): number
    linkat(fromDir: number, from: Buffer, toDir: number, to: Buffer, flags: number): number
    renameat(fromDir: number, from: Buffer, toDir: number, to: Buffer): number
    renameNoReplace(fromDir: number, from: Buffer, toDir: number, to: Buffer): number
    renameSwap(fromDir: number, from: Buffer, toDir: number, to: Buffer): number
    unlinkat(dir: number, name: Buffer, flags: number): number
    errno(): number
  }

  type Held = {
    fd: number
    entry: Entry
    close(): Promise<void>
  }

  const EEXIST = 17
  const EINTR = 4
  const ENOENT = 2
  const O_CLOEXEC = process.platform === "darwin" ? 0x01000000 : 0x00080000
  const RENAME_EXCL = 0x4
  const RENAME_NOREPLACE = 0x1
  const RENAME_SWAP = 0x2
  const natives = { value: undefined as Native | undefined }

  function libraries() {
    if (process.platform === "darwin") return ["/usr/lib/libSystem.B.dylib"]
    if (process.arch === "arm64") {
      return ["libc.so.6", "/lib/aarch64-linux-gnu/libc.so.6", "/lib/libc.musl-aarch64.so.1"]
    }
    return ["libc.so.6", "/lib/x86_64-linux-gnu/libc.so.6", "/lib64/libc.so.6", "/lib/libc.musl-x86_64.so.1"]
  }

  function native(): Native {
    if (process.platform !== "darwin" && process.platform !== "linux") {
      throw new Error("Safe handle-relative file mutations are not available on this platform")
    }
    if (natives.value) return natives.value
    const symbol = process.platform === "darwin" ? "__error" : "__errno_location"
    const loaded = { library: undefined as ReturnType<typeof dlopen> | undefined, error: undefined as unknown }
    for (const candidate of libraries()) {
      try {
        loaded.library = dlopen(candidate, {
          openat: {
            args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.u32],
            returns: FFIType.i32,
          },
          mkdirat: {
            args: [FFIType.i32, FFIType.ptr, FFIType.u32],
            returns: FFIType.i32,
          },
          linkat: {
            args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.i32],
            returns: FFIType.i32,
          },
          renameat: {
            args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr],
            returns: FFIType.i32,
          },
          ...(process.platform === "darwin"
            ? {
                renameatx_np: {
                  args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
                  returns: FFIType.i32,
                },
              }
            : {
                renameat2: {
                  args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
                  returns: FFIType.i32,
                },
              }),
          unlinkat: {
            args: [FFIType.i32, FFIType.ptr, FFIType.i32],
            returns: FFIType.i32,
          },
          [symbol]: {
            args: [],
            returns: FFIType.ptr,
          },
        })
        break
      } catch (error) {
        loaded.error = error
      }
    }
    if (!loaded.library) {
      throw loaded.error ?? new Error("Could not load the host C library for safe handle-relative writes")
    }
    const symbols = loaded.library.symbols as Record<string, unknown>
    const location = symbols[symbol] as () => number | bigint | null
    const exclusive = (process.platform === "darwin" ? symbols.renameatx_np : symbols.renameat2) as (
      fromDir: number,
      from: Buffer,
      toDir: number,
      to: Buffer,
      flags: number,
    ) => number
    const errno = () => {
      const pointer = location()
      if (!pointer) return 0
      return new Int32Array(toArrayBuffer(pointer as Pointer, 0, 4))[0] ?? 0
    }
    natives.value = {
      library: loaded.library,
      openat: symbols.openat as Native["openat"],
      mkdirat: symbols.mkdirat as Native["mkdirat"],
      linkat: symbols.linkat as Native["linkat"],
      renameat: symbols.renameat as Native["renameat"],
      renameNoReplace: (fromDir, from, toDir, to) =>
        exclusive(fromDir, from, toDir, to, process.platform === "darwin" ? RENAME_EXCL : RENAME_NOREPLACE),
      renameSwap: (fromDir, from, toDir, to) => exclusive(fromDir, from, toDir, to, RENAME_SWAP),
      unlinkat: symbols.unlinkat as Native["unlinkat"],
      errno,
    }
    return natives.value
  }

  function basename(value: string) {
    if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\0")) {
      throw new Error(`Unsafe handle-relative file name: ${JSON.stringify(value)}`)
    }
    return value
  }

  function direct(target: string) {
    const resolved = path.resolve(target)
    const file = basename(path.basename(resolved))
    if (path.join(path.dirname(resolved), file) !== resolved) {
      throw new Error(`File mutation destination is not a direct child path: ${target}`)
    }
    return { path: resolved, parent: path.dirname(resolved), file }
  }

  function name(value: string) {
    return Buffer.from(`${basename(value)}\0`)
  }

  function error(action: string, target: string, errno: number) {
    const result = new Error(`${action} failed for ${target} (errno ${errno})`) as NodeJS.ErrnoException
    result.errno = errno
    return result
  }

  function invoke(action: string, target: string, call: () => number) {
    while (true) {
      const result = call()
      if (result >= 0) return result
      const code = native().errno()
      if (code === EINTR) continue
      throw error(action, target, code)
    }
  }

  function attempt(call: () => number) {
    while (true) {
      const result = call()
      if (result >= 0) return { ok: true as const, value: result }
      const code = native().errno()
      if (code === EINTR) continue
      return { ok: false as const, errno: code }
    }
  }

  function close(fd: number) {
    return new Promise<void>((resolve, reject) => {
      nodefs.close(fd, (error) => (error ? reject(error) : resolve()))
    })
  }

  function stat(fd: number) {
    return new Promise<Stats>((resolve, reject) => {
      nodefs.fstat(fd, (error, value) => (error ? reject(error) : resolve(value)))
    })
  }

  function identity(info: Stats, target: string): Entry {
    const type = info.isFile() ? "file" : info.isDirectory() ? "directory" : undefined
    if (!type) throw new Error(`Only regular files and directories can be moved: ${target}`)
    return { dev: info.dev, ino: info.ino, type }
  }

  function matches(left: Entry, right: Entry) {
    return left.dev === right.dev && left.ino === right.ino && left.type === right.type
  }

  function sync(fd: number, directory = false) {
    return new Promise<void>((resolve, reject) => {
      nodefs.fsync(fd, (error) => {
        if (!error) return resolve()
        if (directory && process.platform === "darwin" && (error.code === "EINVAL" || error.code === "ENOTSUP")) {
          return resolve()
        }
        reject(error)
      })
    })
  }

  function chmod(fd: number, mode: number) {
    return new Promise<void>((resolve, reject) => {
      nodefs.fchmod(fd, mode, (error) => (error ? reject(error) : resolve()))
    })
  }

  function writeChunk(fd: number, bytes: Uint8Array, offset: number) {
    return new Promise<number>((resolve, reject) => {
      nodefs.write(fd, bytes, offset, bytes.byteLength - offset, null, (error, written) =>
        error ? reject(error) : resolve(written),
      )
    })
  }

  function readChunk(fd: number, bytes: Buffer, offset: number, position: number) {
    return new Promise<number>((resolve, reject) => {
      nodefs.read(fd, bytes, offset, bytes.byteLength - offset, position, (error, count) =>
        error ? reject(error) : resolve(count),
      )
    })
  }

  async function writeAll(fd: number, bytes: Uint8Array) {
    const cursor = { value: 0 }
    while (cursor.value < bytes.byteLength) {
      const count = await writeChunk(fd, bytes, cursor.value)
      if (!count) throw new Error("Handle-relative write made no progress")
      cursor.value += count
    }
  }

  async function readAll(fd: number, size: number) {
    const bytes = Buffer.allocUnsafe(size)
    const cursor = { value: 0 }
    while (cursor.value < size) {
      const count = await readChunk(fd, bytes, cursor.value, cursor.value)
      if (!count) break
      cursor.value += count
    }
    return bytes.subarray(0, cursor.value)
  }

  async function verify(directory: Directory) {
    const [after, current, canonical] = await Promise.all([
      stat(directory.fd),
      fs.lstat(directory.expected),
      fs.realpath(directory.expected),
    ]).catch(() => [undefined, undefined, undefined] as const)
    if (
      !after?.isDirectory() ||
      !current?.isDirectory() ||
      current.isSymbolicLink() ||
      directory.before.dev !== after.dev ||
      directory.before.ino !== after.ino ||
      current.dev !== after.dev ||
      current.ino !== after.ino ||
      canonical !== directory.expected
    ) {
      throw new Error(`Write destination directory identity changed during access: ${directory.expected}`)
    }
  }

  async function openExisting(directory: string): Promise<Directory> {
    const expected = path.resolve(directory)
    const canonical = await fs.realpath(expected)
    if (canonical !== expected) throw new Error(`Write destination became ambiguous: ${directory}`)
    const requested = await fs.lstat(expected)
    if (!requested.isDirectory() || requested.isSymbolicLink()) {
      throw new Error(`Write destination is not a direct directory: ${directory}`)
    }
    const handle = await fs.open(expected, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW | O_CLOEXEC)
    try {
      const result: Directory = {
        fd: handle.fd,
        expected,
        before: await handle.stat(),
        close: () => handle.close(),
      }
      await verify(result)
      return result
    } catch (error) {
      await handle.close()
      throw error
    }
  }

  async function openEntry(directory: Directory, file: string, target: string): Promise<Held> {
    const api = native()
    const fd = invoke("openat", target, () =>
      api.openat(directory.fd, name(file), FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK | O_CLOEXEC, 0),
    )
    try {
      return {
        fd,
        entry: identity(await stat(fd), target),
        close: () => close(fd),
      }
    } catch (error) {
      await close(fd)
      throw error
    }
  }

  async function child(parent: Directory, segment: string, expected: string): Promise<Directory> {
    const api = native()
    const created = attempt(() => api.mkdirat(parent.fd, name(segment), 0o755))
    if (!created.ok && created.errno !== EEXIST) throw error("mkdirat", expected, created.errno)
    if (created.ok) await sync(parent.fd, true)
    const fd = invoke("openat", expected, () =>
      api.openat(parent.fd, name(segment), FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW | O_CLOEXEC, 0),
    )
    try {
      const result: Directory = {
        fd,
        expected,
        before: await stat(fd),
        close: () => close(fd),
      }
      await verify(result)
      return result
    } catch (error) {
      await close(fd)
      throw error
    }
  }

  async function directory(target: string): Promise<Directory> {
    const expected = path.resolve(path.dirname(target))
    const missing: string[] = []
    const cursor = { value: expected }
    while (true) {
      const info = await fs.lstat(cursor.value).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return
        throw error
      })
      if (info) break
      const parent = path.dirname(cursor.value)
      if (parent === cursor.value) throw new Error(`No existing directory anchors write destination: ${target}`)
      missing.unshift(basename(path.basename(cursor.value)))
      cursor.value = parent
    }
    const initial = await openExisting(cursor.value)
    const current = { value: initial }
    try {
      for (const segment of missing) {
        const next = await child(current.value, segment, path.join(current.value.expected, segment))
        const prior = current.value
        current.value = next
        await prior.close()
      }
      if (current.value.expected !== expected) {
        throw new Error(`Write destination directory could not be anchored: ${expected}`)
      }
      return current.value
    } catch (error) {
      await current.value.close().catch(() => undefined)
      throw error
    }
  }

  async function stage(directory: Directory, content: string | Uint8Array, mode: number) {
    const api = native()
    const staged = basename(`.openscience-write-${crypto.randomUUID()}.tmp`)
    const fd = invoke("openat", staged, () =>
      api.openat(directory.fd, name(staged), FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW | O_CLOEXEC, mode),
    )
    const state = { closed: false }
    try {
      const bytes = typeof content === "string" ? Buffer.from(content) : content
      await writeAll(fd, bytes)
      await chmod(fd, mode)
      await sync(fd)
      await close(fd)
      state.closed = true
      return staged
    } catch (cause) {
      if (!state.closed) await close(fd).catch(() => undefined)
      const cleanup = attempt(() => native().unlinkat(directory.fd, name(staged), 0))
      if (!cleanup.ok && cleanup.errno !== ENOENT) {
        throw new AggregateError([cause, error("unlinkat", staged, cleanup.errno)], "Staged write cleanup failed")
      }
      throw cause
    }
  }

  async function snapshot(directory: Directory, file: string, approved: Snapshot) {
    const api = native()
    const fd = invoke("openat", file, () =>
      api.openat(directory.fd, name(file), FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK | O_CLOEXEC, 0),
    )
    try {
      const before = await stat(fd)
      if (!before.isFile()) throw new Error(`Only regular files can be approved for replacement: ${file}`)
      // Compare before allocating: concurrent sparse-file growth must not turn
      // a small editor save into an unbounded read under mutation authority.
      if (before.dev !== approved.dev || before.ino !== approved.ino || before.size !== approved.bytes.byteLength) {
        throw new Error(`Refusing to write ${file}: the approved file changed before replacement`)
      }
      const bytes = await readAll(fd, before.size)
      const after = await stat(fd)
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        bytes.byteLength !== before.size
      ) {
        throw new Error(`Approved file changed during handle-relative validation: ${file}`)
      }
      return { bytes, dev: after.dev, ino: after.ino }
    } finally {
      await close(fd)
    }
  }

  function unlink(directory: Directory, file: string, flags = 0) {
    const api = native()
    const result = attempt(() => api.unlinkat(directory.fd, name(file), flags))
    if (result.ok || result.errno === ENOENT) return
    throw error("unlinkat", file, result.errno)
  }

  function link(directory: Directory, from: string, to: string) {
    const api = native()
    const result = attempt(() => api.linkat(directory.fd, name(from), directory.fd, name(to), 0))
    if (result.ok) return
    if (result.errno === EEXIST) throw new Error(`Refusing to overwrite an unapproved file: ${to}`)
    throw error("linkat", `${from} -> ${to}`, result.errno)
  }

  function rename(directory: Directory, from: string, to: string) {
    const api = native()
    invoke("renameat", `${from} -> ${to}`, () => api.renameat(directory.fd, name(from), directory.fd, name(to)))
  }

  function move(from: Directory, source: string, to: Directory, target: string) {
    const api = native()
    invoke("exclusive rename", `${source} -> ${target}`, () =>
      api.renameNoReplace(from.fd, name(source), to.fd, name(target)),
    )
  }

  function swap(directory: Directory, left: string, right: string) {
    const api = native()
    invoke("atomic swap", `${left} <-> ${right}`, () =>
      api.renameSwap(directory.fd, name(left), directory.fd, name(right)),
    )
  }

  async function syncMove(from: Directory, to: Directory) {
    await sync(from.fd, true)
    if (from.fd !== to.fd) await sync(to.fd, true)
  }

  async function verifyMove(from: Directory, to: Directory) {
    await verify(from)
    if (from.fd !== to.fd) await verify(to)
  }

  async function rollback(from: Directory, source: string, to: Directory, target: string, expected: Entry) {
    const staged = basename(`.openscience-rename-${crypto.randomUUID()}.tmp`)
    move(to, target, to, staged)
    await sync(to.fd, true)
    const current = await openEntry(to, staged, path.join(to.expected, staged))
    const valid = matches(current.entry, expected)
    await current.close()
    if (!valid) {
      try {
        move(to, staged, to, target)
        await sync(to.fd, true)
      } catch (error) {
        throw new AggregateError(
          [error],
          `Renamed source identity changed before rollback; unexpected entry retained under ${staged}`,
        )
      }
      throw new Error("Renamed source identity changed before rollback; the unexpected target was restored")
    }
    try {
      move(to, staged, from, source)
      await syncMove(from, to)
    } catch (error) {
      throw new AggregateError([error], `Rename rollback failed; original retained under ${staged}`)
    }
  }

  async function install(directory: Directory, staged: string, target: string) {
    link(directory, staged, target)
    try {
      await sync(directory.fd, true)
      await verify(directory)
    } catch (error) {
      unlink(directory, target)
      await sync(directory.fd, true).catch(() => undefined)
      throw error
    }
  }

  async function replace(directory: Directory, staged: string, target: string, approved: Snapshot) {
    const backup = basename(`.openscience-approved-${crypto.randomUUID()}.bak`)
    const state = { moved: false }
    try {
      rename(directory, target, backup)
      state.moved = true
      const current = await snapshot(directory, backup, approved)
      if (current.dev !== approved.dev || current.ino !== approved.ino || !current.bytes.equals(approved.bytes)) {
        throw new Error(`Refusing to write ${target}: the approved file changed before replacement`)
      }
      await install(directory, staged, target)
    } catch (cause) {
      if (state.moved) {
        const failures: unknown[] = [cause]
        try {
          link(directory, backup, target)
          unlink(directory, backup)
          await sync(directory.fd, true)
        } catch (error) {
          failures.push(error)
        }
        if (failures.length > 1) {
          throw new AggregateError(failures, `Write failed; original retained under ${backup}`)
        }
      }
      throw cause
    }
    unlink(directory, staged)
    unlink(directory, backup)
    await sync(directory.fd, true)
  }

  export async function write(target: string, content: string | Uint8Array, options: Options) {
    if (process.platform === "win32") return WindowsSafeIO.write(target, content, options)
    const resolved = direct(target)
    const parent = await directory(resolved.path)
    try {
      await verify(parent)
      await options.afterVerify?.(resolved.path)
      const staged = await stage(parent, content, options.mode)
      try {
        if (options.approved) await replace(parent, staged, resolved.file, options.approved)
        else {
          await install(parent, staged, resolved.file)
          unlink(parent, staged)
          await sync(parent.fd, true)
        }
      } finally {
        unlink(parent, staged)
      }
    } finally {
      await parent.close()
    }
  }

  export async function inspect(target: string): Promise<Entry> {
    if (process.platform === "win32") return WindowsSafeIO.inspect(target)
    const resolved = direct(target)
    const parent = await openExisting(resolved.parent)
    try {
      await verify(parent)
      const current = await openEntry(parent, resolved.file, resolved.path)
      try {
        await verify(parent)
        return current.entry
      } finally {
        await current.close()
      }
    } finally {
      await parent.close()
    }
  }

  export async function moveNoReplace(source: string, target: string, expected: Entry, options?: MoveOptions) {
    if (process.platform === "win32") return WindowsSafeIO.moveNoReplace(source, target, expected, options)
    const fromPath = direct(source)
    const toPath = direct(target)
    const from = await openExisting(fromPath.parent)
    const same = fromPath.parent === toPath.parent
    const to = await (same
      ? Promise.resolve(from)
      : openExisting(toPath.parent).catch(async (error) => {
          await from.close()
          throw error
        }))
    const current = await openEntry(from, fromPath.file, fromPath.path).catch(async (error) => {
      await Promise.all([from.close(), ...(!same ? [to.close()] : [])])
      throw error
    })
    const state = { moved: false }
    try {
      await verifyMove(from, to)
      if (!matches(current.entry, expected)) {
        throw new Error(`Refusing to rename ${source}: the source identity changed after approval`)
      }
      await options?.afterVerify?.(fromPath.path, toPath.path)

      const final = await openEntry(from, fromPath.file, fromPath.path)
      try {
        await verifyMove(from, to)
        if (!matches(final.entry, expected)) {
          throw new Error(`Refusing to rename ${source}: the source identity changed before mutation`)
        }
      } finally {
        await final.close()
      }

      move(from, fromPath.file, to, toPath.file)
      state.moved = true
      await options?.afterMutation?.(fromPath.path, toPath.path)
      await syncMove(from, to)
      const moved = await openEntry(to, toPath.file, toPath.path)
      try {
        if (!matches(moved.entry, expected)) {
          throw new Error(`Refusing to complete rename ${target}: the moved source identity changed`)
        }
      } finally {
        await moved.close()
      }
      await verifyMove(from, to)
      return expected
    } catch (cause) {
      if (!state.moved) throw cause
      try {
        await rollback(from, fromPath.file, to, toPath.file, expected)
      } catch (error) {
        throw new AggregateError([cause, error], "Rename failed and could not be rolled back safely")
      }
      throw cause
    } finally {
      await Promise.all([current.close(), from.close(), ...(!same ? [to.close()] : [])])
    }
  }

  export async function swapEntries(
    left: string,
    right: string,
    leftExpected: Entry,
    rightExpected: Entry,
    options?: SwapOptions,
  ) {
    if (process.platform !== "darwin") throw new Error("Atomic application exchange requires macOS")
    const leftPath = direct(left)
    const rightPath = direct(right)
    if (leftPath.parent !== rightPath.parent) throw new Error("Atomic exchange entries must be siblings")
    const parent = await openExisting(leftPath.parent)
    const state = { swapped: false }
    try {
      await verify(parent)
      const [leftEntry, rightEntry] = await Promise.all([
        openEntry(parent, leftPath.file, leftPath.path),
        openEntry(parent, rightPath.file, rightPath.path),
      ])
      try {
        if (!matches(leftEntry.entry, leftExpected) || !matches(rightEntry.entry, rightExpected)) {
          throw new Error("Atomic exchange entries changed after approval")
        }
      } finally {
        await Promise.all([leftEntry.close(), rightEntry.close()])
      }
      await options?.afterVerify?.(leftPath.path, rightPath.path)
      await verify(parent)
      const [finalLeft, finalRight] = await Promise.all([
        openEntry(parent, leftPath.file, leftPath.path),
        openEntry(parent, rightPath.file, rightPath.path),
      ])
      try {
        if (!matches(finalLeft.entry, leftExpected) || !matches(finalRight.entry, rightExpected)) {
          throw new Error("Atomic exchange entries changed before mutation")
        }
      } finally {
        await Promise.all([finalLeft.close(), finalRight.close()])
      }
      swap(parent, leftPath.file, rightPath.file)
      state.swapped = true
      await options?.afterMutation?.(leftPath.path, rightPath.path)
      await sync(parent.fd, true)
      const [receivedLeft, receivedRight] = await Promise.all([
        openEntry(parent, leftPath.file, leftPath.path),
        openEntry(parent, rightPath.file, rightPath.path),
      ])
      try {
        if (!matches(receivedLeft.entry, rightExpected) || !matches(receivedRight.entry, leftExpected)) {
          throw new Error("Atomic exchange produced unexpected directory entries")
        }
      } finally {
        await Promise.all([receivedLeft.close(), receivedRight.close()])
      }
      await verify(parent)
    } catch (cause) {
      if (!state.swapped) throw cause
      try {
        const [rollbackLeft, rollbackRight] = await Promise.all([
          openEntry(parent, leftPath.file, leftPath.path),
          openEntry(parent, rightPath.file, rightPath.path),
        ])
        try {
          if (!matches(rollbackLeft.entry, rightExpected) || !matches(rollbackRight.entry, leftExpected)) {
            throw new Error("Atomic exchange entries changed before rollback")
          }
        } finally {
          await Promise.all([rollbackLeft.close(), rollbackRight.close()])
        }
        swap(parent, leftPath.file, rightPath.file)
        await sync(parent.fd, true)
      } catch (error) {
        throw new AggregateError(
          [cause, error],
          "Atomic exchange failed and could not be rolled back without replacing an unapproved entry",
        )
      }
      throw cause
    } finally {
      await parent.close()
    }
  }
}

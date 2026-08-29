import crypto from "node:crypto"
import nodefs, { constants as FS, type Stats } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { dlopen, FFIType, toArrayBuffer, type Pointer } from "bun:ffi"
import { SafeDirectoryIO } from "../file/safe-directory-io"
import { SafeTrashIO } from "../file/safe-trash-io"

/**
 * Snapshot mutations anchored to verified directory handles.
 *
 * Snapshot restore must replace files, directories, and symlinks, which is a
 * wider contract than SafeDirectoryIO.write. POSIX therefore uses a small
 * *at(2)-only tree mutator here. Windows reuses the platform's handle-locked
 * safe I/O primitives and fails closed for symlink restoration.
 */
export namespace SnapshotSafeIO {
  export type Entry = { kind: "file"; content: Uint8Array; mode: number } | { kind: "symlink"; target: string }

  export type Operation = "remove" | "restore"

  export type Hooks = {
    afterParentVerify?: (operation: Operation, target: string) => void | Promise<void>
    writeChunkLimit?: (offset: number, remaining: number) => number
    mountIdentity?: (target: string, actual: string) => string | Promise<string>
  }

  type Directory = {
    fd: number
    expected: string
    before: Stats
    mount: string
    close(): Promise<void>
  }

  type Native = {
    library: ReturnType<typeof dlopen>
    openat(dir: number, name: Buffer, flags: number, mode: number): number
    mkdirat(dir: number, name: Buffer, mode: number): number
    renameExclusive(fromDir: number, from: Buffer, toDir: number, to: Buffer): number
    unlinkat(dir: number, name: Buffer, flags: number): number
    symlinkat(target: Buffer, dir: number, name: Buffer): number
    fstatfs(fd: number, buffer: Buffer): number
    dup(fd: number): number
    fdopendir(fd: number): number | bigint | null
    readdir(directory: number | bigint): number | bigint | null
    closedir(directory: number | bigint): number
    errno(): number
  }

  const EINTR = 4
  const ENOENT = 2
  const EEXIST = 17
  const ENOTDIR = 20
  const ELOOP = process.platform === "darwin" ? 62 : 40
  const AT_REMOVEDIR = process.platform === "darwin" ? 0x80 : 0x200
  const O_CLOEXEC = process.platform === "darwin" ? 0x01000000 : 0x00080000
  const natives = { value: undefined as Native | undefined }

  function libraries() {
    if (process.platform === "darwin") return ["/usr/lib/libSystem.B.dylib"]
    if (process.arch === "arm64") {
      return ["libc.so.6", "/lib/aarch64-linux-gnu/libc.so.6", "/lib/libc.musl-aarch64.so.1"]
    }
    return ["libc.so.6", "/lib/x86_64-linux-gnu/libc.so.6", "/lib64/libc.so.6", "/lib/libc.musl-x86_64.so.1"]
  }

  function native(): Native {
    if (process.platform === "win32") throw new Error("POSIX snapshot mutations are unavailable on Windows")
    if (natives.value) return natives.value
    const errnoSymbol = process.platform === "darwin" ? "__error" : "__errno_location"
    const renameSymbol = process.platform === "darwin" ? "renameatx_np" : "renameat2"
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
          [renameSymbol]: {
            args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
            returns: FFIType.i32,
          },
          unlinkat: {
            args: [FFIType.i32, FFIType.ptr, FFIType.i32],
            returns: FFIType.i32,
          },
          symlinkat: {
            args: [FFIType.ptr, FFIType.i32, FFIType.ptr],
            returns: FFIType.i32,
          },
          fstatfs: {
            args: [FFIType.i32, FFIType.ptr],
            returns: FFIType.i32,
          },
          dup: {
            args: [FFIType.i32],
            returns: FFIType.i32,
          },
          fdopendir: {
            args: [FFIType.i32],
            returns: FFIType.ptr,
          },
          readdir: {
            args: [FFIType.ptr],
            returns: FFIType.ptr,
          },
          closedir: {
            args: [FFIType.ptr],
            returns: FFIType.i32,
          },
          [errnoSymbol]: {
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
      throw loaded.error ?? new Error("Could not load the host C library for safe snapshot mutations")
    }
    const symbols = loaded.library.symbols as Record<string, unknown>
    const errnoLocation = symbols[errnoSymbol] as () => number | bigint | null
    const renameExclusive = symbols[renameSymbol] as (
      fromDir: number,
      from: Buffer,
      toDir: number,
      to: Buffer,
      flags: number,
    ) => number
    const errno = () => {
      const pointer = errnoLocation()
      if (!pointer) return 0
      return new Int32Array(toArrayBuffer(pointer as Pointer, 0, 4))[0] ?? 0
    }
    natives.value = {
      library: loaded.library,
      openat: symbols.openat as Native["openat"],
      mkdirat: symbols.mkdirat as Native["mkdirat"],
      renameExclusive: (fromDir, from, toDir, to) =>
        renameExclusive(fromDir, from, toDir, to, process.platform === "darwin" ? 0x4 : 0x1),
      unlinkat: symbols.unlinkat as Native["unlinkat"],
      symlinkat: symbols.symlinkat as Native["symlinkat"],
      fstatfs: symbols.fstatfs as Native["fstatfs"],
      dup: symbols.dup as Native["dup"],
      fdopendir: symbols.fdopendir as Native["fdopendir"],
      readdir: symbols.readdir as Native["readdir"],
      closedir: symbols.closedir as Native["closedir"],
      errno,
    }
    return natives.value
  }

  function segment(value: string) {
    if (
      !value ||
      value === "." ||
      value === ".." ||
      value.includes("/") ||
      (process.platform === "win32" && value.includes("\\")) ||
      value.includes("\0")
    ) {
      throw new Error(`Unsafe handle-relative snapshot name: ${JSON.stringify(value)}`)
    }
    return value
  }

  function name(value: string) {
    return Buffer.from(`${segment(value)}\0`)
  }

  function linkTarget(value: string) {
    if (value.includes("\0")) throw new Error("Snapshot symlink targets cannot contain NUL bytes")
    return Buffer.from(`${value}\0`)
  }

  function target(root: string, relative: string) {
    if (
      !relative ||
      path.posix.isAbsolute(relative) ||
      (process.platform === "win32" && path.win32.isAbsolute(relative))
    ) {
      throw new Error(`Unsafe snapshot path: ${relative}`)
    }
    const pieces = relative.split("/").map(segment)
    const resolvedRoot = path.resolve(root)
    return {
      root: resolvedRoot,
      pieces,
      path: path.join(resolvedRoot, ...pieces),
    }
  }

  function failure(action: string, value: string, errno: number) {
    const result = new Error(`${action} failed for ${value} (errno ${errno})`) as NodeJS.ErrnoException
    result.errno = errno
    if (errno === ENOENT) result.code = "ENOENT"
    if (errno === EEXIST) result.code = "EEXIST"
    return result
  }

  function attempt(call: () => number) {
    while (true) {
      const result = call()
      if (result >= 0) return { ok: true as const, value: result }
      const errno = native().errno()
      if (errno === EINTR) continue
      return { ok: false as const, errno }
    }
  }

  function invoke(action: string, value: string, call: () => number) {
    const result = attempt(call)
    if (result.ok) return result.value
    throw failure(action, value, result.errno)
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

  function write(fd: number, bytes: Uint8Array, offset: number, requested?: number) {
    const remaining = bytes.byteLength - offset
    const length = requested === undefined ? remaining : Math.min(remaining, requested)
    if (!Number.isSafeInteger(length) || length <= 0) throw new Error("Invalid handle-relative snapshot write length")
    return new Promise<number>((resolve, reject) => {
      nodefs.write(fd, bytes, offset, length, null, (error, count) => (error ? reject(error) : resolve(count)))
    })
  }

  async function writeAll(fd: number, bytes: Uint8Array, hooks?: Hooks) {
    const offset = { value: 0 }
    while (offset.value < bytes.byteLength) {
      const remaining = bytes.byteLength - offset.value
      const requested = hooks?.writeChunkLimit?.(offset.value, remaining)
      const count = await write(fd, bytes, offset.value, requested)
      if (!count) throw new Error("Handle-relative snapshot write made no progress")
      if (count > remaining) throw new Error("Handle-relative snapshot write exceeded the remaining buffer")
      offset.value += count
    }
  }

  async function verify(directory: Directory) {
    const [held, current, canonical] = await Promise.all([
      stat(directory.fd),
      fs.lstat(directory.expected),
      fs.realpath(directory.expected),
    ]).catch(() => [undefined, undefined, undefined] as const)
    if (
      !held?.isDirectory() ||
      !current?.isDirectory() ||
      current.isSymbolicLink() ||
      held.dev !== directory.before.dev ||
      held.ino !== directory.before.ino ||
      current.dev !== held.dev ||
      current.ino !== held.ino ||
      canonical !== directory.expected
    ) {
      throw new Error(`Snapshot parent directory identity changed during access: ${directory.expected}`)
    }
  }

  function string(bytes: Uint8Array) {
    const end = bytes.indexOf(0)
    return Buffer.from(bytes.subarray(0, end < 0 ? bytes.byteLength : end)).toString("utf8")
  }

  async function mount(fd: number, target: string, hooks?: Hooks) {
    const actual = await (async () => {
      if (process.platform === "linux") {
        const info = await fs.readFile(`/proc/self/fdinfo/${fd}`, "utf8").catch((error) => {
          throw new Error(`Could not read the kernel mount identity for ${target}`, { cause: error })
        })
        const id = info.match(/^mnt_id:\s*(\d+)$/m)?.[1]
        if (!id) throw new Error(`Kernel mount identity is unavailable for ${target}`)
        return `linux:${id}`
      }
      if (process.platform === "darwin") {
        // 64-bit Darwin struct statfs: fsid at 48, mounted-on name at 88.
        // The mount path distinguishes nullfs/bind-style mounts even when the
        // mounted filesystem has the same st_dev or fsid as its parent.
        const buffer = Buffer.alloc(2168)
        invoke("fstatfs", target, () => native().fstatfs(fd, buffer))
        const point = string(buffer.subarray(88, 1112))
        if (!point) throw new Error(`Kernel mount identity is unavailable for ${target}`)
        return `darwin:${buffer.subarray(48, 56).toString("hex")}:${point}`
      }
      throw new Error(`Safe snapshot mount-boundary checks are unavailable on ${process.platform}`)
    })()
    return hooks?.mountIdentity ? hooks.mountIdentity(target, actual) : actual
  }

  async function openRoot(root: string, hooks?: Hooks): Promise<Directory> {
    const expected = path.resolve(root)
    const canonical = await fs.realpath(expected)
    if (canonical !== expected) throw new Error(`Snapshot worktree became ambiguous: ${root}`)
    const requested = await fs.lstat(expected)
    if (!requested.isDirectory() || requested.isSymbolicLink()) {
      throw new Error(`Snapshot worktree is not a direct directory: ${root}`)
    }
    const handle = await fs.open(expected, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW | O_CLOEXEC)
    try {
      const result: Directory = {
        fd: handle.fd,
        expected,
        before: await handle.stat(),
        mount: await mount(handle.fd, expected, hooks),
        close: () => handle.close(),
      }
      await verify(result)
      return result
    } catch (error) {
      await handle.close()
      throw error
    }
  }

  async function openChild(parent: Directory, child: string, hooks?: Hooks): Promise<Directory> {
    const expected = path.join(parent.expected, segment(child))
    const fd = invoke("openat", expected, () =>
      native().openat(parent.fd, name(child), FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW | O_CLOEXEC, 0),
    )
    try {
      const result: Directory = {
        fd,
        expected,
        before: await stat(fd),
        mount: await mount(fd, expected, hooks),
        close: () => close(fd),
      }
      if (result.mount !== parent.mount) throw new Error(`Refused to cross a mounted snapshot parent: ${expected}`)
      await verify(result)
      return result
    } catch (error) {
      await close(fd)
      throw error
    }
  }

  function decode(pointer: number | bigint) {
    const offset = process.platform === "darwin" ? 21 : 19
    const bytes = new Uint8Array(toArrayBuffer(pointer as Pointer, 0, process.platform === "darwin" ? 1045 : 275))
    const end = bytes.indexOf(0, offset)
    const stop = end < 0 ? bytes.byteLength : end
    return Buffer.from(bytes.subarray(offset, stop)).toString("utf8")
  }

  async function entries(fd: number) {
    const duplicated = invoke("dup", String(fd), () => native().dup(fd))
    const directory = native().fdopendir(duplicated)
    if (!directory) {
      await close(duplicated).catch(() => undefined)
      throw failure("fdopendir", String(fd), native().errno())
    }
    const result: string[] = []
    try {
      while (true) {
        const pointer = native().readdir(directory)
        if (!pointer) break
        const value = decode(pointer)
        if (value && value !== "." && value !== "..") result.push(segment(value))
      }
      return result
    } finally {
      const closed = attempt(() => native().closedir(directory))
      if (!closed.ok) throw failure("closedir", String(fd), closed.errno)
    }
  }

  function tomb(prefix: string) {
    return segment(`.openscience-${prefix}-${crypto.randomUUID()}`)
  }

  function renameExclusive(parent: Directory, from: string, to: string) {
    return attempt(() => native().renameExclusive(parent.fd, name(from), parent.fd, name(to)))
  }

  async function purge(parent: Directory, child: string, device: number, hooks?: Hooks): Promise<void> {
    const opened = attempt(() =>
      native().openat(parent.fd, name(child), FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW | O_CLOEXEC, 0),
    )
    if (!opened.ok && (opened.errno === ENOTDIR || opened.errno === ELOOP)) {
      const removed = attempt(() => native().unlinkat(parent.fd, name(child), 0))
      if (!removed.ok && removed.errno !== ENOENT)
        throw failure("unlinkat", path.join(parent.expected, child), removed.errno)
      return
    }
    if (!opened.ok) {
      if (opened.errno === ENOENT) return
      throw failure("openat", path.join(parent.expected, child), opened.errno)
    }
    const inspected = await (async () => {
      try {
        return {
          before: await stat(opened.value),
          mount: await mount(opened.value, path.join(parent.expected, child), hooks),
        }
      } catch (error) {
        await close(opened.value).catch(() => undefined)
        throw error
      }
    })()
    if (inspected.mount !== parent.mount) {
      await close(opened.value)
      throw new Error(`Refused to cross a mounted snapshot subtree: ${path.join(parent.expected, child)}`)
    }
    const directory: Directory = {
      fd: opened.value,
      expected: path.join(parent.expected, child),
      before: inspected.before,
      mount: inspected.mount,
      close: () => close(opened.value),
    }
    try {
      if (!directory.before.isDirectory())
        throw new Error(`Snapshot purge target is not a directory: ${directory.expected}`)
      if (directory.before.dev !== device)
        throw new Error(`Refusing to remove a mounted snapshot subtree: ${directory.expected}`)
      for (const entry of await entries(directory.fd)) await removeNamed(directory, entry, device, hooks)
      await sync(directory.fd, true)
    } finally {
      await directory.close()
    }
    const removed = attempt(() => native().unlinkat(parent.fd, name(child), AT_REMOVEDIR))
    if (!removed.ok && removed.errno !== ENOENT) {
      throw failure("unlinkat", path.join(parent.expected, child), removed.errno)
    }
  }

  async function removeNamed(parent: Directory, child: string, device: number, hooks?: Hooks) {
    const backup = tomb("snapshot-remove")
    const moved = renameExclusive(parent, child, backup)
    if (!moved.ok) {
      if (moved.errno === ENOENT) return false
      throw failure("exclusive rename", path.join(parent.expected, child), moved.errno)
    }
    await sync(parent.fd, true)
    await purge(parent, backup, device, hooks)
    await sync(parent.fd, true)
    return true
  }

  async function ensureChild(parent: Directory, child: string, device: number, hooks?: Hooks) {
    const opened = await openChild(parent, child, hooks).catch((error: NodeJS.ErrnoException) => {
      if (error.errno === ENOENT || error.errno === ENOTDIR || error.errno === ELOOP) return error.errno
      throw error
    })
    if (typeof opened !== "number") return opened
    if (opened === ENOTDIR || opened === ELOOP) await removeNamed(parent, child, device, hooks)
    const created = attempt(() => native().mkdirat(parent.fd, name(child), 0o755))
    if (!created.ok && created.errno !== EEXIST) {
      throw failure("mkdirat", path.join(parent.expected, child), created.errno)
    }
    if (created.ok) await sync(parent.fd, true)
    return openChild(parent, child, hooks)
  }

  async function parent(root: Directory, pieces: string[], hooks?: Hooks) {
    const current = { value: root }
    try {
      for (const piece of pieces) {
        await verify(current.value)
        const next = await ensureChild(current.value, piece, root.before.dev, hooks)
        const prior = current.value
        current.value = next
        await prior.close()
      }
      return current.value
    } catch (error) {
      await current.value.close().catch(() => undefined)
      throw error
    }
  }

  async function existingParent(root: Directory, pieces: string[], hooks?: Hooks) {
    const current = { value: root }
    try {
      for (const piece of pieces) {
        await verify(current.value)
        const next = await openChild(current.value, piece, hooks).catch((error: NodeJS.ErrnoException) => {
          if (error.errno === ENOENT) return
          if (error.errno === ENOTDIR || error.errno === ELOOP) {
            throw new Error(
              `Refused to follow a symlinked parent outside the snapshot plan: ${path.join(current.value.expected, piece)}`,
            )
          }
          throw error
        })
        if (!next) {
          await current.value.close()
          return
        }
        const prior = current.value
        current.value = next
        await prior.close()
      }
      return current.value
    } catch (error) {
      await current.value.close().catch(() => undefined)
      throw error
    }
  }

  async function stage(parent: Directory, entry: Entry, hooks?: Hooks) {
    const staged = tomb("snapshot-stage")
    if (entry.kind === "symlink") {
      const created = attempt(() => native().symlinkat(linkTarget(entry.target), parent.fd, name(staged)))
      if (!created.ok) throw failure("symlinkat", path.join(parent.expected, staged), created.errno)
      return staged
    }
    const opened = attempt(() =>
      native().openat(
        parent.fd,
        name(staged),
        FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW | O_CLOEXEC,
        entry.mode,
      ),
    )
    if (!opened.ok) throw failure("openat", path.join(parent.expected, staged), opened.errno)
    const state = { closed: false }
    try {
      await writeAll(opened.value, entry.content, hooks)
      await chmod(opened.value, entry.mode)
      await sync(opened.value)
      await close(opened.value)
      state.closed = true
    } catch (error) {
      if (!state.closed) await close(opened.value).catch(() => undefined)
      const cleanup = attempt(() => native().unlinkat(parent.fd, name(staged), 0))
      if (!cleanup.ok && cleanup.errno !== ENOENT) {
        throw new AggregateError([error, failure("unlinkat", staged, cleanup.errno)], "Snapshot stage cleanup failed")
      }
      throw error
    }
    return staged
  }

  async function posixRemove(rootPath: string, relative: string, hooks?: Hooks) {
    const parsed = target(rootPath, relative)
    const base = await openRoot(parsed.root, hooks)
    const destination = await existingParent(base, parsed.pieces.slice(0, -1), hooks)
    if (!destination) return false
    try {
      await verify(destination)
      await hooks?.afterParentVerify?.("remove", parsed.path)
      await verify(destination)
      const removed = await removeNamed(destination, parsed.pieces.at(-1)!, base.before.dev, hooks)
      await verify(destination)
      return removed
    } finally {
      await destination.close()
    }
  }

  async function posixRestore(rootPath: string, relative: string, entry: Entry, hooks?: Hooks) {
    const parsed = target(rootPath, relative)
    const base = await openRoot(parsed.root, hooks)
    const destination = await parent(base, parsed.pieces.slice(0, -1), hooks)
    const filename = parsed.pieces.at(-1)!
    const state = { staged: undefined as string | undefined, backup: undefined as string | undefined }
    try {
      await verify(destination)
      await hooks?.afterParentVerify?.("restore", parsed.path)
      await verify(destination)
      state.staged = await stage(destination, entry, hooks)
      await verify(destination)

      const candidate = tomb("snapshot-backup")
      const moved = renameExclusive(destination, filename, candidate)
      if (moved.ok) state.backup = candidate
      if (!moved.ok && moved.errno !== ENOENT) {
        throw failure("exclusive rename", path.join(destination.expected, filename), moved.errno)
      }

      const installed = renameExclusive(destination, state.staged, filename)
      if (!installed.ok) {
        const cause = failure("exclusive rename", path.join(destination.expected, filename), installed.errno)
        if (state.backup) {
          const rollback = renameExclusive(destination, state.backup, filename)
          if (!rollback.ok) {
            throw new AggregateError(
              [cause, failure("exclusive rename", path.join(destination.expected, state.backup), rollback.errno)],
              `Snapshot restore failed; original retained under ${state.backup}`,
            )
          }
          state.backup = undefined
        }
        throw cause
      }
      state.staged = undefined
      await sync(destination.fd, true)
      if (state.backup) {
        await purge(destination, state.backup, base.before.dev, hooks)
        state.backup = undefined
        await sync(destination.fd, true)
      }
      await verify(destination)
    } finally {
      if (state.staged) {
        const cleanup = attempt(() => native().unlinkat(destination.fd, name(state.staged!), 0))
        if (!cleanup.ok && cleanup.errno !== ENOENT) {
          await destination.close()
          throw failure("unlinkat", path.join(destination.expected, state.staged), cleanup.errno)
        }
      }
      await destination.close()
    }
  }

  async function windowsRemove(rootPath: string, relative: string, hooks?: Hooks) {
    const parsed = target(rootPath, relative)
    return SafeTrashIO.remove(parsed.path, undefined, {
      afterDirectoryVerify: async () => hooks?.afterParentVerify?.("remove", parsed.path),
    })
  }

  async function windowsRestore(rootPath: string, relative: string, entry: Entry, hooks?: Hooks) {
    const parsed = target(rootPath, relative)
    if (entry.kind === "symlink") {
      throw new Error("Snapshot symlink restoration is unavailable on Windows because it cannot be made race-safe")
    }
    await SafeTrashIO.remove(parsed.path)
    await SafeDirectoryIO.write(parsed.path, entry.content, {
      mode: entry.mode,
      afterVerify: async () => hooks?.afterParentVerify?.("restore", parsed.path),
    })
  }

  export function remove(root: string, relative: string, hooks?: Hooks) {
    return process.platform === "win32" ? windowsRemove(root, relative, hooks) : posixRemove(root, relative, hooks)
  }

  export function restore(root: string, relative: string, entry: Entry, hooks?: Hooks) {
    return process.platform === "win32"
      ? windowsRestore(root, relative, entry, hooks)
      : posixRestore(root, relative, entry, hooks)
  }
}

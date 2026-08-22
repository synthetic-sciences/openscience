import crypto from "node:crypto"
import nodefs, { constants as FS, type Stats } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { dlopen, FFIType, toArrayBuffer, type Pointer } from "bun:ffi"
import { WindowsSafeIO } from "./windows-safe-io"

/**
 * No-follow, handle-relative primitives for recoverable deletion. Path names
 * are used only to open and verify directory handles; every mutation is then
 * anchored to those handles with *at(2).
 */
export namespace SafeTrashIO {
  export type Identity = {
    dev: number
    ino: number
    size: number
    mode: number
    mtimeMs: number
    ctimeMs: number
    kind: "file" | "directory"
  }

  export type Snapshot = Identity & {
    sha256?: string
  }

  export type Hooks = {
    afterDirectoryVerify?: (operation: "move" | "restore" | "remove", target: string) => void | Promise<void>
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
    renameExclusive(fromDir: number, from: Buffer, toDir: number, to: Buffer): number
    renameat(fromDir: number, from: Buffer, toDir: number, to: Buffer): number
    unlinkat(dir: number, name: Buffer, flags: number): number
    dup(fd: number): number
    fdopendir(fd: number): number | bigint | null
    readdir(directory: number | bigint): number | bigint | null
    closedir(directory: number | bigint): number
    errno(): number
  }

  const EEXIST = 17
  const EINTR = 4
  const ENOENT = 2
  const ENOTDIR = 20
  const ELOOP = process.platform === "darwin" ? 62 : 40
  const EXDEV = 18
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
    if (process.platform === "win32") {
      throw new Error("Safe handle-relative trash operations are not available on Windows")
    }
    if (natives.value) return natives.value
    const symbol = process.platform === "darwin" ? "__error" : "__errno_location"
    const exclusive = process.platform === "darwin" ? "renameatx_np" : "renameat2"
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
          [exclusive]: {
            args: [FFIType.i32, FFIType.ptr, FFIType.i32, FFIType.ptr, FFIType.u32],
            returns: FFIType.i32,
          },
          unlinkat: {
            args: [FFIType.i32, FFIType.ptr, FFIType.i32],
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
      throw loaded.error ?? new Error("Could not load the host C library for safe trash operations")
    }
    const symbols = loaded.library.symbols as Record<string, unknown>
    const location = symbols[symbol] as () => number | bigint | null
    const errno = () => {
      const pointer = location()
      if (!pointer) return 0
      return new Int32Array(toArrayBuffer(pointer as Pointer, 0, 4))[0] ?? 0
    }
    const rename = symbols[exclusive] as (
      fromDir: number,
      from: Buffer,
      toDir: number,
      to: Buffer,
      flags: number,
    ) => number
    natives.value = {
      library: loaded.library,
      openat: symbols.openat as Native["openat"],
      mkdirat: symbols.mkdirat as Native["mkdirat"],
      linkat: symbols.linkat as Native["linkat"],
      renameat: symbols.renameat as Native["renameat"],
      renameExclusive: (fromDir, from, toDir, to) =>
        rename(fromDir, from, toDir, to, process.platform === "darwin" ? 0x4 : 0x1),
      unlinkat: symbols.unlinkat as Native["unlinkat"],
      dup: symbols.dup as Native["dup"],
      fdopendir: symbols.fdopendir as Native["fdopendir"],
      readdir: symbols.readdir as Native["readdir"],
      closedir: symbols.closedir as Native["closedir"],
      errno,
    }
    return natives.value
  }

  function basename(value: string) {
    if (!value || value === "." || value === ".." || value.includes("/") || value.includes("\0")) {
      throw new Error(`Unsafe handle-relative trash name: ${JSON.stringify(value)}`)
    }
    return value
  }

  function name(value: string) {
    return Buffer.from(`${basename(value)}\0`)
  }

  function error(action: string, target: string, errno: number) {
    const result = new Error(`${action} failed for ${target} (errno ${errno})`) as NodeJS.ErrnoException
    result.errno = errno
    if (errno === EEXIST) result.code = "EEXIST"
    if (errno === ENOENT) result.code = "ENOENT"
    if (errno === EXDEV) result.code = "EXDEV"
    return result
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

  function invoke(action: string, target: string, call: () => number) {
    const result = attempt(call)
    if (result.ok) return result.value
    throw error(action, target, result.errno)
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

  function read(fd: number, bytes: Buffer, offset: number, position: number) {
    return new Promise<number>((resolve, reject) => {
      nodefs.read(fd, bytes, offset, bytes.byteLength - offset, position, (error, count) =>
        error ? reject(error) : resolve(count),
      )
    })
  }

  function write(fd: number, bytes: Uint8Array, offset: number) {
    return new Promise<number>((resolve, reject) => {
      nodefs.write(fd, bytes, offset, bytes.byteLength - offset, null, (error, count) =>
        error ? reject(error) : resolve(count),
      )
    })
  }

  async function writeAll(fd: number, bytes: Uint8Array) {
    const cursor = { value: 0 }
    while (cursor.value < bytes.byteLength) {
      const count = await write(fd, bytes, cursor.value)
      if (!count) throw new Error("Handle-relative trash write made no progress")
      cursor.value += count
    }
  }

  async function hash(fd: number, size: number) {
    const digest = crypto.createHash("sha256")
    const chunk = Buffer.allocUnsafe(Math.min(1024 * 1024, Math.max(1, size)))
    const cursor = { value: 0 }
    while (cursor.value < size) {
      const view = chunk.subarray(0, Math.min(chunk.byteLength, size - cursor.value))
      const count = await read(fd, view, 0, cursor.value)
      if (!count) throw new Error("File changed while its trash snapshot was read")
      digest.update(view.subarray(0, count))
      cursor.value += count
    }
    return digest.digest("hex")
  }

  function identity(value: Stats): Identity {
    const kind = value.isDirectory() ? "directory" : value.isFile() ? "file" : undefined
    if (!kind) throw new Error("Only regular files and directories can be moved to trash")
    return {
      dev: value.dev,
      ino: value.ino,
      size: value.size,
      mode: value.mode & 0o777,
      mtimeMs: value.mtimeMs,
      ctimeMs: value.ctimeMs,
      kind,
    }
  }

  function same(left: Identity, right: Identity) {
    return (
      left.dev === right.dev &&
      left.ino === right.ino &&
      left.size === right.size &&
      left.mtimeMs === right.mtimeMs &&
      left.ctimeMs === right.ctimeMs &&
      left.kind === right.kind
    )
  }

  function sameObject(left: Identity, right: Identity) {
    return left.dev === right.dev && left.ino === right.ino && left.kind === right.kind
  }

  function sameMoved(left: Identity, right: Identity) {
    return sameObject(left, right) && left.size === right.size && left.mtimeMs === right.mtimeMs
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
      throw new Error(`Trash directory identity changed during access: ${directory.expected}`)
    }
  }

  async function openDirectory(target: string): Promise<Directory> {
    const expected = path.resolve(target)
    const canonical = await fs.realpath(expected)
    if (canonical !== expected) throw new Error(`Refusing an indirect trash directory: ${target}`)
    const requested = await fs.lstat(expected)
    if (!requested.isDirectory() || requested.isSymbolicLink()) {
      throw new Error(`Trash path is not a direct directory: ${target}`)
    }
    const handle = await fs.open(expected, FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW)
    try {
      const result: Directory = {
        fd: handle.fd,
        expected,
        before: await handle.stat(),
        close: () => handle.close(),
      }
      await verify(result)
      return result
    } catch (cause) {
      await handle.close()
      throw cause
    }
  }

  async function openChild(parent: Directory, child: string, expected: string): Promise<Directory> {
    const fd = invoke("openat", expected, () =>
      native().openat(parent.fd, name(child), FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW | O_CLOEXEC, 0),
    )
    const result: Directory = {
      fd,
      expected,
      before: await stat(fd),
      close: () => close(fd),
    }
    try {
      await verify(result)
      return result
    } catch (cause) {
      await result.close()
      throw cause
    }
  }

  async function child(parent: Directory, child: string, mode: number, exclusive = false) {
    const expected = path.join(parent.expected, basename(child))
    const created = attempt(() => native().mkdirat(parent.fd, name(child), mode))
    if (!created.ok && (exclusive || created.errno !== EEXIST)) {
      throw error("mkdirat", expected, created.errno)
    }
    if (created.ok) await sync(parent.fd, true)
    return openChild(parent, child, expected)
  }

  async function openFile(parent: Directory, child: string) {
    const fd = invoke("openat", path.join(parent.expected, child), () =>
      native().openat(parent.fd, name(child), FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK | O_CLOEXEC, 0),
    )
    try {
      return { fd, identity: identity(await stat(fd)) }
    } catch (cause) {
      await close(fd)
      throw cause
    }
  }

  async function writeExclusive(parent: Directory, child: string, content: Uint8Array, mode: number) {
    const result = attempt(() =>
      native().openat(parent.fd, name(child), FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW | O_CLOEXEC, mode),
    )
    if (!result.ok) {
      if (result.errno === EEXIST) return false
      throw error("openat", path.join(parent.expected, child), result.errno)
    }
    try {
      await writeAll(result.value, content)
      await chmod(result.value, mode)
      await sync(result.value)
    } finally {
      await close(result.value)
    }
    await sync(parent.fd, true)
    return true
  }

  async function writeAtomic(parent: Directory, child: string, content: Uint8Array, mode: number) {
    const staged = `.openscience-trash-${crypto.randomUUID()}.tmp`
    const created = await writeExclusive(parent, staged, content, mode)
    if (!created) throw new Error(`Could not allocate trash metadata stage: ${staged}`)
    try {
      invoke("renameat", `${staged} -> ${child}`, () =>
        native().renameat(parent.fd, name(staged), parent.fd, name(child)),
      )
      await sync(parent.fd, true)
    } catch (cause) {
      const cleanup = attempt(() => native().unlinkat(parent.fd, name(staged), 0))
      if (!cleanup.ok && cleanup.errno !== ENOENT) {
        throw new AggregateError([cause, error("unlinkat", staged, cleanup.errno)], "Trash metadata cleanup failed")
      }
      throw cause
    }
  }

  async function openParent(target: string) {
    const resolved = path.resolve(target)
    const child = basename(path.basename(resolved))
    if (path.join(path.dirname(resolved), child) !== resolved) {
      throw new Error(`Trash target is not a direct child path: ${target}`)
    }
    return { parent: await openDirectory(path.dirname(resolved)), child, resolved }
  }

  async function createParent(target: string) {
    const resolved = path.resolve(target)
    const expected = path.dirname(resolved)
    const missing: string[] = []
    const cursor = { value: expected }
    while (true) {
      const info = await fs.lstat(cursor.value).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT") return
        throw cause
      })
      if (info) break
      const parent = path.dirname(cursor.value)
      if (parent === cursor.value) throw new Error(`No existing directory anchors trash restore: ${target}`)
      missing.unshift(basename(path.basename(cursor.value)))
      cursor.value = parent
    }
    const initial = await openDirectory(cursor.value)
    const current = { value: initial }
    try {
      for (const segment of missing) {
        const next = await child(current.value, segment, 0o755)
        const prior = current.value
        current.value = next
        await prior.close()
      }
      if (current.value.expected !== expected) {
        throw new Error(`Trash restore destination could not be anchored: ${expected}`)
      }
      return {
        parent: current.value,
        child: basename(path.basename(resolved)),
        resolved,
      }
    } catch (cause) {
      await current.value.close().catch(() => undefined)
      throw cause
    }
  }

  function renameExclusive(from: Directory, fromName: string, to: Directory, toName: string) {
    const result = attempt(() => native().renameExclusive(from.fd, name(fromName), to.fd, name(toName)))
    if (result.ok) return
    throw error("exclusive rename", `${from.expected}/${fromName} -> ${to.expected}/${toName}`, result.errno)
  }

  function rename(from: Directory, fromName: string, to: Directory, toName: string) {
    invoke("renameat", `${from.expected}/${fromName} -> ${to.expected}/${toName}`, () =>
      native().renameat(from.fd, name(fromName), to.fd, name(toName)),
    )
  }

  export async function inspect(target: string): Promise<Snapshot> {
    if (process.platform === "win32") return WindowsSafeIO.inspectTrash(target)
    const source = await openParent(target)
    try {
      const file = await openFile(source.parent, source.child)
      try {
        if (file.identity.kind === "directory") return file.identity
        const sha256 = await hash(file.fd, file.identity.size)
        const after = identity(await stat(file.fd))
        if (!same(file.identity, after)) throw new Error(`File changed while trash approval was captured: ${target}`)
        return { ...after, sha256 }
      } finally {
        await close(file.fd)
      }
    } finally {
      await source.parent.close()
    }
  }

  export async function workspace(root: string, id: string) {
    if (process.platform === "win32") return WindowsSafeIO.workspace(root, id)
    const base = await openDirectory(root)
    try {
      const trash = await child(base, ".openscience-trash", 0o700).catch((cause) => {
        throw new Error(`Invalid workspace trash root: ${path.join(base.expected, ".openscience-trash")}`, {
          cause,
        })
      })
      try {
        await writeExclusive(trash, ".gitignore", Buffer.from("*\n"), 0o600)
        const entry = await child(trash, id, 0o700, true)
        const state = { entry: true, trash: true }
        return {
          entry: entry.expected,
          payload: path.join(entry.expected, "payload"),
          async write(record: Uint8Array) {
            await writeAtomic(entry, "record.json", record, 0o600)
          },
          async discard() {
            if (!state.entry) return
            await empty(entry, entry.before.dev)
            await sync(entry.fd, true)
            await entry.close()
            state.entry = false
            const removed = attempt(() => native().unlinkat(trash.fd, name(id), AT_REMOVEDIR))
            if (!removed.ok && removed.errno !== ENOENT) {
              throw error("unlinkat", entry.expected, removed.errno)
            }
            await sync(trash.fd, true)
          },
          async close() {
            if (state.entry) await entry.close()
            state.entry = false
            if (state.trash) await trash.close()
            state.trash = false
          },
        }
      } catch (cause) {
        await trash.close()
        throw cause
      }
    } finally {
      await base.close()
    }
  }

  export async function move(sourcePath: string, targetPath: string, approved: Identity, hooks?: Hooks) {
    if (process.platform === "win32") return WindowsSafeIO.moveTrash(sourcePath, targetPath, approved, hooks)
    const source = await openParent(sourcePath)
    const target = await openParent(targetPath)
    try {
      await Promise.all([verify(source.parent), verify(target.parent)])
      await hooks?.afterDirectoryVerify?.("move", source.resolved)
      await Promise.all([verify(source.parent), verify(target.parent)])
      const opened = await openFile(source.parent, source.child)
      try {
        if (!same(opened.identity, approved)) {
          throw new Error(`Refusing to trash ${source.resolved}: the approved item changed before deletion`)
        }
      } finally {
        await close(opened.fd)
      }
      renameExclusive(source.parent, source.child, target.parent, target.child)
      const moved = await openFile(target.parent, target.child).catch(async (cause) => {
        renameExclusive(target.parent, target.child, source.parent, source.child)
        throw cause
      })
      try {
        if (!sameMoved(moved.identity, approved)) {
          const conflict = await openFile(source.parent, source.child).then(
            async (value) => {
              await close(value.fd)
              return true
            },
            () => false,
          )
          if (!conflict) renameExclusive(target.parent, target.child, source.parent, source.child)
          throw new Error(`Refusing to trash ${source.resolved}: the item identity changed during deletion`)
        }
        if (moved.identity.kind === "file") await chmod(moved.fd, 0o600)
        await sync(moved.fd, moved.identity.kind === "directory")
        moved.identity = identity(await stat(moved.fd))
      } finally {
        await close(moved.fd)
      }
      await Promise.all([sync(source.parent.fd, true), sync(target.parent.fd, true)])
      return moved.identity
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Refusing to overwrite an existing trash payload: ${target.resolved}`)
      }
      if ((cause as NodeJS.ErrnoException).code === "EXDEV") {
        throw new Error(`Recoverable deletion requires ${source.resolved} and its trash to share a filesystem`)
      }
      throw cause
    } finally {
      await target.parent.close()
      await source.parent.close()
    }
  }

  export async function restore(
    sourcePath: string,
    targetPath: string,
    approved: Identity,
    mode: number,
    hooks?: Hooks,
  ) {
    if (process.platform === "win32") return WindowsSafeIO.restore(sourcePath, targetPath, approved, mode, hooks)
    const source = await openParent(sourcePath)
    const target = await createParent(targetPath)
    try {
      await Promise.all([verify(source.parent), verify(target.parent)])
      await hooks?.afterDirectoryVerify?.("restore", target.resolved)
      await Promise.all([verify(source.parent), verify(target.parent)])
      const opened = await openFile(source.parent, source.child)
      try {
        if (!sameObject(opened.identity, approved)) {
          throw new Error(`Trash payload identity mismatch for ${source.resolved}`)
        }
      } finally {
        await close(opened.fd)
      }
      renameExclusive(source.parent, source.child, target.parent, target.child)
      const restored = await openFile(target.parent, target.child)
      try {
        if (!sameObject(restored.identity, approved)) {
          throw new Error(`Restored item identity mismatch for ${target.resolved}`)
        }
        if (restored.identity.kind === "file") await chmod(restored.fd, mode)
        await sync(restored.fd, restored.identity.kind === "directory")
      } finally {
        await close(restored.fd)
      }
      await Promise.all([sync(source.parent.fd, true), sync(target.parent.fd, true)])
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Refusing to overwrite ${target.resolved}`)
      }
      throw cause
    } finally {
      await target.parent.close()
      await source.parent.close()
    }
  }

  export async function copy(sourcePath: string, targetPath: string, approved: Identity, mode: number, hooks?: Hooks) {
    if (process.platform === "win32") return WindowsSafeIO.copy(sourcePath, targetPath, approved, mode, hooks)
    const source = await openParent(sourcePath)
    const target = await createParent(targetPath)
    const staged = `.openscience-restore-${crypto.randomUUID()}.tmp`
    try {
      await Promise.all([verify(source.parent), verify(target.parent)])
      await hooks?.afterDirectoryVerify?.("restore", target.resolved)
      await Promise.all([verify(source.parent), verify(target.parent)])
      const opened = await openFile(source.parent, source.child)
      if (opened.identity.kind !== "file" || !sameObject(opened.identity, approved)) {
        await close(opened.fd)
        throw new Error(`Trash payload identity mismatch for ${source.resolved}`)
      }
      const created = attempt(() =>
        native().openat(
          target.parent.fd,
          name(staged),
          FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW | O_CLOEXEC,
          mode,
        ),
      )
      if (!created.ok) {
        await close(opened.fd)
        throw error("openat", path.join(target.parent.expected, staged), created.errno)
      }
      try {
        const chunk = Buffer.allocUnsafe(1024 * 1024)
        const cursor = { value: 0 }
        while (cursor.value < opened.identity.size) {
          const view = chunk.subarray(0, Math.min(chunk.byteLength, opened.identity.size - cursor.value))
          const count = await read(opened.fd, view, 0, cursor.value)
          if (!count) throw new Error(`Trash payload changed while restoring ${source.resolved}`)
          await writeAll(created.value, view.subarray(0, count))
          cursor.value += count
        }
        const after = identity(await stat(opened.fd))
        if (!same(opened.identity, after)) throw new Error(`Trash payload changed while restoring ${source.resolved}`)
        await chmod(created.value, mode)
        await sync(created.value)
      } finally {
        await close(created.value)
        await close(opened.fd)
      }
      const installed = attempt(() =>
        native().linkat(target.parent.fd, name(staged), target.parent.fd, name(target.child), 0),
      )
      if (!installed.ok) {
        if (installed.errno === EEXIST) throw new Error(`Refusing to overwrite ${target.resolved}`)
        throw error("linkat", target.resolved, installed.errno)
      }
      const cleanup = attempt(() => native().unlinkat(target.parent.fd, name(staged), 0))
      if (!cleanup.ok) throw error("unlinkat", staged, cleanup.errno)
      await sync(target.parent.fd, true)
    } finally {
      const cleanup = attempt(() => native().unlinkat(target.parent.fd, name(staged), 0))
      if (!cleanup.ok && cleanup.errno !== ENOENT) {
        await target.parent.close()
        await source.parent.close()
        throw error("unlinkat", staged, cleanup.errno)
      }
      await target.parent.close()
      await source.parent.close()
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
      throw error("fdopendir", String(fd), native().errno())
    }
    const result: string[] = []
    try {
      while (true) {
        const pointer = native().readdir(directory)
        if (!pointer) break
        const entry = decode(pointer)
        if (entry && entry !== "." && entry !== "..") result.push(basename(entry))
      }
      return result
    } finally {
      const closed = attempt(() => native().closedir(directory))
      if (!closed.ok) throw error("closedir", String(fd), closed.errno)
    }
  }

  async function empty(directory: Directory, device: number) {
    for (const entry of await entries(directory.fd)) {
      const tomb = `.openscience-purge-${crypto.randomUUID()}`
      renameExclusive(directory, entry, directory, tomb)
      const opened = attempt(() =>
        native().openat(directory.fd, name(tomb), FS.O_RDONLY | FS.O_DIRECTORY | FS.O_NOFOLLOW | O_CLOEXEC, 0),
      )
      if (!opened.ok && (opened.errno === ENOTDIR || opened.errno === ELOOP)) {
        const removed = attempt(() => native().unlinkat(directory.fd, name(tomb), 0))
        if (!removed.ok) throw error("unlinkat", path.join(directory.expected, tomb), removed.errno)
        continue
      }
      if (!opened.ok) throw error("openat", path.join(directory.expected, tomb), opened.errno)
      const child: Directory = {
        fd: opened.value,
        expected: path.join(directory.expected, tomb),
        before: await stat(opened.value),
        close: () => close(opened.value),
      }
      try {
        if (child.before.dev !== device) {
          throw new Error(`Refusing to purge a mounted trash subtree: ${child.expected}`)
        }
        await empty(child, device)
        await sync(child.fd, true)
      } finally {
        await child.close()
      }
      const removed = attempt(() => native().unlinkat(directory.fd, name(tomb), AT_REMOVEDIR))
      if (!removed.ok) throw error("unlinkat", child.expected, removed.errno)
    }
  }

  export async function remove(targetPath: string, approved?: Identity, hooks?: Hooks) {
    if (process.platform === "win32") return WindowsSafeIO.remove(targetPath, approved, hooks)
    const target = await openParent(targetPath).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT" || cause.errno === ENOENT) return
      throw cause
    })
    if (!target) return false
    try {
      await verify(target.parent)
      await hooks?.afterDirectoryVerify?.("remove", target.resolved)
      await verify(target.parent)
      const opened = await openFile(target.parent, target.child).catch((cause: NodeJS.ErrnoException) => {
        if (cause.code === "ENOENT" || cause.errno === ENOENT) return
        throw cause
      })
      if (!opened) return false
      try {
        if (approved && !sameObject(opened.identity, approved)) {
          throw new Error(`Trash payload identity mismatch for ${target.resolved}`)
        }
      } finally {
        await close(opened.fd)
      }
      const tomb = `.openscience-purge-${crypto.randomUUID()}`
      renameExclusive(target.parent, target.child, target.parent, tomb)
      const current = await openFile(target.parent, tomb)
      try {
        if (approved && !sameObject(current.identity, approved)) {
          throw new Error(`Trash payload identity changed during purge for ${target.resolved}`)
        }
        if (current.identity.kind === "file") {
          const removed = attempt(() => native().unlinkat(target.parent.fd, name(tomb), 0))
          if (!removed.ok) throw error("unlinkat", target.resolved, removed.errno)
          await sync(target.parent.fd, true)
          return true
        }
      } finally {
        await close(current.fd)
      }
      const directory = await openChild(target.parent, tomb, path.join(target.parent.expected, tomb))
      try {
        if (directory.before.dev !== target.parent.before.dev) {
          throw new Error(`Refusing to purge a mounted trash root: ${target.resolved}`)
        }
        await empty(directory, directory.before.dev)
        await sync(directory.fd, true)
      } finally {
        await directory.close()
      }
      const removed = attempt(() => native().unlinkat(target.parent.fd, name(tomb), AT_REMOVEDIR))
      if (!removed.ok) throw error("unlinkat", target.resolved, removed.errno)
      await sync(target.parent.fd, true)
      return true
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false
      throw cause
    } finally {
      await target.parent.close()
    }
  }

  export async function writeRecord(targetPath: string, record: Uint8Array) {
    if (process.platform === "win32") return WindowsSafeIO.writeRecord(targetPath, record)
    const target = await openParent(targetPath)
    try {
      await verify(target.parent)
      await writeAtomic(target.parent, target.child, record, 0o600)
    } finally {
      await target.parent.close()
    }
  }

  export async function ensureDataEntry(dataRoot: string, project: string, id: string) {
    if (process.platform === "win32") return WindowsSafeIO.ensureDataEntry(dataRoot, project, id)
    const base = await openDirectory(dataRoot)
    try {
      const trash = await child(base, "file-trash", 0o700)
      try {
        const scoped = await child(trash, project, 0o700)
        try {
          const entry = await child(scoped, id, 0o700, true)
          await entry.close()
          return path.join(scoped.expected, id)
        } finally {
          await scoped.close()
        }
      } finally {
        await trash.close()
      }
    } finally {
      await base.close()
    }
  }
}

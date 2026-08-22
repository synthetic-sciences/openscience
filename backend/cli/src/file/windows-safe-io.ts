import crypto from "node:crypto"
import type { Stats } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { dlopen, FFIType } from "bun:ffi"

/**
 * Windows file mutations anchored by native handles.
 *
 * Windows does not expose POSIX-style *at(2) calls, but its share modes give
 * us an equivalent safety boundary: directory handles omit FILE_SHARE_DELETE,
 * so the verified parent cannot be renamed, deleted, or replaced while an
 * absolute child operation is in flight. Existing entries are opened with
 * FILE_FLAG_OPEN_REPARSE_POINT and are renamed/deleted through that exact
 * handle with SetFileInformationByHandle.
 */
export namespace WindowsSafeIO {
  type Handle = number | bigint

  export type Entry = {
    dev: number
    ino: number
    type: "file" | "directory"
  }

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
    afterSnapshotChunk?: (bytes: number) => void | Promise<void>
  }

  type NativeIdentity = {
    attributes: number
    index: bigint
    volume: number
    type: "file" | "directory"
    reparse: boolean
  }

  type Lock = {
    handle: Handle
    identity: NativeIdentity
    path: string
    close(): void
  }

  type Parent = {
    directory: Lock
    child: string
    path: string
  }

  type WriteOptions = {
    mode: number
    approved?: { bytes: Buffer; dev: number; ino: number }
    afterVerify?: (target: string) => void | Promise<void>
  }

  type MoveOptions = {
    afterVerify?: (source: string, target: string) => void | Promise<void>
    afterMutation?: (source: string, target: string) => void | Promise<void>
  }

  type RenameOrigin = {
    directory: Lock
    child: string
  }

  const FILE_READ_ATTRIBUTES = 0x00000080
  const FILE_TRAVERSE = 0x00000020
  const FILE_ADD_FILE = 0x00000002
  const FILE_ADD_SUBDIRECTORY = 0x00000004
  const DELETE = 0x00010000
  const FILE_SHARE_READ = 0x00000001
  const FILE_SHARE_WRITE = 0x00000002
  const OPEN_EXISTING = 3
  const FILE_ATTRIBUTE_DIRECTORY = 0x00000010
  const FILE_ATTRIBUTE_REPARSE_POINT = 0x00000400
  const FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
  const FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000
  const FILE_RENAME_INFO = 3
  const FILE_DISPOSITION_INFO = 4
  const INVALID_HANDLE_VALUE = 0xffffffffffffffffn
  const ERROR_FILE_NOT_FOUND = 2
  const ERROR_PATH_NOT_FOUND = 3
  const ERROR_ACCESS_DENIED = 5
  const ERROR_NOT_SAME_DEVICE = 17
  const ERROR_SHARING_VIOLATION = 32
  const ERROR_FILE_EXISTS = 80
  const ERROR_INVALID_PARAMETER = 87
  const ERROR_DIR_NOT_EMPTY = 145
  const ERROR_ALREADY_EXISTS = 183

  const definitions = {
    CreateFileW: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.ptr, FFIType.u32, FFIType.u32, FFIType.u64],
      returns: FFIType.u64,
    },
    GetFileInformationByHandle: {
      args: [FFIType.u64, FFIType.ptr],
      returns: FFIType.i32,
    },
    SetFileInformationByHandle: {
      args: [FFIType.u64, FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    CloseHandle: {
      args: [FFIType.u64],
      returns: FFIType.i32,
    },
    GetLastError: {
      args: [],
      returns: FFIType.u32,
    },
  } as const

  const openKernel = () => dlopen("kernel32.dll", definitions)
  const kernel = { value: undefined as ReturnType<typeof openKernel> | undefined }

  function api() {
    if (process.platform !== "win32") throw new Error("Windows safe file operations require Windows")
    if (process.arch !== "x64" && process.arch !== "arm64") {
      throw new Error(`Windows safe file operations require a 64-bit runtime, received ${process.arch}`)
    }
    kernel.value ??= openKernel()
    return kernel.value.symbols
  }

  function wide(value: string) {
    return Buffer.from(`${value}\0`, "utf16le")
  }

  function invalid(handle: Handle) {
    return BigInt(handle) === INVALID_HANDLE_VALUE
  }

  function code() {
    return Number(api().GetLastError())
  }

  function failure(action: string, target: string, win32 = code()) {
    const result = new Error(`${action} failed for ${target} (Win32 error ${win32})`) as NodeJS.ErrnoException
    const mapped = (() => {
      if (win32 === ERROR_FILE_NOT_FOUND || win32 === ERROR_PATH_NOT_FOUND) return { code: "ENOENT", errno: 2 }
      if (win32 === ERROR_FILE_EXISTS || win32 === ERROR_ALREADY_EXISTS) return { code: "EEXIST", errno: 17 }
      if (win32 === ERROR_NOT_SAME_DEVICE) return { code: "EXDEV", errno: 18 }
      if (win32 === ERROR_DIR_NOT_EMPTY) return { code: "ENOTEMPTY", errno: 39 }
      if (win32 === ERROR_SHARING_VIOLATION) return { code: "EBUSY", errno: 16 }
      if (win32 === ERROR_ACCESS_DENIED) return { code: "EACCES", errno: 13 }
    })()
    if (mapped) {
      result.code = mapped.code
      result.errno = mapped.errno
    }
    return result
  }

  function safeName(value: string) {
    const stem = value.split(".")[0]?.toUpperCase() ?? ""
    const reserved = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)
    if (
      !value ||
      value === "." ||
      value === ".." ||
      /[<>:"/\\|?*\u0000-\u001f]/.test(value) ||
      /[ .]$/.test(value) ||
      reserved
    ) {
      throw new Error(`Unsafe Windows file name: ${JSON.stringify(value)}`)
    }
    return value
  }

  function equal(left: string, right: string) {
    const normalize = (value: string) => {
      const current = path.win32.normalize(value)
      const ordinary = current.startsWith("\\\\?\\UNC\\")
        ? `\\\\${current.slice(8)}`
        : current.startsWith("\\\\?\\")
          ? current.slice(4)
          : current
      return ordinary.toLowerCase()
    }
    return normalize(left) === normalize(right)
  }

  function direct(target: string) {
    const resolved = path.resolve(target)
    const child = safeName(path.basename(resolved))
    if (!equal(path.join(path.dirname(resolved), child), resolved)) {
      throw new Error(`Windows mutation destination is not a direct child path: ${target}`)
    }
    return { child, parent: path.dirname(resolved), path: resolved }
  }

  function information(handle: Handle): NativeIdentity {
    const buffer = Buffer.alloc(52)
    if (!api().GetFileInformationByHandle(handle, buffer)) throw failure("GetFileInformationByHandle", String(handle))
    const attributes = buffer.readUInt32LE(0)
    const volume = buffer.readUInt32LE(28)
    const index = (BigInt(buffer.readUInt32LE(44)) << 32n) | BigInt(buffer.readUInt32LE(48))
    return {
      attributes,
      volume,
      index,
      type: attributes & FILE_ATTRIBUTE_DIRECTORY ? "directory" : "file",
      reparse: Boolean(attributes & FILE_ATTRIBUTE_REPARSE_POINT),
    }
  }

  function openNative(target: string, options?: { mutable?: boolean; parent?: boolean; reparse?: boolean }): Lock {
    const symbols = api()
    const handle = symbols.CreateFileW(
      wide(target),
      FILE_READ_ATTRIBUTES |
        (options?.parent ? FILE_TRAVERSE : 0) |
        (options?.parent ? FILE_ADD_FILE | FILE_ADD_SUBDIRECTORY : 0) |
        (options?.mutable ? DELETE : 0),
      options?.parent ? FILE_SHARE_READ | FILE_SHARE_WRITE : FILE_SHARE_READ,
      null,
      OPEN_EXISTING,
      FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
      0,
    ) as Handle
    if (invalid(handle)) throw failure("CreateFileW", target)
    try {
      const identity = information(handle)
      if (identity.reparse && !options?.reparse) throw new Error(`Refusing a Windows reparse point: ${target}`)
      if (options?.parent && identity.type !== "directory") {
        throw new Error(`Windows mutation parent is not a directory: ${target}`)
      }
      const state = { closed: false }
      return {
        handle,
        identity,
        path: path.resolve(target),
        close() {
          if (state.closed) return
          state.closed = true
          symbols.CloseHandle(handle)
        },
      }
    } catch (error) {
      symbols.CloseHandle(handle)
      throw error
    }
  }

  async function canonical(target: string, type?: "file" | "directory") {
    const resolved = path.resolve(target)
    const [current, real] = await Promise.all([fs.lstat(resolved), fs.realpath(resolved)])
    if (current.isSymbolicLink() || !equal(real, resolved)) {
      throw new Error(`Refusing an indirect Windows path: ${target}`)
    }
    if (type === "directory" && !current.isDirectory()) throw new Error(`Not a directory: ${target}`)
    if (type === "file" && !current.isFile()) throw new Error(`Not a regular file: ${target}`)
    return { current, resolved }
  }

  async function lockDirectory(target: string, mutable = false) {
    const before = await canonical(target, "directory")
    const locked = openNative(before.resolved, { mutable, parent: true })
    try {
      const after = await canonical(before.resolved, "directory")
      if (before.current.dev !== after.current.dev || before.current.ino !== after.current.ino) {
        throw new Error(`Windows directory identity changed during access: ${before.resolved}`)
      }
      return locked
    } catch (error) {
      locked.close()
      throw error
    }
  }

  async function lockEntry(target: string, options?: { mutable?: boolean; reparse?: boolean }) {
    const resolved = path.resolve(target)
    const locked = openNative(resolved, options)
    try {
      const current = await fs.lstat(resolved)
      if (current.isSymbolicLink() && !options?.reparse) throw new Error(`Refusing a Windows reparse point: ${target}`)
      if (!locked.identity.reparse) {
        const real = await fs.realpath(resolved)
        if (!equal(real, resolved)) throw new Error(`Refusing an indirect Windows path: ${target}`)
      }
      return { locked, stat: current }
    } catch (error) {
      locked.close()
      throw error
    }
  }

  async function existingParent(target: string): Promise<Parent> {
    const resolved = direct(target)
    return { directory: await lockDirectory(resolved.parent), child: resolved.child, path: resolved.path }
  }

  async function createDirectory(parent: Lock, child: string, exclusive = false) {
    const name = safeName(child)
    const target = path.join(parent.path, name)
    const created = await fs.mkdir(target, { recursive: false }).then(
      () => true,
      (error: NodeJS.ErrnoException) => {
        if (!exclusive && error.code === "EEXIST") return false
        throw error
      },
    )
    const result = await lockDirectory(target, exclusive)
    if (exclusive && !created) {
      result.close()
      throw failure("CreateDirectoryW", target, ERROR_ALREADY_EXISTS)
    }
    return result
  }

  async function createParent(target: string): Promise<Parent> {
    const resolved = direct(target)
    const missing: string[] = []
    const cursor = { path: resolved.parent }
    while (true) {
      const current = await fs.lstat(cursor.path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return
        throw error
      })
      if (current) break
      const parent = path.dirname(cursor.path)
      if (parent === cursor.path) throw new Error(`No existing Windows directory anchors ${target}`)
      missing.unshift(safeName(path.basename(cursor.path)))
      cursor.path = parent
    }
    const initial = await lockDirectory(cursor.path)
    const current = { lock: initial }
    try {
      for (const segment of missing) {
        const next = await createDirectory(current.lock, segment)
        current.lock.close()
        current.lock = next
      }
      if (!equal(current.lock.path, resolved.parent)) {
        throw new Error(`Windows mutation parent could not be anchored: ${resolved.parent}`)
      }
      return { directory: current.lock, child: resolved.child, path: resolved.path }
    } catch (error) {
      current.lock.close()
      throw error
    }
  }

  function entry(stat: Stats): Entry {
    const type = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : undefined
    if (!type) throw new Error("Only regular files and directories can be mutated")
    return { dev: stat.dev, ino: stat.ino, type }
  }

  function identity(stat: Stats): Identity {
    const kind = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : undefined
    if (!kind) throw new Error("Only regular files and directories can be moved to trash")
    return {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mode: stat.mode & 0o777,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
      kind,
    }
  }

  function sameEntry(left: Entry, right: Entry) {
    return left.dev === right.dev && left.ino === right.ino && left.type === right.type
  }

  function sameObject(left: Identity, right: Identity) {
    return left.dev === right.dev && left.ino === right.ino && left.kind === right.kind
  }

  function same(left: Identity, right: Identity) {
    return (
      sameObject(left, right) &&
      left.size === right.size &&
      left.mtimeMs === right.mtimeMs &&
      left.ctimeMs === right.ctimeMs
    )
  }

  function renameBuffer(parent: Handle | undefined, target: string, replace: boolean) {
    const value = Buffer.from(parent === undefined ? path.resolve(target) : safeName(target), "utf16le")
    // FILE_RENAME_INFO has a 24-byte sizeof on 64-bit Windows even though
    // FileName begins at offset 20. SetFileInformationByHandle requires the
    // full structure size plus the variable name, not merely offset+length.
    // The four zeroed trailing bytes also leave the documented NUL/padding.
    const buffer = Buffer.alloc(24 + value.byteLength)
    buffer.writeUInt8(replace ? 1 : 0, 0)
    buffer.writeBigUInt64LE(parent === undefined ? 0n : BigInt(parent), 8)
    buffer.writeUInt32LE(value.byteLength, 16)
    value.copy(buffer, 20)
    return buffer
  }

  export function renameBufferForTests(parent: Handle, target: string, replace: boolean) {
    if (!process.env.OPENSCIENCE_TEST_HOME) throw new Error("Windows safe file test helpers are disabled outside tests")
    return renameBuffer(parent, target, replace)
  }

  function nativeSame(left: NativeIdentity, right: NativeIdentity) {
    return (
      left.volume === right.volume &&
      left.index === right.index &&
      left.type === right.type &&
      left.reparse === right.reparse
    )
  }

  async function verifyRename(source: Lock, parent: Lock, child: string) {
    const target = path.join(parent.path, child)
    const current = await lockEntry(target, { reparse: true })
    try {
      if (!nativeSame(source.identity, current.locked.identity)) {
        throw new Error(`Windows rename target identity mismatch for ${target}`)
      }
    } finally {
      current.locked.close()
    }
  }

  async function setName(source: Lock, parent: Lock, child: string, replace: boolean) {
    const target = path.join(parent.path, child)
    const relative = renameBuffer(parent.handle, child, replace)
    if (api().SetFileInformationByHandle(source.handle, FILE_RENAME_INFO, relative, relative.byteLength)) return
    const initial = code()
    // Some Windows filesystems reject a non-null RootDirectory through the
    // Win32 FileRenameInfo adapter even though the structure permits it. The
    // parent remains locked against rename/delete, so resolving the verified
    // direct child as an absolute path preserves the same safety boundary.
    const error = (() => {
      if (initial !== ERROR_INVALID_PARAMETER) return initial
      const absolute = renameBuffer(undefined, target, replace)
      if (api().SetFileInformationByHandle(source.handle, FILE_RENAME_INFO, absolute, absolute.byteLength)) return 0
      return code()
    })()
    if (!error) return
    if (!replace && (error === ERROR_ACCESS_DENIED || error === ERROR_SHARING_VIOLATION)) {
      const exists = await fs.lstat(target).then(
        () => true,
        () => false,
      )
      if (exists) throw failure("SetFileInformationByHandle(FileRenameInfo)", target, ERROR_ALREADY_EXISTS)
    }
    throw failure("SetFileInformationByHandle(FileRenameInfo)", target, error)
  }

  async function renameHandle(source: Lock, parent: Lock, child: string, origin: RenameOrigin, replace = false) {
    await setName(source, parent, child, replace)
    try {
      await verifyRename(source, parent, child)
    } catch (error) {
      try {
        await setName(source, origin.directory, origin.child, false)
        await verifyRename(source, origin.directory, origin.child)
      } catch (rollback) {
        throw new AggregateError(
          [error, rollback],
          `Windows rename postcondition failed for ${path.join(parent.path, child)}`,
        )
      }
      throw error
    }
  }

  function dispose(handle: Lock) {
    const buffer = Buffer.from([1])
    if (!api().SetFileInformationByHandle(handle.handle, FILE_DISPOSITION_INFO, buffer, buffer.byteLength)) {
      throw failure("SetFileInformationByHandle(FileDispositionInfo)", handle.path)
    }
  }

  async function snapshot(
    target: string,
    locked: Awaited<ReturnType<typeof lockEntry>>,
    hooks?: Hooks,
  ): Promise<Snapshot> {
    if (locked.locked.identity.type === "directory") return identity(locked.stat)
    const handle = await fs.open(target, "r")
    try {
      const before = await handle.stat()
      const hash = crypto.createHash("sha256")
      const chunk = Buffer.allocUnsafe(64 * 1024)
      const cursor = { value: 0 }
      while (cursor.value < before.size) {
        const result = await handle.read(chunk, 0, Math.min(chunk.byteLength, before.size - cursor.value), cursor.value)
        if (!result.bytesRead) throw new Error(`Windows file changed during safe access: ${target}`)
        hash.update(chunk.subarray(0, result.bytesRead))
        cursor.value += result.bytesRead
        await hooks?.afterSnapshotChunk?.(result.bytesRead)
      }
      const after = await handle.stat()
      const current = await fs.lstat(target)
      const approved = identity(locked.stat)
      const final = identity(current)
      if (
        !same(approved, final) ||
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        cursor.value !== after.size
      ) {
        throw new Error(`Windows file changed during safe access: ${target}`)
      }
      return { ...final, sha256: hash.digest("hex") }
    } finally {
      await handle.close()
    }
  }

  async function stage(parent: Lock, content: string | Uint8Array, mode: number) {
    const child = safeName(`.openscience-${crypto.randomUUID()}.tmp`)
    const target = path.join(parent.path, child)
    const handle = await fs.open(target, "wx", mode)
    try {
      await handle.writeFile(content)
      await handle.sync()
    } finally {
      await handle.close()
    }
    return lockEntry(target, { mutable: true }).then(
      (locked) => ({ child, locked, target }),
      async (error) => {
        await fs.rm(target, { force: true }).catch(() => undefined)
        throw error
      },
    )
  }

  async function copyStage(parent: Lock, source: string, expected: Identity, mode: number) {
    const child = safeName(`.openscience-${crypto.randomUUID()}.tmp`)
    const target = path.join(parent.path, child)
    const input = await fs.open(source, "r")
    const output = await fs.open(target, "wx", mode).catch(async (error) => {
      await input.close()
      throw error
    })
    try {
      const before = identity(await input.stat())
      if (!same(before, expected)) throw new Error(`Trash payload changed while restoring ${source}`)
      const chunk = Buffer.allocUnsafe(1024 * 1024)
      const cursor = { value: 0 }
      while (cursor.value < expected.size) {
        const result = await input.read(
          chunk,
          0,
          Math.min(chunk.byteLength, expected.size - cursor.value),
          cursor.value,
        )
        if (!result.bytesRead) throw new Error(`Trash payload changed while restoring ${source}`)
        await output.write(chunk, 0, result.bytesRead, cursor.value)
        cursor.value += result.bytesRead
      }
      await output.truncate(expected.size)
      await output.sync()
      if (!same(before, identity(await input.stat()))) {
        throw new Error(`Trash payload changed while restoring ${source}`)
      }
    } catch (error) {
      await Promise.all([input.close().catch(() => undefined), output.close().catch(() => undefined)])
      await fs.rm(target, { force: true }).catch(() => undefined)
      throw error
    }
    await Promise.all([input.close(), output.close()])
    return lockEntry(target, { mutable: true }).then(
      (locked) => ({ child, locked, target }),
      async (error) => {
        await fs.rm(target, { force: true }).catch(() => undefined)
        throw error
      },
    )
  }

  async function cleanup(staged: Awaited<ReturnType<typeof stage>>, moved: boolean) {
    if (!moved) dispose(staged.locked.locked)
    staged.locked.locked.close()
  }

  async function approved(
    target: string,
    locked: Awaited<ReturnType<typeof lockEntry>>,
    expected: WriteOptions["approved"],
  ) {
    if (!expected) return
    const result = await snapshot(target, locked)
    const digest = crypto.createHash("sha256").update(expected.bytes).digest("hex")
    if (
      result.kind !== "file" ||
      result.dev !== expected.dev ||
      result.ino !== expected.ino ||
      result.size !== expected.bytes.byteLength ||
      result.sha256 !== digest
    ) {
      throw new Error(`Refusing to write ${target}: the approved file changed before replacement`)
    }
  }

  export async function write(target: string, content: string | Uint8Array, options: WriteOptions) {
    const destination = await createParent(target)
    try {
      await options.afterVerify?.(destination.path)
      const staged = await stage(destination.directory, content, options.mode)
      const state = { moved: false }
      try {
        if (!options.approved) {
          await renameHandle(staged.locked.locked, destination.directory, destination.child, {
            directory: destination.directory,
            child: staged.child,
          }).catch((error: NodeJS.ErrnoException) => {
            if (error.code === "EEXIST") {
              throw new Error(`Refusing to overwrite an unapproved file: ${destination.path}`)
            }
            throw error
          })
          state.moved = true
          return
        }
        const current = await lockEntry(destination.path, { mutable: true })
        try {
          await approved(destination.path, current, options.approved)
          const backup = safeName(`.openscience-approved-${crypto.randomUUID()}.bak`)
          await renameHandle(current.locked, destination.directory, backup, {
            directory: destination.directory,
            child: destination.child,
          })
          const moved = { backup: true }
          try {
            await renameHandle(staged.locked.locked, destination.directory, destination.child, {
              directory: destination.directory,
              child: staged.child,
            })
            state.moved = true
          } catch (error) {
            await renameHandle(current.locked, destination.directory, destination.child, {
              directory: destination.directory,
              child: backup,
            }).catch((rollback) => {
              throw new AggregateError([error, rollback], `Write failed; original retained under ${backup}`)
            })
            moved.backup = false
            throw error
          }
          if (moved.backup) dispose(current.locked)
        } finally {
          current.locked.close()
        }
      } finally {
        await cleanup(staged, state.moved)
      }
    } finally {
      destination.directory.close()
    }
  }

  export async function inspect(target: string): Promise<Entry> {
    const source = await existingParent(target)
    try {
      const current = await lockEntry(source.path)
      try {
        return entry(current.stat)
      } finally {
        current.locked.close()
      }
    } finally {
      source.directory.close()
    }
  }

  export async function moveNoReplace(sourcePath: string, targetPath: string, expected: Entry, options?: MoveOptions) {
    const source = await existingParent(sourcePath)
    const sameParent = equal(source.directory.path, path.dirname(path.resolve(targetPath)))
    const target = sameParent
      ? { directory: source.directory, ...direct(targetPath) }
      : await existingParent(targetPath).catch((error) => {
          source.directory.close()
          throw error
        })
    const current = await lockEntry(source.path, { mutable: true }).catch((error) => {
      if (!sameParent) target.directory.close()
      source.directory.close()
      throw error
    })
    try {
      const before = entry(current.stat)
      if (!sameEntry(before, expected)) {
        throw new Error(`Refusing to rename ${source.path}: the source identity changed after approval`)
      }
      await options?.afterVerify?.(source.path, target.path)
      const final = entry(await fs.lstat(source.path))
      if (!sameEntry(final, expected)) {
        throw new Error(`Refusing to rename ${source.path}: the source identity changed before mutation`)
      }
      await renameHandle(current.locked, target.directory, target.child, {
        directory: source.directory,
        child: source.child,
      })
      try {
        await options?.afterMutation?.(source.path, target.path)
        const result = entry(await fs.lstat(target.path))
        if (!sameEntry(result, expected)) throw new Error(`Renamed source identity changed for ${target.path}`)
      } catch (error) {
        await renameHandle(current.locked, source.directory, source.child, {
          directory: target.directory,
          child: target.child,
        }).catch((rollback) => {
          throw new AggregateError([error, rollback], "Windows rename failed and could not be rolled back safely")
        })
        throw error
      }
      return expected
    } finally {
      current.locked.close()
      source.directory.close()
      if (!sameParent) target.directory.close()
    }
  }

  export async function inspectTrash(target: string, hooks?: Hooks): Promise<Snapshot> {
    const source = await existingParent(target)
    try {
      const current = await lockEntry(source.path)
      try {
        return snapshot(source.path, current, hooks)
      } finally {
        current.locked.close()
      }
    } finally {
      source.directory.close()
    }
  }

  async function atomic(parent: Lock, child: string, content: Uint8Array) {
    const staged = await stage(parent, content, 0o600)
    const moved = { value: false }
    try {
      await renameHandle(staged.locked.locked, parent, child, { directory: parent, child: staged.child }, true)
      moved.value = true
    } finally {
      await cleanup(staged, moved.value)
    }
  }

  async function ensure(root: string, segments: string[], exclusive = false) {
    const initial = await lockDirectory(root)
    const current = { lock: initial }
    try {
      for (const [index, segment] of segments.entries()) {
        const next = await createDirectory(current.lock, segment, exclusive && index === segments.length - 1)
        current.lock.close()
        current.lock = next
      }
      return current.lock
    } catch (error) {
      current.lock.close()
      throw error
    }
  }

  export async function workspace(root: string, id: string) {
    const trash = await ensure(root, [".openscience-trash"])
    try {
      const ignore = path.join(trash.path, ".gitignore")
      const exists = await fs.lstat(ignore).then(
        () => true,
        () => false,
      )
      if (!exists) await atomic(trash, ".gitignore", Buffer.from("*\n"))
      const entry = await createDirectory(trash, id, true)
      const entryPath = entry.path
      entry.close()
      const state = { entry: true, trash: true }
      return {
        entry: entryPath,
        payload: path.join(entryPath, "payload"),
        async write(record: Uint8Array) {
          await writeRecord(path.join(entryPath, "record.json"), record)
        },
        async discard() {
          if (!state.entry) return
          await remove(entryPath)
          state.entry = false
        },
        async close() {
          state.entry = false
          if (state.trash) trash.close()
          state.trash = false
        },
      }
    } catch (error) {
      trash.close()
      throw error
    }
  }

  export async function moveTrash(sourcePath: string, targetPath: string, expected: Identity, hooks?: Hooks) {
    const source = await existingParent(sourcePath)
    const target = await existingParent(targetPath).catch((error) => {
      source.directory.close()
      throw error
    })
    const current = await lockEntry(source.path, { mutable: true }).catch((error) => {
      source.directory.close()
      target.directory.close()
      throw error
    })
    const moved = { value: false }
    try {
      const before = identity(current.stat)
      if (!same(before, expected)) {
        throw new Error(`Refusing to trash ${source.path}: the approved item changed before deletion`)
      }
      await hooks?.afterDirectoryVerify?.("move", source.path)
      const final = identity(await fs.lstat(source.path))
      if (!same(final, expected)) {
        throw new Error(`Refusing to trash ${source.path}: the approved item changed before deletion`)
      }
      await renameHandle(current.locked, target.directory, target.child, {
        directory: source.directory,
        child: source.child,
      })
      moved.value = true
      const result = identity(await fs.lstat(target.path))
      if (!sameObject(result, expected) || result.size !== expected.size || result.mtimeMs !== expected.mtimeMs) {
        await renameHandle(current.locked, source.directory, source.child, {
          directory: target.directory,
          child: target.child,
        })
        moved.value = false
        throw new Error(`Refusing to trash ${source.path}: the item identity changed during deletion`)
      }
      return result
    } catch (error) {
      if (moved.value) {
        await renameHandle(current.locked, source.directory, source.child, {
          directory: target.directory,
          child: target.child,
        }).catch((rollback) => {
          throw new AggregateError([error, rollback], `Trash rollback failed; payload retained at ${target.path}`)
        })
      }
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Refusing to overwrite an existing trash payload: ${target.path}`)
      }
      if ((error as NodeJS.ErrnoException).code === "EXDEV") {
        throw new Error(`Recoverable deletion requires ${source.path} and its trash to share a filesystem`)
      }
      throw error
    } finally {
      current.locked.close()
      target.directory.close()
      source.directory.close()
    }
  }

  export async function restore(
    sourcePath: string,
    targetPath: string,
    expected: Identity,
    _mode: number,
    hooks?: Hooks,
  ) {
    const source = await existingParent(sourcePath)
    const target = await createParent(targetPath).catch((error) => {
      source.directory.close()
      throw error
    })
    const current = await lockEntry(source.path, { mutable: true }).catch((error) => {
      target.directory.close()
      source.directory.close()
      throw error
    })
    try {
      if (!sameObject(identity(current.stat), expected)) {
        throw new Error(`Trash payload identity mismatch for ${source.path}`)
      }
      await hooks?.afterDirectoryVerify?.("restore", target.path)
      if (!sameObject(identity(await fs.lstat(source.path)), expected)) {
        throw new Error(`Trash payload identity mismatch for ${source.path}`)
      }
      await renameHandle(current.locked, target.directory, target.child, {
        directory: source.directory,
        child: source.child,
      })
      try {
        const restored = identity(await fs.lstat(target.path))
        if (!sameObject(restored, expected)) throw new Error(`Restored item identity mismatch for ${target.path}`)
      } catch (error) {
        await renameHandle(current.locked, source.directory, source.child, {
          directory: target.directory,
          child: target.child,
        }).catch((rollback) => {
          throw new AggregateError([error, rollback], `Restore rollback failed; item retained at ${target.path}`)
        })
        throw error
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Refusing to overwrite ${target.path}`)
      }
      throw error
    } finally {
      current.locked.close()
      target.directory.close()
      source.directory.close()
    }
  }

  export async function copy(sourcePath: string, targetPath: string, expected: Identity, mode: number, hooks?: Hooks) {
    const source = await existingParent(sourcePath)
    const target = await createParent(targetPath).catch((error) => {
      source.directory.close()
      throw error
    })
    const current = await lockEntry(source.path).catch((error) => {
      target.directory.close()
      source.directory.close()
      throw error
    })
    try {
      if (current.locked.identity.type !== "file" || !sameObject(identity(current.stat), expected)) {
        throw new Error(`Trash payload identity mismatch for ${source.path}`)
      }
      await hooks?.afterDirectoryVerify?.("restore", target.path)
      const staged = await copyStage(target.directory, source.path, expected, mode)
      const moved = { value: false }
      try {
        const final = identity(await fs.lstat(source.path))
        if (!same(identity(current.stat), final))
          throw new Error(`Trash payload changed while restoring ${source.path}`)
        await renameHandle(staged.locked.locked, target.directory, target.child, {
          directory: target.directory,
          child: staged.child,
        }).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "EEXIST") throw new Error(`Refusing to overwrite ${target.path}`)
          throw error
        })
        moved.value = true
      } finally {
        await cleanup(staged, moved.value)
      }
    } finally {
      current.locked.close()
      target.directory.close()
      source.directory.close()
    }
  }

  async function empty(directory: Lock): Promise<void> {
    const entries = await fs.opendir(directory.path)
    for await (const entry of entries) {
      const child = path.join(directory.path, safeName(entry.name))
      const current = await lockEntry(child, { mutable: true, reparse: true })
      try {
        if (current.locked.identity.type === "directory" && !current.locked.identity.reparse) {
          await empty(current.locked)
        }
        dispose(current.locked)
      } finally {
        current.locked.close()
      }
    }
  }

  export async function remove(targetPath: string, expected?: Identity, hooks?: Hooks) {
    const target = await existingParent(targetPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return
      throw error
    })
    if (!target) return false
    const current = await lockEntry(target.path, { mutable: true, reparse: true }).catch(
      (error: NodeJS.ErrnoException) => {
        target.directory.close()
        if (error.code === "ENOENT") return
        throw error
      },
    )
    if (!current) return false
    try {
      if (expected && !sameObject(identity(current.stat), expected)) {
        throw new Error(`Trash payload identity mismatch for ${target.path}`)
      }
      await hooks?.afterDirectoryVerify?.("remove", target.path)
      if (current.locked.identity.type === "directory" && !current.locked.identity.reparse) {
        await empty(current.locked)
      }
      dispose(current.locked)
      return true
    } finally {
      current.locked.close()
      target.directory.close()
    }
  }

  export async function writeRecord(targetPath: string, record: Uint8Array) {
    const target = await existingParent(targetPath)
    try {
      await atomic(target.directory, target.child, record)
    } finally {
      target.directory.close()
    }
  }

  export async function ensureDataEntry(dataRoot: string, project: string, id: string) {
    const entry = await ensure(dataRoot, ["file-trash", safeName(project), safeName(id)], true)
    const result = entry.path
    entry.close()
    return result
  }
}

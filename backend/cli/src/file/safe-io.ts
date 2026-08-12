import crypto from "node:crypto"
import { constants as FS } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { Filesystem } from "@/util/filesystem"

/** Final-component symlink-safe file I/O for host broker operations. */
export namespace SafeFileIO {
  export type Snapshot = {
    bytes: Buffer
    dev: number
    ino: number
    mode: number
    mtimeMs: number
  }

  export async function read(filepath: string): Promise<Snapshot> {
    const requested = await fs.lstat(filepath)
    if (requested.isSymbolicLink()) throw new Error(`Refusing to follow a symbolic link: ${filepath}`)
    const handle = await fs.open(filepath, FS.O_RDONLY | FS.O_NOFOLLOW)
    try {
      const before = await handle.stat()
      if (!before.isFile()) throw new Error(`Only regular files can be accessed: ${filepath}`)
      const bytes = await handle.readFile()
      const after = await handle.stat()
      if (
        before.dev !== after.dev ||
        before.ino !== after.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs
      ) {
        throw new Error(`Refusing to read ${filepath}: the file changed during access`)
      }
      return { bytes, dev: after.dev, ino: after.ino, mode: after.mode & 0o777, mtimeMs: after.mtimeMs }
    } finally {
      await handle.close()
    }
  }

  export async function optional(filepath: string) {
    return read(filepath).catch((error: NodeJS.ErrnoException) => {
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

  async function stage(target: string, content: string | Uint8Array, mode: number) {
    await fs.mkdir(path.dirname(target), { recursive: true })
    const canonical = await Filesystem.canonical(target)
    if (!canonical || canonical !== target) throw new Error(`Write destination became ambiguous: ${target}`)
    const staged = path.join(path.dirname(target), `.openscience-write-${crypto.randomUUID()}.tmp`)
    await fs.writeFile(staged, content, { flag: "wx", mode })
    return staged
  }

  async function install(staged: string, target: string) {
    try {
      await fs.link(staged, target)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Refusing to overwrite an unapproved file: ${target}`)
      }
      throw error
    }
  }

  export async function write(filepath: string, content: string | Uint8Array, approved?: Snapshot) {
    if (!approved) {
      await absent(filepath)
      const staged = await stage(filepath, content, 0o644)
      try {
        await install(staged, filepath)
      } finally {
        await fs.rm(staged, { force: true })
      }
      return
    }

    await assert(filepath, approved)
    const staged = await stage(filepath, content, approved.mode)
    const backup = path.join(path.dirname(filepath), `.openscience-approved-${crypto.randomUUID()}.bak`)
    let moved = false
    let installed = false
    try {
      await fs.rename(filepath, backup)
      moved = true
      await assert(backup, approved)
      await install(staged, filepath)
      installed = true
      await fs.unlink(staged)
      await fs.unlink(backup)
    } catch (error) {
      if (moved && !installed) {
        try {
          await install(backup, filepath)
          await fs.unlink(backup)
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], `Write failed; original retained at ${backup}`)
        }
      }
      throw error
    } finally {
      await fs.rm(staged, { force: true })
    }
  }
}

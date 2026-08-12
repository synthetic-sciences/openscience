import crypto from "node:crypto"
import path from "node:path"
import fs from "node:fs/promises"
import { constants as FS } from "node:fs"
import z from "zod"
import { Global } from "@/global"
import { SessionFilesystem } from "@/session/filesystem"
import { Lock } from "@/util/lock"
import { Filesystem } from "@/util/filesystem"

/** Recoverable trash for source/workspace files deleted by agent edit tools.
 * Bytes live outside the project so a later project command cannot mutate the
 * recovery copy. Records expire after 30 days and are purged opportunistically. */
export namespace FileTrash {
  export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000

  export const Record = z.object({
    id: z.string().startsWith("ftr_"),
    projectID: z.string(),
    sessionID: z.string().optional(),
    originalPath: z.string(),
    filename: z.string(),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mode: z.number().int().nonnegative(),
    state: z.enum(["trash", "restored"]),
    trashedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    restoredAt: z.number().int().positive().optional(),
  })
  export type Record = z.infer<typeof Record>

  const root = path.join(Global.Path.data, "file-trash")
  const segment = (value: string) => crypto.createHash("sha256").update(value).digest("hex")
  const projectRoot = (projectID: string) => path.join(root, segment(projectID))
  const entryRoot = (projectID: string, id: string) => path.join(projectRoot(projectID), id)
  const metadata = (projectID: string, id: string) => path.join(entryRoot(projectID, id), "record.json")
  const payload = (projectID: string, id: string) => path.join(entryRoot(projectID, id), "payload")
  const lock = (projectID: string) => `file-trash:${segment(projectID)}`

  async function writeRecord(record: Record) {
    const target = metadata(record.projectID, record.id)
    const temp = `${target}.${crypto.randomUUID()}.tmp`
    await fs.writeFile(temp, JSON.stringify(record, null, 2), { mode: 0o600 })
    await fs.rename(temp, target)
  }

  async function read(projectID: string, id: string) {
    if (!/^ftr_[0-9a-f-]{36}$/.test(id)) return
    return Bun.file(metadata(projectID, id))
      .json()
      .then((value) => Record.parse(value))
      .catch(() => undefined)
  }

  async function records(projectID: string) {
    const names = await fs.readdir(projectRoot(projectID)).catch(() => [] as string[])
    const parsed = (await Promise.all(names.map((id) => read(projectID, id)))).filter(
      (value): value is Record => !!value && value.projectID === projectID,
    )
    // A crash after metadata is persisted but before the source inode is moved
    // must not advertise a recovery record whose payload never existed.
    const available = await Promise.all(
      parsed.map(async (record) => {
        const stat = await fs.lstat(payload(projectID, record.id)).catch(() => undefined)
        return stat?.isFile() && !stat.isSymbolicLink() ? record : undefined
      }),
    )
    return available.filter((value): value is Record => !!value).toSorted((a, b) => b.trashedAt - a.trashedAt)
  }

  async function purgeExpiredUnlocked(projectID: string, now = Date.now()) {
    const expired = (await records(projectID)).filter((record) => record.expiresAt <= now)
    await Promise.all(expired.map((record) => fs.rm(entryRoot(projectID, record.id), { recursive: true, force: true })))
    return expired.length
  }

  export async function list(projectID: string) {
    using _ = await Lock.write(lock(projectID))
    await purgeExpiredUnlocked(projectID)
    return (await records(projectID)).filter((record) => record.state === "trash")
  }

  async function openRegular(filepath: string) {
    const handle = await fs.open(filepath, FS.O_RDONLY | FS.O_NOFOLLOW)
    try {
      const stat = await handle.stat()
      if (!stat.isFile()) throw new Error(`Only canonical regular files can be trashed: ${filepath}`)
      return { stat, content: await handle.readFile() }
    } finally {
      await handle.close()
    }
  }

  async function restoreMovedPayload(record: Record, removeEntry: boolean) {
    const source = payload(record.projectID, record.id)
    await fs.mkdir(path.dirname(record.originalPath), { recursive: true })
    await fs.chmod(source, record.mode)
    try {
      // Hard-link installation is exclusive: unlike rename(), it cannot
      // overwrite a file that appeared at the restore path after approval.
      await fs.link(source, record.originalPath)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "EEXIST") {
        throw new Error(`Refusing to overwrite ${record.originalPath}; recovery payload retained at ${source}`)
      }
      throw new Error(`Could not restore ${record.originalPath}; recovery payload retained at ${source}: ${error}`)
    }
    if (!removeEntry) return
    await fs.unlink(source)
    await fs.rm(entryRoot(record.projectID, record.id), { recursive: true, force: true })
  }

  export async function trash(input: {
    projectID: string
    sessionID?: string
    path: string
    expectedContent?: string | Uint8Array
    now?: number
  }): Promise<Record> {
    const requested = path.resolve(input.path)
    const requestedStat = await fs.lstat(requested)
    if (requestedStat.isSymbolicLink()) throw new Error(`Refusing to trash a symbolic link: ${requested}`)
    const canonical = await Filesystem.canonical(input.path)
    if (!canonical) throw new Error(`Cannot trash an ambiguous path: ${input.path}`)
    const { stat, content } = await openRegular(canonical)
    if (input.expectedContent !== undefined) {
      const expected =
        typeof input.expectedContent === "string" ? Buffer.from(input.expectedContent, "utf8") : input.expectedContent
      if (!Buffer.from(expected).equals(content)) {
        throw new Error(`Refusing to delete ${canonical}: the file changed after approval`)
      }
    }

    const id = `ftr_${crypto.randomUUID()}`
    const now = input.now ?? Date.now()
    const record = Record.parse({
      id,
      projectID: input.projectID,
      sessionID: input.sessionID,
      originalPath: canonical,
      filename: path.basename(canonical),
      size: content.byteLength,
      sha256: crypto.createHash("sha256").update(content).digest("hex"),
      mode: stat.mode & 0o777,
      state: "trash",
      trashedAt: now,
      expiresAt: now + RETENTION_MS,
    })

    using _ = await Lock.write(lock(input.projectID))
    await purgeExpiredUnlocked(input.projectID, now)
    const directory = entryRoot(input.projectID, id)
    await fs.mkdir(projectRoot(input.projectID), { recursive: true, mode: 0o700 })
    await fs.mkdir(directory, { recursive: false, mode: 0o700 })
    let moved = false
    try {
      // Persist recovery metadata before moving the inode. The project lock
      // keeps the transient record private from list/restore calls, and a
      // crash after rename still leaves a discoverable recovery record.
      await writeRecord(record)
      try {
        // Same-filesystem rename is the deletion primitive. It atomically
        // removes the pathname and preserves the exact inode; there is no
        // lstat/read/unlink pathname race.
        await fs.rename(canonical, payload(input.projectID, id))
        moved = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EXDEV") {
          throw new Error(
            `Recoverable deletion requires the trash and ${canonical} to share a filesystem; refusing to delete`,
          )
        }
        throw error
      }

      const movedFile = await openRegular(payload(input.projectID, id))
      if (movedFile.stat.dev !== stat.dev || movedFile.stat.ino !== stat.ino) {
        throw new Error(`Refusing to delete ${canonical}: the file identity changed after approval`)
      }
      if (!movedFile.content.equals(content)) {
        throw new Error(`Refusing to delete ${canonical}: the file changed after approval`)
      }
      await fs.chmod(payload(input.projectID, id), 0o600)
      return record
    } catch (error) {
      if (moved) {
        try {
          await restoreMovedPayload(record, true)
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `Trash operation failed; recovery payload retained for ${canonical}`,
          )
        }
      } else {
        await fs.rm(directory, { recursive: true, force: true })
      }
      throw error
    }
  }

  export async function restore(input: { projectID: string; sessionID: string; id: string }) {
    using _ = await Lock.write(lock(input.projectID))
    const record = await read(input.projectID, input.id)
    if (!record || record.state !== "trash") return
    if (record.expiresAt <= Date.now()) {
      await fs.rm(entryRoot(input.projectID, input.id), { recursive: true, force: true })
      return
    }
    const authorized = await SessionFilesystem.authorize({
      sessionID: input.sessionID,
      path: record.originalPath,
      access: "write",
    })
    if (authorized.path !== record.originalPath) throw new Error("Trash restore path changed after authorization")
    await fs.mkdir(path.dirname(record.originalPath), { recursive: true })
    const temp = path.join(path.dirname(record.originalPath), `.openscience-restore-${record.id}.tmp`)
    try {
      await fs.copyFile(payload(input.projectID, input.id), temp, FS.COPYFILE_EXCL)
      await fs.chmod(temp, record.mode)
      const restored = await fs.readFile(temp)
      const digest = crypto.createHash("sha256").update(restored).digest("hex")
      if (digest !== record.sha256) throw new Error(`Trash payload checksum mismatch for ${record.id}`)
      try {
        await fs.link(temp, record.originalPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`Refusing to overwrite an existing file while restoring ${record.originalPath}`)
        }
        throw error
      }
    } finally {
      await fs.rm(temp, { force: true })
    }
    const result = Record.parse({ ...record, state: "restored", restoredAt: Date.now() })
    await writeRecord(result)
    return result
  }

  /** Roll back a just-created trash record when a larger single-file edit
   * cannot complete. This is intentionally not exposed through the server. */
  export async function rollback(record: Record) {
    using _ = await Lock.write(lock(record.projectID))
    const stored = await read(record.projectID, record.id)
    if (!stored || stored.state !== "trash" || stored.originalPath !== record.originalPath) {
      throw new Error(`Cannot roll back unknown trash record ${record.id}`)
    }
    await restoreMovedPayload(stored, true)
  }

  export async function purgeExpired(projectID: string, now = Date.now()) {
    using _ = await Lock.write(lock(projectID))
    return purgeExpiredUnlocked(projectID, now)
  }
}

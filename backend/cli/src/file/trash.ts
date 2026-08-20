import crypto from "node:crypto"
import { createReadStream, constants as FS } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { HTTPException } from "hono/http-exception"
import z from "zod"
import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { SessionFilesystem } from "@/session/filesystem"
import { Filesystem } from "@/util/filesystem"
import { Lock } from "@/util/lock"

/** Recoverable trash for source and workspace files. Recovery metadata stays
 * in the protected data root; new payloads stay beside their authorized source
 * so moving even a large directory is an atomic, same-volume rename. */
export namespace FileTrash {
  export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
  export const FOLDER = ".openscience-trash"

  export const Record = z.object({
    id: z.string().startsWith("ftr_"),
    projectID: z.string(),
    sessionID: z.string().optional(),
    originalPath: z.string(),
    filename: z.string(),
    size: z.number().int().nonnegative(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    mode: z.number().int().nonnegative(),
    kind: z.enum(["file", "directory"]).default("file"),
    store: z.enum(["data", "workspace"]).default("data"),
    payloadPath: z.string().optional(),
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
  const legacyPayload = (projectID: string, id: string) => path.join(entryRoot(projectID, id), "payload")
  const lock = (projectID: string) => `file-trash:${segment(projectID)}`
  const localEntry = (record: Record) => {
    if (!record.payloadPath || !path.isAbsolute(record.payloadPath) || !path.isAbsolute(record.originalPath)) return
    const entry = path.dirname(record.payloadPath)
    const trash = path.dirname(entry)
    const source = path.dirname(trash)
    if (
      path.basename(record.payloadPath) !== "payload" ||
      path.basename(entry) !== record.id ||
      path.basename(trash) !== FOLDER ||
      !Filesystem.contains(source, record.originalPath)
    )
      return
    return entry
  }
  const payload = (record: Record) => {
    if (!record.payloadPath) return legacyPayload(record.projectID, record.id)
    if (localEntry(record)) return record.payloadPath
  }

  export function protectedPath(value: string) {
    return path.resolve(value).split(path.sep).includes(FOLDER)
  }

  async function atomicJson(target: string, record: Record) {
    const temp = `${target}.${crypto.randomUUID()}.tmp`
    await fs.writeFile(temp, JSON.stringify(record, null, 2), { mode: 0o600 })
    await fs.rename(temp, target)
  }

  async function writeRecord(record: Record, local = true) {
    const trusted = metadata(record.projectID, record.id)
    await fs.mkdir(path.dirname(trusted), { recursive: true, mode: 0o700 })
    await atomicJson(trusted, record)
    const entry = localEntry(record)
    if (local && entry) await atomicJson(path.join(entry, "record.json"), record)
  }

  async function read(projectID: string, id: string) {
    if (!/^ftr_[0-9a-f-]{36}$/.test(id)) return
    return Bun.file(metadata(projectID, id))
      .json()
      .then((value) => Record.parse(value))
      .catch(() => undefined)
  }

  async function parsed(projectID: string) {
    const names = await fs.readdir(projectRoot(projectID)).catch(() => [] as string[])
    const records = await Promise.all(names.map((id) => read(projectID, id)))
    return records.filter((value): value is Record => !!value && value.projectID === projectID)
  }

  async function available(record: Record) {
    const target = payload(record)
    if (!target) return false
    const stat = await fs.lstat(target).catch(() => undefined)
    if (!stat || stat.isSymbolicLink()) return false
    return record.kind === "directory" ? stat.isDirectory() : stat.isFile()
  }

  async function records(projectID: string) {
    const records = await parsed(projectID)
    const states = await Promise.all(records.map((record) => available(record)))
    return records.filter((_, index) => states[index]).toSorted((a, b) => b.trashedAt - a.trashedAt)
  }

  async function remove(record: Record) {
    const entry = localEntry(record)
    if (entry) {
      const trash = await fs.lstat(path.dirname(entry)).catch(() => undefined)
      const current = await fs.lstat(entry).catch(() => undefined)
      if (trash?.isDirectory() && !trash.isSymbolicLink() && current?.isDirectory() && !current.isSymbolicLink()) {
        await fs.rm(entry, { recursive: true, force: true })
      }
    }
    await fs.rm(entryRoot(record.projectID, record.id), { recursive: true, force: true })
  }

  async function purgeExpiredUnlocked(projectID: string, now = Date.now()) {
    const expired = (await parsed(projectID)).filter((record) => record.expiresAt <= now)
    await Promise.all(expired.map(remove))
    return expired.length
  }

  export async function list(projectID: string) {
    using _ = await Lock.write(lock(projectID))
    await purgeExpiredUnlocked(projectID)
    return (await records(projectID)).filter((record) => record.state === "trash")
  }

  async function hash(filepath: string) {
    const digest = crypto.createHash("sha256")
    for await (const chunk of createReadStream(filepath)) digest.update(chunk)
    return digest.digest("hex")
  }

  async function owner(input: { root?: string; sessionID?: string }, target: string) {
    const workspace = input.sessionID
      ? await SessionFilesystem.workspace(input.sessionID).catch(() => undefined)
      : undefined
    const grants = input.sessionID ? await SessionFilesystem.list(input.sessionID).catch(() => []) : []
    const writable = grants.filter((grant) => grant.access === "write" && !grant.time.revoked && !grant.time.consumed)
    const roots = [input.root, workspace, Instance.directory, ...writable.map((grant) => grant.path)].filter(
      (value): value is string => !!value,
    )
    const canonical = await Promise.all(
      [...new Set(roots)].map((value) => Filesystem.canonical(value).catch(() => undefined)),
    )
    const candidates = await Promise.all(
      canonical
        .filter((value): value is string => !!value && value !== target && Filesystem.contains(value, target))
        .map(async (value) => ((await fs.stat(value).catch(() => undefined))?.isDirectory() ? value : undefined)),
    )
    return candidates.filter((value): value is string => !!value).toSorted((a, b) => b.length - a.length)[0]
  }

  async function workspaceStore(root: string, id: string) {
    const trash = path.join(root, FOLDER)
    const entry = path.join(trash, id)
    await fs.mkdir(trash, { recursive: true, mode: 0o700 })
    const stat = await fs.lstat(trash)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Invalid workspace trash root: ${trash}`)
    await fs
      .writeFile(path.join(trash, ".gitignore"), "*\n", { flag: "wx", mode: 0o600 })
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error
      })
    await fs.mkdir(entry, { recursive: false, mode: 0o700 })
    return path.join(entry, "payload")
  }

  export async function trash(input: {
    projectID: string
    sessionID?: string
    path: string
    root?: string
    expectedContent?: string | Uint8Array
    now?: number
  }): Promise<Record> {
    const requested = path.resolve(input.path)
    const requestedStat = await fs.lstat(requested)
    if (requestedStat.isSymbolicLink()) throw new Error(`Refusing to trash a symbolic link: ${requested}`)
    const canonical = await Filesystem.canonical(input.path)
    if (!canonical) throw new Error(`Cannot trash an ambiguous path: ${input.path}`)
    if (canonical === Instance.directory) throw new Error(`Refusing to trash the project root: ${canonical}`)
    if (protectedPath(canonical)) throw new Error(`Refusing to trash recovery data: ${canonical}`)
    const stat = await fs.lstat(canonical)
    const kind = stat.isDirectory() ? "directory" : stat.isFile() ? "file" : undefined
    if (!kind) throw new Error(`Only canonical files and folders can be trashed: ${canonical}`)
    if (kind === "directory" && input.expectedContent !== undefined) {
      throw new Error(`Expected content cannot be supplied for a directory: ${canonical}`)
    }

    const id = `ftr_${crypto.randomUUID()}`
    const now = input.now ?? Date.now()
    const home = await owner(input, canonical)
    const target = home ? await workspaceStore(home, id) : legacyPayload(input.projectID, id)
    const expected =
      input.expectedContent === undefined
        ? undefined
        : crypto
            .createHash("sha256")
            .update(
              typeof input.expectedContent === "string"
                ? Buffer.from(input.expectedContent, "utf8")
                : input.expectedContent,
            )
            .digest("hex")
    const record = Record.parse({
      id,
      projectID: input.projectID,
      sessionID: input.sessionID,
      originalPath: canonical,
      filename: path.basename(canonical),
      size: kind === "file" ? stat.size : 0,
      sha256: expected,
      mode: stat.mode & 0o777,
      kind,
      store: home ? "workspace" : "data",
      payloadPath: home ? target : undefined,
      state: "trash",
      trashedAt: now,
      expiresAt: now + RETENTION_MS,
    })

    using _ = await Lock.write(lock(input.projectID))
    await purgeExpiredUnlocked(input.projectID, now)
    if (!home) await fs.mkdir(entryRoot(input.projectID, id), { recursive: true, mode: 0o700 })
    const state = { moved: false }
    try {
      await writeRecord(record)
      await fs.rename(canonical, target).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EXDEV") throw error
        throw new Error(`Recoverable deletion requires ${canonical} and its trash to share a filesystem`)
      })
      state.moved = true

      const moved = await fs.lstat(target)
      if (moved.dev !== stat.dev || moved.ino !== stat.ino) {
        throw new Error(`Refusing to delete ${canonical}: the file identity changed after approval`)
      }
      if (expected && (await hash(target)) !== expected) {
        throw new Error(`Refusing to delete ${canonical}: the file changed after approval`)
      }
      if (kind === "file") await fs.chmod(target, 0o600)
      return record
    } catch (error) {
      if (!state.moved) {
        await remove(record)
        throw error
      }
      const conflict = await fs.lstat(canonical).catch(() => undefined)
      if (conflict) {
        throw new AggregateError([error], `Trash operation failed; recovery payload retained for ${canonical}`)
      }
      await fs.rename(target, canonical)
      await remove(record)
      throw error
    }
  }

  async function validateWorkspaceRecord(record: Record) {
    if (record.store !== "workspace" || !record.payloadPath) return
    const entry = localEntry(record)
    if (!entry) throw new Error(`Invalid workspace trash metadata for ${record.id}`)
    const trash = await fs.lstat(path.dirname(entry)).catch(() => undefined)
    const current = await fs.lstat(entry).catch(() => undefined)
    if (!trash?.isDirectory() || trash.isSymbolicLink() || !current?.isDirectory() || current.isSymbolicLink()) {
      throw new Error(`Invalid workspace trash metadata for ${record.id}`)
    }
    const local = await Bun.file(path.join(entry, "record.json"))
      .json()
      .then((value) => Record.parse(value))
      .catch(() => undefined)
    if (!local || JSON.stringify(local) !== JSON.stringify(record)) {
      throw new Error(`Workspace trash metadata mismatch for ${record.id}`)
    }
  }

  async function authorize(record: Record, sessionID: string) {
    const authorized = await SessionFilesystem.authorize({
      sessionID,
      path: record.originalPath,
      access: "write",
    })
    if (authorized.path !== record.originalPath) throw new Error("Trash restore path changed after authorization")
    await validateWorkspaceRecord(record)
  }

  export async function restore(input: { projectID: string; sessionID: string; id: string }) {
    using _ = await Lock.write(lock(input.projectID))
    const record = await read(input.projectID, input.id)
    if (!record || record.state !== "trash" || !(await available(record))) return
    if (record.expiresAt <= Date.now()) {
      await remove(record)
      return
    }
    await authorize(record, input.sessionID)
    await fs.mkdir(path.dirname(record.originalPath), { recursive: true })
    if (await fs.lstat(record.originalPath).catch(() => undefined)) {
      throw new HTTPException(409, { message: `Refusing to overwrite ${record.originalPath}` })
    }
    const source = payload(record)
    if (!source) throw new Error(`Invalid trash payload for ${record.id}`)
    if (record.sha256 && record.kind === "file" && (await hash(source)) !== record.sha256) {
      throw new Error(`Trash payload checksum mismatch for ${record.id}`)
    }

    if (record.store === "workspace") {
      await fs.rename(source, record.originalPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST" || error.code === "ENOTEMPTY") {
          throw new HTTPException(409, { message: `Refusing to overwrite ${record.originalPath}` })
        }
        throw error
      })
      if (record.kind === "file") await fs.chmod(record.originalPath, record.mode)
      const result = Record.parse({ ...record, state: "restored", restoredAt: Date.now() })
      await writeRecord(result, false)
      const entry = localEntry(record)
      if (entry) await fs.rm(entry, { recursive: true, force: true })
      return result
    }

    const temp = path.join(path.dirname(record.originalPath), `.openscience-restore-${record.id}.tmp`)
    try {
      await fs.copyFile(source, temp, FS.COPYFILE_EXCL)
      await fs.chmod(temp, record.mode)
      await fs.link(temp, record.originalPath).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "EEXIST") {
          throw new HTTPException(409, { message: `Refusing to overwrite ${record.originalPath}` })
        }
        throw error
      })
    } finally {
      await fs.rm(temp, { force: true })
    }
    const result = Record.parse({ ...record, state: "restored", restoredAt: Date.now() })
    await writeRecord(result)
    return result
  }

  export async function purge(input: { projectID: string; sessionID: string; id: string }) {
    using _ = await Lock.write(lock(input.projectID))
    const record = await read(input.projectID, input.id)
    if (!record || record.state !== "trash" || !(await available(record))) return
    await authorize(record, input.sessionID)
    await remove(record)
    return record
  }

  /** Roll back a just-created trash record when a larger single-file edit
   * cannot complete. This is intentionally not exposed through the server. */
  export async function rollback(record: Record) {
    using _ = await Lock.write(lock(record.projectID))
    const stored = await read(record.projectID, record.id)
    if (!stored || stored.state !== "trash" || stored.originalPath !== record.originalPath) {
      throw new Error(`Cannot roll back unknown trash record ${record.id}`)
    }
    const source = payload(stored)
    if (!source) throw new Error(`Invalid trash payload for ${stored.id}`)
    if (await fs.lstat(stored.originalPath).catch(() => undefined)) {
      throw new Error(`Refusing to overwrite ${stored.originalPath}; recovery payload retained at ${source}`)
    }
    if (stored.store === "workspace") {
      await fs.rename(source, stored.originalPath)
      if (stored.kind === "file") await fs.chmod(stored.originalPath, stored.mode)
    }
    if (stored.store === "data") {
      await fs.chmod(source, stored.mode)
      await fs.link(source, stored.originalPath)
    }
    await remove(stored)
  }

  export async function purgeExpired(projectID: string, now = Date.now()) {
    using _ = await Lock.write(lock(projectID))
    return purgeExpiredUnlocked(projectID, now)
  }
}

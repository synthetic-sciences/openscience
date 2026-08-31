import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { HTTPException } from "hono/http-exception"
import z from "zod"
import { Global } from "@/global"
import { AuthoritySignal } from "@/project/authority-signal"
import { Instance } from "@/project/instance"
import { SessionFilesystem } from "@/session/filesystem"
import { Filesystem } from "@/util/filesystem"
import { Lock } from "@/util/lock"
import { SafeFileIO } from "./safe-io"
import { SafeTrashIO } from "./safe-trash-io"
import { Project } from "@/project/project"
import { Log } from "@/util/log"

/** Recoverable trash for source and workspace files. Recovery metadata stays
 * in the protected data root; new payloads stay beside their authorized source
 * so moving even a large directory is an atomic, same-volume rename. */
export namespace FileTrash {
  export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000
  export const FOLDER = ".openscience-trash"
  const log = Log.create({ service: "file.trash" })
  const activity = (projectID: string) =>
    Project.touchActivity(projectID).catch((error) => log.warn("file activity update failed", { error }))

  const Identity = z.object({
    dev: z.number().int().nonnegative(),
    ino: z.number().int().nonnegative(),
    size: z.number().int().nonnegative(),
    mode: z.number().int().nonnegative(),
    mtimeMs: z.number().nonnegative(),
    ctimeMs: z.number().nonnegative(),
    kind: z.enum(["file", "directory"]),
  })

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
    payloadIdentity: Identity.optional(),
    state: z.enum(["trash", "restored"]),
    trashedAt: z.number().int().positive(),
    expiresAt: z.number().int().positive(),
    restoredAt: z.number().int().positive().optional(),
  })
  export type Record = z.infer<typeof Record>

  type TestHooks = {
    afterAuthorization?: (
      action: "trash" | "restore" | "purge",
      record?: Record,
      authorization?: SessionFilesystem.Authorization,
    ) => void | Promise<void>
    afterDirectoryVerify?: SafeTrashIO.Hooks["afterDirectoryVerify"]
  }

  const hooks = { value: undefined as TestHooks | undefined }

  /** Deterministic barriers for the real authorization and *at(2) paths. */
  export function testing(input: TestHooks) {
    if (!process.env.OPENSCIENCE_TEST_HOME) throw new Error("FileTrash test hooks are disabled outside tests")
    const prior = hooks.value
    hooks.value = input
    return {
      [Symbol.dispose]() {
        if (hooks.value === input) hooks.value = prior
      },
    }
  }

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

  function encoded(record: Record) {
    return Buffer.from(JSON.stringify(record, null, 2))
  }

  async function target(value: string) {
    const result = await Filesystem.canonical(value)
    if (!result) throw new Error(`Trash path became ambiguous: ${value}`)
    return result
  }

  async function writeRecord(record: Record) {
    await SafeTrashIO.writeRecord(await target(metadata(record.projectID, record.id)), encoded(record))
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

  function stableIdentity(record: Record, current: SafeTrashIO.Snapshot) {
    const approved = record.payloadIdentity
    if (!approved) return true
    return approved.dev === current.dev && approved.ino === current.ino && approved.kind === current.kind
  }

  async function verifyPayload(record: Record) {
    const source = payload(record)
    if (!source) throw new Error(`Invalid trash payload for ${record.id}`)
    const current = await SafeTrashIO.inspect(source)
    if (!stableIdentity(record, current)) throw new Error(`Trash payload identity mismatch for ${record.id}`)
    if (record.kind !== current.kind) throw new Error(`Trash payload kind mismatch for ${record.id}`)
    if (record.kind === "file" && record.sha256 && current.sha256 !== record.sha256) {
      throw new Error(`Trash payload checksum mismatch for ${record.id}`)
    }
    return { source, current }
  }

  async function remove(record: Record, options?: { verified?: SafeTrashIO.Snapshot }) {
    // Same-volume restoration moves the payload back to its original path
    // and removes the local trash entry. The remaining global record is only
    // bookkeeping: expiry must not look for (or touch) the restored file.
    if (record.state === "restored" && record.store === "workspace") {
      const trusted = await target(entryRoot(record.projectID, record.id))
      await SafeTrashIO.remove(trusted)
      return
    }
    const verified = options?.verified ?? (await verifyPayload(record)).current
    const entry = localEntry(record)
    if (entry) {
      await SafeTrashIO.remove(entry, undefined, { afterDirectoryVerify: hooks.value?.afterDirectoryVerify })
    }
    const trusted = await target(entryRoot(record.projectID, record.id)).catch(() => undefined)
    if (trusted && !entry) {
      await SafeTrashIO.remove(path.join(trusted, "payload"), verified, {
        afterDirectoryVerify: hooks.value?.afterDirectoryVerify,
      })
    }
    if (trusted) await SafeTrashIO.remove(trusted)
  }

  async function purgeExpiredUnlocked(projectID: string, now = Date.now()) {
    const expired = (await parsed(projectID)).filter((record) => record.expiresAt <= now)
    const removed = await Promise.all(
      expired.map((record) =>
        remove(record).then(
          () => 1,
          (error) => {
            // Automatic cleanup must not block unrelated recovery when a
            // volume is unavailable or a payload cannot be verified. Keep
            // the record for a later attempt; explicit operations stay strict.
            log.warn("expired trash cleanup deferred", { id: record.id, error })
            return 0
          },
        ),
      ),
    )
    return removed.reduce((total, count) => total + count, 0)
  }

  export async function list(projectID: string) {
    using _ = await Lock.write(lock(projectID))
    await purgeExpiredUnlocked(projectID)
    return (await records(projectID)).filter((record) => record.state === "trash")
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

  type AuthorizationScope = {
    authorization?: SessionFilesystem.Authorization
    ownership: "borrowed" | "owned" | "none"
    [Symbol.dispose](): void
  }

  async function binding(input: {
    sessionID: string
    path: string
    authorization?: SessionFilesystem.Authorization
    authorizationOwnership?: "borrowed" | "owned"
  }): Promise<AuthorizationScope> {
    const ownership = input.authorization ? (input.authorizationOwnership ?? "borrowed") : "owned"
    const state = { released: false }
    const release = (authorization?: SessionFilesystem.Authorization) => {
      if (!authorization || ownership !== "owned" || state.released) return
      state.released = true
      SessionFilesystem.releaseAuthorization(authorization)
    }
    if (!input.sessionID.startsWith("ses_")) {
      if (process.env.OPENSCIENCE_TEST_HOME) return { ownership: "none", [Symbol.dispose]() {} }
      release(input.authorization)
      throw new SessionFilesystem.DeniedError({ sessionID: input.sessionID, path: input.path, access: "write" })
    }
    if (input.authorization) {
      if (input.authorization.sessionID !== input.sessionID || input.authorization.path !== input.path) {
        release(input.authorization)
        throw new SessionFilesystem.DeniedError({
          sessionID: input.sessionID,
          path: input.path,
          access: "write",
        })
      }
      return {
        authorization: input.authorization,
        ownership,
        [Symbol.dispose]() {
          release(input.authorization)
        },
      }
    }
    const authorized = await SessionFilesystem.authorize({
      sessionID: input.sessionID,
      path: input.path,
      access: "write",
    })
    const authorization = await SessionFilesystem.bindAuthorization({
      sessionID: input.sessionID,
      access: "write",
      authorized,
    })
    return {
      authorization,
      ownership: "owned",
      [Symbol.dispose]() {
        if (state.released) return
        state.released = true
        SessionFilesystem.releaseAuthorization(authorization)
      },
    }
  }

  export async function trash(input: {
    projectID: string
    sessionID: string
    path: string
    requestedPath?: string
    root?: string
    authorization?: SessionFilesystem.Authorization
    authorizationOwnership?: "borrowed" | "owned"
    expectedContent?: string | Uint8Array
    now?: number
  }): Promise<Record> {
    using authority = await binding({
      sessionID: input.sessionID,
      path: input.path,
      authorization: input.authorization,
      authorizationOwnership: input.authorizationOwnership,
    })
    const authorization = authority.authorization
    const canonical = authorization?.path ?? (await target(input.path))
    const requested = path.resolve(input.requestedPath ?? input.path)
    const requestedStat = await fs.lstat(requested)
    if (requestedStat.isSymbolicLink()) throw new Error(`Refusing to trash a symbolic link: ${requested}`)
    if ((await target(requested)) !== canonical) throw new Error("Trash path changed after authorization")
    if (canonical === Instance.directory) throw new Error(`Refusing to trash the project root: ${canonical}`)
    if (protectedPath(canonical)) throw new Error(`Refusing to trash recovery data: ${canonical}`)
    const snapshot = await SafeTrashIO.inspect(canonical)
    if (snapshot.kind === "directory" && input.expectedContent !== undefined) {
      throw new Error(`Expected content cannot be supplied for a directory: ${canonical}`)
    }

    const id = `ftr_${crypto.randomUUID()}`
    const now = input.now ?? Date.now()
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
    if (expected && snapshot.sha256 !== expected) {
      throw new Error(`Refusing to delete ${canonical}: the file changed after approval`)
    }
    const home = await owner({ root: input.root ?? authorization?.grantPath, sessionID: input.sessionID }, canonical)
    await hooks.value?.afterAuthorization?.("trash", undefined, authorization)

    using _ = await Lock.write(lock(input.projectID))
    await purgeExpiredUnlocked(input.projectID, now)
    const result = await AuthoritySignal.exclusive(async () => {
      if (authorization) {
        const current = await SessionFilesystem.revalidateAuthorization(authorization)
        if (current.path !== canonical) throw new Error("Trash path changed after authorization")
      }
      const data = await target(Global.Path.data)
      const trusted = await SafeTrashIO.ensureDataEntry(data, segment(input.projectID), id)
      const store = home ? await SafeTrashIO.workspace(home, id) : undefined
      const destination = store?.payload ?? path.join(trusted, "payload")
      const initial = Record.parse({
        id,
        projectID: input.projectID,
        sessionID: input.sessionID,
        originalPath: canonical,
        filename: path.basename(canonical),
        size: snapshot.kind === "file" ? snapshot.size : 0,
        sha256: snapshot.sha256,
        mode: snapshot.mode,
        kind: snapshot.kind,
        store: home ? "workspace" : "data",
        payloadPath: home ? destination : undefined,
        payloadIdentity: snapshot,
        state: "trash",
        trashedAt: now,
        expiresAt: now + RETENTION_MS,
      })
      const moved = { value: undefined as SafeTrashIO.Identity | undefined }
      try {
        await SafeTrashIO.writeRecord(path.join(trusted, "record.json"), encoded(initial))
        if (store) await store.write(encoded(initial))
        moved.value = await SafeTrashIO.move(canonical, destination, snapshot, {
          afterDirectoryVerify: hooks.value?.afterDirectoryVerify,
        })
        const result = Record.parse({ ...initial, payloadIdentity: moved.value })
        await SafeTrashIO.writeRecord(path.join(trusted, "record.json"), encoded(result))
        if (store) await store.write(encoded(result))
        return result
      } catch (cause) {
        if (moved.value) {
          await SafeTrashIO.restore(destination, canonical, moved.value, snapshot.mode).catch((rollback) => {
            throw new AggregateError(
              [cause, rollback],
              `Trash operation failed; recovery payload retained for ${canonical}`,
            )
          })
        }
        if (store) await store.discard().catch(() => undefined)
        await SafeTrashIO.remove(trusted).catch(() => undefined)
        throw cause
      } finally {
        if (store) await store.close().catch(() => undefined)
      }
    })
    await activity(input.projectID)
    return result
  }

  async function validateWorkspaceRecord(record: Record) {
    if (record.store !== "workspace" || !record.payloadPath) return
    const entry = localEntry(record)
    if (!entry) throw new Error(`Invalid workspace trash metadata for ${record.id}`)
    const local = await SafeFileIO.read(path.join(entry, "record.json"))
      .then((value) => Record.parse(JSON.parse(value.bytes.toString("utf8"))))
      .catch(() => undefined)
    if (!local || JSON.stringify(local) !== JSON.stringify(record)) {
      throw new Error(`Workspace trash metadata mismatch for ${record.id}`)
    }
  }

  export async function restore(input: { projectID: string; sessionID: string; id: string }) {
    using _ = await Lock.write(lock(input.projectID))
    const record = await read(input.projectID, input.id)
    if (!record || record.state !== "trash" || !(await available(record))) return
    if (record.expiresAt <= Date.now()) {
      await remove(record)
      return
    }
    using authority = await binding({ sessionID: input.sessionID, path: record.originalPath })
    const authorization = authority.authorization!
    await hooks.value?.afterAuthorization?.("restore", record, authorization)
    const result = await AuthoritySignal.exclusive(async () => {
      const current = await SessionFilesystem.revalidateAuthorization(authorization)
      if (current.path !== record.originalPath) throw new Error("Trash restore path changed after authorization")
      await validateWorkspaceRecord(record)
      const verified = await verifyPayload(record)
      const action =
        record.store === "workspace"
          ? SafeTrashIO.restore(verified.source, record.originalPath, verified.current, record.mode, {
              afterDirectoryVerify: hooks.value?.afterDirectoryVerify,
            })
          : SafeTrashIO.copy(verified.source, record.originalPath, verified.current, record.mode, {
              afterDirectoryVerify: hooks.value?.afterDirectoryVerify,
            })
      await action.catch((cause: Error) => {
        if (cause.message.startsWith("Refusing to overwrite")) {
          throw new HTTPException(409, { message: `Refusing to overwrite ${record.originalPath}` })
        }
        throw cause
      })
      const result = Record.parse({ ...record, state: "restored", restoredAt: Date.now() })
      await writeRecord(result)
      const entry = localEntry(record)
      if (entry) await SafeTrashIO.remove(entry)
      return result
    })
    await activity(input.projectID)
    return result
  }

  export async function purge(input: { projectID: string; sessionID: string; id: string }) {
    using _ = await Lock.write(lock(input.projectID))
    const record = await read(input.projectID, input.id)
    if (!record || record.state !== "trash" || !(await available(record))) return
    using authority = await binding({ sessionID: input.sessionID, path: record.originalPath })
    const authorization = authority.authorization!
    await hooks.value?.afterAuthorization?.("purge", record, authorization)
    const result = await AuthoritySignal.exclusive(async () => {
      const current = await SessionFilesystem.revalidateAuthorization(authorization)
      if (current.path !== record.originalPath) throw new Error("Trash purge path changed after authorization")
      await validateWorkspaceRecord(record)
      const verified = await verifyPayload(record)
      await remove(record, { verified: verified.current })
      return record
    })
    await activity(input.projectID)
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
    const verified = await verifyPayload(stored)
    const action =
      stored.store === "workspace"
        ? SafeTrashIO.restore(verified.source, stored.originalPath, verified.current, stored.mode)
        : SafeTrashIO.copy(verified.source, stored.originalPath, verified.current, stored.mode)
    await action.catch((cause: Error) => {
      if (cause.message.startsWith("Refusing to overwrite")) {
        throw new Error(`Refusing to overwrite ${stored.originalPath}; recovery payload retained at ${verified.source}`)
      }
      throw cause
    })
    await remove(stored, { verified: verified.current })
  }

  export async function purgeExpired(projectID: string, now = Date.now()) {
    using _ = await Lock.write(lock(projectID))
    return purgeExpiredUnlocked(projectID, now)
  }
}

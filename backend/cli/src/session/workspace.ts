import { Global } from "@/global"
import { Instance } from "@/project/instance"
import { Storage } from "@/storage/storage"
import { Cleanup } from "@/util/cleanup"
import { Lock } from "@/util/lock"
import crypto from "crypto"
import fs from "fs/promises"
import path from "path"
import z from "zod"

export namespace SessionWorkspace {
  export const Mode = z.enum(["isolated", "legacy"])
  export type Mode = z.infer<typeof Mode>

  export const State = z.enum(["active", "stopped", "trash"])
  export type State = z.infer<typeof State>

  export const Info = z.object({
    schemaVersion: z.literal(1),
    workspaceID: z.string().startsWith("wsp_"),
    projectID: z.string(),
    sessionID: z.string(),
    scratchRoot: z.string(),
    mode: Mode,
    state: State,
    grantRevision: z.number().int().positive(),
    createdAt: z.number(),
    lastUsedAt: z.number(),
    trashedAt: z.number().optional(),
    trashRoot: z.string().optional(),
    size: z.number().int().nonnegative(),
  })
  export type Info = z.infer<typeof Info>

  const DAY = 24 * 60 * 60 * 1000
  const TRASH_AGE = 7 * DAY
  const ORPHAN_AGE = DAY

  function segment(value: string) {
    if (value === "." || value === ".." || path.basename(value) !== value) {
      throw new Error(`Invalid workspace path segment: ${value}`)
    }
    return value
  }

  function key(sessionID: string) {
    return ["session_workspace", Instance.project.id, sessionID]
  }

  function trashKey(info: Info) {
    return ["session_workspace_trash", info.projectID, info.sessionID, info.workspaceID]
  }

  function trashPrefix(sessionID?: string) {
    return ["session_workspace_trash", Instance.project.id, ...(sessionID ? [sessionID] : [])]
  }

  export function root(projectID = Instance.project.id) {
    return path.join(Global.Path.data, "workspaces", segment(projectID))
  }

  function trashRoot(projectID: string, sessionID: string, workspaceID: string) {
    return path.join(Global.Path.data, "workspace-trash", segment(projectID), segment(sessionID), segment(workspaceID))
  }

  async function size(root: string): Promise<number> {
    const files = async function* () {
      const directories = [root]
      while (directories.length) {
        const current = directories.pop()
        if (!current) continue
        const directory = await fs.opendir(current).catch(() => undefined)
        if (!directory) continue
        for await (const entry of directory) {
          const target = path.join(current, entry.name)
          if (entry.isDirectory()) {
            directories.push(target)
            continue
          }
          if (entry.isFile()) yield target
        }
      }
    }
    const total = { value: 0 }
    await Cleanup.each(files(), async (target) => {
      const bytes = await fs.stat(target).then(
        (stat) => stat.size,
        () => 0,
      )
      total.value += bytes
    })
    return total.value
  }

  async function read(sessionID: string) {
    return Storage.read<Info>(key(sessionID)).then(Info.parse)
  }

  function owner(info: Info, sessionID = info.sessionID) {
    if (info.projectID === Instance.project.id && info.sessionID === sessionID) return info
    throw new Error(`Workspace ${info.workspaceID} does not belong to project ${Instance.project.id}`)
  }

  export async function get(sessionID: string) {
    return owner(await read(sessionID), sessionID)
  }

  export async function ensure(input: {
    sessionID: string
    directory: string
    mode: Mode
    scratchRoot?: string
    grantRevision?: number
  }) {
    const existing = await read(input.sessionID).catch((error) => {
      if (Storage.NotFoundError.isInstance(error)) return
      throw error
    })
    if (existing && existing.state !== "trash") return owner(existing, input.sessionID)
    return create(input)
  }

  export async function create(input: {
    sessionID: string
    directory: string
    mode: Mode
    scratchRoot?: string
    grantRevision?: number
  }) {
    using _ = await Lock.write(`session-workspace:${Instance.project.id}:${input.sessionID}`)
    const existing = await read(input.sessionID).catch((error) => {
      if (Storage.NotFoundError.isInstance(error)) return
      throw error
    })
    if (existing && existing.state !== "trash") return owner(existing, input.sessionID)
    if (existing) {
      // An explicitly recreated historical session ID owns a new scratch
      // incarnation. Archive the deleted incarnation by value before replacing
      // the active pointer, so its recovery copy survives for the normal trash
      // retention window without being mounted into the new session.
      await Storage.write(trashKey(owner(existing, input.sessionID)), existing)
    }

    const target =
      input.scratchRoot ?? (input.mode === "isolated" ? path.join(root(), segment(input.sessionID)) : input.directory)
    await fs.mkdir(target, { recursive: true })
    const scratchRoot = await fs.realpath(target)
    const now = Date.now()
    const info: Info = {
      schemaVersion: 1,
      workspaceID: `wsp_${crypto.randomUUID()}`,
      projectID: Instance.project.id,
      sessionID: input.sessionID,
      scratchRoot,
      mode: input.mode,
      state: "active",
      grantRevision: input.grantRevision ?? 1,
      createdAt: now,
      lastUsedAt: now,
      size: await size(scratchRoot),
    }
    await Storage.write(key(input.sessionID), info)
    return info
  }

  export async function touch(sessionID: string) {
    const info = await get(sessionID)
    if (info.state !== "active" || Date.now() - info.lastUsedAt < 60_000) return info
    return Storage.update<Info>(key(sessionID), (draft) => {
      owner(Info.parse(draft))
      draft.lastUsedAt = Date.now()
    })
  }

  export async function revise(sessionID: string, revision: number) {
    const info = await get(sessionID)
    if (info.grantRevision === revision) return info
    return Storage.update<Info>(key(sessionID), (draft) => {
      owner(Info.parse(draft))
      draft.grantRevision = revision
      draft.lastUsedAt = Date.now()
    })
  }

  export async function stop(sessionID: string) {
    const info = await get(sessionID)
    if (info.state !== "active") return info
    return Storage.update<Info>(key(sessionID), (draft) => {
      owner(Info.parse(draft))
      draft.state = "stopped"
      draft.lastUsedAt = Date.now()
      draft.size = info.mode === "isolated" ? info.size : 0
    })
  }

  export async function trash(sessionID: string) {
    using _ = await Lock.write(`session-workspace:${Instance.project.id}:${sessionID}`)
    const info = await get(sessionID)
    if (info.state === "trash") return info
    const now = Date.now()
    const destination = info.mode === "isolated" ? trashRoot(info.projectID, sessionID, info.workspaceID) : undefined
    if (destination) {
      await fs.mkdir(path.dirname(destination), { recursive: true })
      const source = await fs.stat(info.scratchRoot).then(
        () => true,
        () => false,
      )
      const target = await fs.stat(destination).then(
        () => true,
        () => false,
      )
      if (source && target) throw new Error(`Workspace trash destination already exists: ${destination}`)
      if (source) await fs.rename(info.scratchRoot, destination)
    }
    const total = destination ? await size(destination) : 0
    return Storage.update<Info>(key(sessionID), (draft) => {
      owner(Info.parse(draft))
      draft.state = "trash"
      draft.trashedAt = now
      draft.lastUsedAt = now
      draft.trashRoot = destination
      draft.size = total
    })
  }

  export async function restore(sessionID: string) {
    using _ = await Lock.write(`session-workspace:${Instance.project.id}:${sessionID}`)
    const info = await get(sessionID)
    if (info.state === "active") return info
    if (info.mode === "isolated" && info.trashRoot) {
      const source = await fs.stat(info.trashRoot).then(
        () => true,
        () => false,
      )
      const target = await fs.stat(info.scratchRoot).then(
        () => true,
        () => false,
      )
      if (source && target) throw new Error(`Workspace restore destination already exists: ${info.scratchRoot}`)
      if (source) {
        await fs.mkdir(path.dirname(info.scratchRoot), { recursive: true })
        await fs.rename(info.trashRoot, info.scratchRoot)
      }
    }
    return Storage.update<Info>(key(sessionID), (draft) => {
      owner(Info.parse(draft))
      draft.state = "active"
      draft.trashedAt = undefined
      draft.trashRoot = undefined
      draft.lastUsedAt = Date.now()
    })
  }

  export async function purge(sessionID: string) {
    using _ = await Lock.write(`session-workspace:${Instance.project.id}:${sessionID}`)
    const info = await get(sessionID)
    if (info.state !== "trash") throw new Error(`Workspace ${info.workspaceID} must be trashed before purge`)
    if (info.trashRoot) await Cleanup.remove(info.trashRoot)
    await Storage.remove(key(sessionID))
  }

  /** Recovery copies superseded by an explicit same-ID session recreation.
   * These are never mounted implicitly into the replacement session. */
  export async function listTrash(sessionID: string) {
    const paths = await Storage.list(trashPrefix(sessionID))
    const archived = await Cleanup.map(paths, (item) =>
      Storage.read<unknown>(item)
        .then((value) => Info.safeParse(value))
        .then((result) => (result.success ? result.data : undefined))
        .catch(() => undefined),
    )
    const current = await read(sessionID).catch((error) => {
      if (Storage.NotFoundError.isInstance(error)) return
      throw error
    })
    return [...archived, current?.state === "trash" ? current : undefined]
      .filter((info): info is Info => Boolean(info))
      .toSorted((left, right) => (right.trashedAt ?? 0) - (left.trashedAt ?? 0))
  }

  export async function sweep(now = Date.now()) {
    const keys = await Storage.list(["session_workspace", Instance.project.id]).catch(() => [])
    for (const item of keys) {
      const info = Info.parse(await Storage.read<Info>(item))
      if (info.state === "trash" && info.trashedAt && now - info.trashedAt >= TRASH_AGE) {
        await purge(info.sessionID)
        continue
      }
      if (info.state !== "active" || now - info.lastUsedAt < ORPHAN_AGE) continue
      const session = await Storage.read(["session", Instance.project.id, info.sessionID]).catch((error) => {
        if (Storage.NotFoundError.isInstance(error)) return
        throw error
      })
      if (!session) await trash(info.sessionID)
    }

    const archived = await Storage.list(trashPrefix()).catch(() => [])
    for (const item of archived) {
      const parsed = await Storage.read<unknown>(item)
        .then((value) => Info.safeParse(value))
        .catch(() => undefined)
      if (!parsed?.success) continue
      const info = parsed.data
      if (info.state !== "trash" || !info.trashedAt || now - info.trashedAt < TRASH_AGE) continue
      if (info.trashRoot) await Cleanup.remove(info.trashRoot)
      await Storage.remove(item)
    }

    const entries = await fs.opendir(root()).catch(() => undefined)
    if (entries) {
      for await (const entry of entries) {
        if (!entry.isDirectory()) continue
        const sessionID = entry.name
        const session = await Storage.read(["session", Instance.project.id, sessionID]).catch((error) => {
          if (Storage.NotFoundError.isInstance(error)) return
          throw error
        })
        if (session) continue
        const record = await read(sessionID).catch((error) => {
          if (Storage.NotFoundError.isInstance(error)) return
          throw error
        })
        if (record) continue
        const target = path.join(root(), sessionID)
        const stat = await fs.stat(target).catch(() => undefined)
        if (!stat || now - stat.mtimeMs < ORPHAN_AGE) continue
        await Cleanup.remove(target)
      }
    }
  }
}

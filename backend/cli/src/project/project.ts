import z from "zod"
import fs from "fs/promises"
import crypto from "crypto"
import { Filesystem } from "../util/filesystem"
import path from "path"
import { $ } from "bun"
import { Storage } from "../storage/storage"
import { Log } from "../util/log"
import { Flag } from "@/flag/flag"
import { Session } from "../session"
import { work } from "../util/queue"
import { fn } from "@synsci/util/fn"
import { BusEvent } from "@/bus/bus-event"
import { iife } from "@/util/iife"
import { GlobalBus } from "@/bus/global"
import { existsSync, realpathSync } from "fs"
import { NamedError } from "@synsci/util/error"
import { Lock } from "@/util/lock"
import type { SessionFilesystem } from "@/session/filesystem"
import type { SessionWorkspace } from "@/session/workspace"
import { FileLease } from "@/util/file-lease"
import { Global } from "@/global"

export namespace Project {
  const log = Log.create({ service: "project" })
  const Alias = z.object({
    id: z.string(),
    projectID: z.string(),
    time: z.object({
      created: z.number(),
    }),
  })

  export const UnknownError = NamedError.create(
    "ProjectUnknownError",
    z.object({
      projectID: z.string(),
    }),
  )

  export const StaleError = NamedError.create(
    "ProjectStaleError",
    z.object({
      projectID: z.string(),
      reason: z.enum(["missing_project", "missing_directory"]),
      directory: z.string().optional(),
    }),
  )

  export const MismatchError = NamedError.create(
    "ProjectMismatchError",
    z.object({
      projectID: z.string(),
      directory: z.string(),
    }),
  )

  export const DirectoryError = NamedError.create(
    "ProjectDirectoryError",
    z.object({
      directory: z.string(),
    }),
  )

  export const Info = z
    .object({
      id: z.string(),
      worktree: z.string(),
      vcs: z.literal("git").optional(),
      name: z.string().optional(),
      icon: z
        .object({
          url: z.string().optional(),
          override: z.string().optional(),
          color: z.string().optional(),
        })
        .optional(),
      commands: z
        .object({
          start: z.string().optional().describe("Startup script to run when creating a new workspace (worktree)"),
        })
        .optional(),
      time: z.object({
        created: z.number(),
        updated: z.number(),
        initialized: z.number().optional(),
        archived: z.number().optional(),
      }),
      sandboxes: z.array(z.string()),
    })
    .meta({
      ref: "Project",
    })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define("project.updated", Info),
  }

  export function canonicalize(input: string) {
    const resolved = path.resolve(input)
    let real = resolved
    try {
      real = realpathSync(resolved)
    } catch {
      // path may not exist yet — fall back to the resolved form
    }
    if (real.length > 1 && real.endsWith(path.sep)) real = real.slice(0, -1)
    return real
  }

  function createID() {
    return `prj_${crypto.randomUUID().replaceAll("-", "")}`
  }

  function contains(root: string, target: string) {
    return Filesystem.contains(root, target)
  }

  async function records(worktree: string) {
    const keys = await Storage.list(["project"]).catch(() => [])
    const projects = await Promise.all(
      keys.map(async (key) => ({
        id: key[key.length - 1],
        project: await Storage.read<Info>(key).catch(() => undefined),
      })),
    )
    return projects.filter((record): record is { id: string; project: Info } => {
      const project = record.project
      if (!project?.worktree) return false
      return canonicalize(project.worktree) === worktree
    })
  }

  async function alias(id: string, projectID: string) {
    if (id === projectID) return
    const existing = await Storage.read<z.infer<typeof Alias>>(["project_alias", id]).catch(() => undefined)
    if (existing?.projectID === projectID) return
    await Storage.write<z.infer<typeof Alias>>(["project_alias", id], {
      id,
      projectID,
      time: {
        created: existing?.time.created ?? Date.now(),
      },
    })
  }

  function merge(current: Info, fallback: Info): Info {
    return {
      ...fallback,
      ...current,
      name: current.name ?? fallback.name,
      icon:
        current.icon || fallback.icon
          ? {
              ...fallback.icon,
              ...current.icon,
            }
          : undefined,
      commands:
        current.commands || fallback.commands
          ? {
              ...fallback.commands,
              ...current.commands,
            }
          : undefined,
      time: {
        ...fallback.time,
        ...current.time,
        initialized: current.time.initialized ?? fallback.time.initialized,
      },
      sandboxes: [...new Set([...(current.sandboxes ?? []), ...(fallback.sandboxes ?? [])])],
    }
  }

  /**
   * Resolve an opaque project selector to a canonical server-owned directory.
   * A caller may include a legacy directory while migrating, but it must remain
   * inside the selected project's recorded roots.
   */
  /**
   * Only a genuinely absent record means the project is gone. Any other read
   * failure — a torn file from a concurrent writer, a transient fs error — must
   * propagate, because reporting it as 410 tells the caller to stop asking
   * about a project that is in fact fine, and the client empties the surfaces
   * that depend on it.
   */
  function absent(error: unknown) {
    if (Storage.NotFoundError.isInstance(error)) return undefined
    throw error
  }

  export async function resolve(projectID: string, directory?: string) {
    const direct = await Storage.read<Info>(["project", projectID]).catch(absent)
    const link = await Storage.read<z.infer<typeof Alias>>(["project_alias", projectID]).catch(absent)
    if (!direct && !link) throw new UnknownError({ projectID })

    const linked = link ? await Storage.read<Info>(["project", link.projectID]).catch(absent) : undefined
    const redirected = !!linked && (!direct || !projectID.startsWith("prj_"))
    const project = redirected ? linked : (direct ?? linked)
    if (!project) {
      throw new StaleError({
        projectID,
        reason: "missing_project",
      })
    }

    const worktree = canonicalize(project.worktree)
    const roots = [worktree, ...(project.sandboxes ?? []).map(canonicalize)]
    const target = directory ? canonicalize(directory) : worktree
    if (!roots.some((root) => contains(root, target))) {
      throw new MismatchError({
        projectID,
        directory: target,
      })
    }

    const stat = await fs.stat(target).catch(() => undefined)
    if (!stat?.isDirectory()) {
      throw new StaleError({
        projectID,
        reason: "missing_directory",
        directory: target,
      })
    }

    return {
      project,
      directory: target,
      alias: redirected ? link?.id : undefined,
    }
  }

  /**
   * Guard a caller-supplied root before it can mint a project. Anything that is
   * not an absolute path gets resolved against the server's cwd, which turned
   * junk from a stale deep link into a real-looking folder under the user's
   * home and left a phantom project on their home list.
   */
  export async function assertDirectory(input: string) {
    if (!path.isAbsolute(input)) throw new DirectoryError({ directory: input })
    const stat = await fs.stat(input).catch(() => undefined)
    if (!stat?.isDirectory()) throw new DirectoryError({ directory: input })
  }

  export async function fromDirectory(input: string) {
    const directory = canonicalize(input)
    log.info("fromDirectory", { directory })

    const { sandbox, worktree, vcs } = await iife(async () => {
      // Match Git's standard discovery ceiling. This is important for
      // intentionally isolated folders nested below an unrelated checkout
      // (including repo-contained test/runtime workspaces): they must not be
      // silently adopted as sandboxes of the outer repository.
      const ceiling = (process.env.GIT_CEILING_DIRECTORIES ?? "")
        .split(path.delimiter)
        .filter((value) => path.isAbsolute(value))
        .map(canonicalize)
        .filter((value) => Filesystem.contains(value, directory))
        .toSorted((a, b) => b.length - a.length)[0]
      const matches = Filesystem.up({ targets: [".git"], start: directory, ...(ceiling ? { stop: ceiling } : {}) })
      const git = await matches.next().then((x) => x.value)
      await matches.return()

      if (git) {
        const gitBinary = Bun.which("git")
        let sandbox = path.dirname(git)

        if (!gitBinary) {
          return { sandbox, worktree: sandbox, vcs: Info.shape.vcs.parse(Flag.OPENSCIENCE_FAKE_VCS) }
        }

        const top = await $`git rev-parse --show-toplevel`
          .quiet()
          .nothrow()
          .cwd(sandbox)
          .text()
          .then((x) => canonicalize(path.resolve(sandbox, x.trim())))
          .catch(() => undefined)

        if (!top) {
          return { sandbox, worktree: sandbox, vcs: Info.shape.vcs.parse(Flag.OPENSCIENCE_FAKE_VCS) }
        }

        sandbox = top

        const worktree = await $`git rev-parse --git-common-dir`
          .quiet()
          .nothrow()
          .cwd(sandbox)
          .text()
          .then((x) => {
            const dirname = path.dirname(x.trim())
            if (dirname === ".") return sandbox
            return canonicalize(dirname)
          })
          .catch(() => undefined)

        if (!worktree) {
          return { sandbox, worktree: sandbox, vcs: Info.shape.vcs.parse(Flag.OPENSCIENCE_FAKE_VCS) }
        }

        return { sandbox, worktree, vcs: "git" as const }
      }

      // No `.git` anywhere up the tree — treat the opened directory itself
      // as the project root rather than collapsing every non-git folder to "/".
      return {
        sandbox: directory,
        worktree: directory,
        vcs: Info.shape.vcs.parse(Flag.OPENSCIENCE_FAKE_VCS),
      }
    })

    const result = await iife(async () => {
      // Always take the process-local lock before the durable lease. The pair
      // covers only identity selection and legacy adoption: two server
      // processes cannot mint competing ids and then delete each other's live
      // session records, while unrelated icon discovery runs after release.
      using local = await Lock.write(`project:${worktree}`)
      const digest = crypto.createHash("sha256").update(worktree).digest("hex")
      await using durable = await FileLease.acquire(
        path.join(Global.Path.data, "project-leases", `${digest}.lock`),
        120_000,
      )

      return await durable.during(async () => {
        const found = await records(worktree)
        const opaque = found.find((record) => record.id.startsWith("prj_"))
        const source = opaque ?? found[0]
        const id = opaque?.id ?? createID()
        const current = found
          .filter((record) => record.id !== source?.id)
          .reduce(
            (result, record) => merge(result, record.project),
            source
              ? {
                  ...source.project,
                  id,
                  sandboxes: [...(source.project.sandboxes ?? [])],
                }
              : {
                  id,
                  worktree,
                  vcs: vcs as Info["vcs"],
                  sandboxes: [],
                  time: {
                    created: Date.now(),
                    updated: Date.now(),
                  },
                },
          )

        const result: Info = {
          ...current,
          worktree,
          vcs: vcs as Info["vcs"],
          time: {
            ...current.time,
            updated: Date.now(),
          },
        }
        if (sandbox !== result.worktree && !result.sandboxes.includes(sandbox)) result.sandboxes.push(sandbox)
        result.sandboxes = [
          ...new Set(
            result.sandboxes.filter(
              (directory) => canonicalize(directory) !== result.worktree && existsSync(directory),
            ),
          ),
        ]
        await Storage.write<Info>(["project", id], result)
        await adoptLegacy(id, worktree, found)
        return result
      })
    })

    if (Flag.OPENSCIENCE_EXPERIMENTAL_ICON_DISCOVERY) discover(result)
    GlobalBus.emit("event", {
      payload: {
        type: Event.Updated.type,
        properties: result,
      },
    })
    return { project: result, sandbox }
  }

  export async function discover(input: Info) {
    if (input.vcs !== "git") return
    if (input.icon?.override) return
    if (input.icon?.url) return
    const glob = new Bun.Glob("**/{favicon}.{ico,png,svg,jpg,jpeg,webp}")
    const matches = await Array.fromAsync(
      glob.scan({
        cwd: input.worktree,
        absolute: true,
        onlyFiles: true,
        followSymlinks: false,
        dot: false,
      }),
    )
    const shortest = matches.sort((a, b) => a.length - b.length)[0]
    if (!shortest) return
    const file = Bun.file(shortest)
    const buffer = await file.arrayBuffer()
    const base64 = Buffer.from(buffer).toString("base64")
    const { detectImageMime } = await import("@/util/image")
    const mime = detectImageMime(new Uint8Array(buffer)) ?? (file.type || "image/png")
    const url = `data:${mime};base64,${base64}`
    await update({
      projectID: input.id,
      icon: {
        url,
      },
    })
    return
  }

  // Fold any duplicate records for this folder into the canonical opaque id. Runs once,
  // the first time a folder is opened under the project-identity scheme:
  //   1. the shared `global` bucket — adopt only sessions whose directory matches
  //   2. legacy per-directory project records (old git-root-commit ids, `ng-…` hashes)
  //   3. duplicate opaque records pointing at this exact canonical worktree
  // Adopt all state before dropping a now-duplicate project record.
  async function adoptLegacy(newProjectID: string, worktree: string, found: Awaited<ReturnType<typeof records>>) {
    await moveSessions(
      "global",
      newProjectID,
      (session) => !session.directory || canonicalize(session.directory) === worktree,
    )
    await moveFilesystemBucket(
      "global",
      newProjectID,
      (state) => !state.directory || canonicalize(state.directory) === worktree,
    )

    const legacy = (projectID: string) =>
      projectID !== newProjectID && projectID !== "global" && !projectID.startsWith("prj_")
    const old = new Set([
      ...found.flatMap((record) => [record.id, record.project.id]).filter(legacy),
      ...found
        .map((record) => record.id)
        .filter((projectID) => projectID !== newProjectID && projectID.startsWith("prj_")),
    ])
    const keys = await Storage.list(["project_alias"]).catch(() => [])
    const links = (
      await Promise.all(
        keys.map(async (key) => ({
          id: key[key.length - 1],
          link: await Storage.read<z.infer<typeof Alias>>(key).catch(() => undefined),
        })),
      )
    ).filter((record): record is { id: string; link: z.infer<typeof Alias> } => !!record.link)

    // Include aliases which already point at the opaque project. This recovers
    // users who opened the folder during a partial migration: their session
    // may already live under the opaque id while its filesystem grants remain
    // stranded in the removed legacy bucket.
    const targets = new Set([newProjectID, ...old])
    while (true) {
      const stale = links.filter((record) => targets.has(record.link.projectID))
      if (stale.length === 0) break
      const size = old.size
      for (const record of stale) {
        for (const projectID of [record.id, record.link.id]) {
          if (!legacy(projectID)) continue
          old.add(projectID)
          targets.add(projectID)
        }
      }
      if (old.size === size) break
    }
    for (const projectID of old) {
      await moveSessions(projectID, newProjectID, () => true)
      await moveFilesystemBucket(projectID, newProjectID, () => true)
      await alias(projectID, newProjectID)
    }

    for (const record of found) {
      if (record.id === newProjectID || record.id === "global") continue
      await Storage.remove(["project", record.id])
    }
  }

  async function moveSessions(fromBucket: string, newProjectID: string, keep: (session: Session.Info) => boolean) {
    const sessions = await Storage.list(["session", fromBucket]).catch(() => [])
    if (sessions.length === 0) return

    log.info("migrating sessions", { from: fromBucket, to: newProjectID, count: sessions.length })

    await work(10, sessions, async (key) => {
      const sessionID = key[key.length - 1]
      const session = await Storage.read<Session.Info>(key)
      if (!keep(session)) return
      const existing = await Storage.read<Session.Info>(["session", newProjectID, sessionID]).catch((error) => {
        if (error instanceof Storage.NotFoundError) return
        throw error
      })
      if (!existing) {
        await Storage.write(["session", newProjectID, sessionID], {
          ...session,
          projectID: newProjectID,
        })
      }
      await moveFilesystem(fromBucket, newProjectID, sessionID)
      await moveWorkspace(fromBucket, newProjectID, sessionID)
      await moveKernels(fromBucket, newProjectID, sessionID)
      await Storage.remove(key)
    })
  }

  async function moveKernels(fromBucket: string, newProjectID: string, sessionID: string) {
    const paths = await Storage.list(["kernel_registry", fromBucket, sessionID]).catch(() => [])
    await work(10, paths, async (source) => {
      const raw = await Storage.read<unknown>(source)
      const parsed = z
        .object({
          identity: z.object({
            projectID: z.string(),
            sessionID: z.string(),
            name: z.string(),
            language: z.string(),
          }),
        })
        .passthrough()
        .safeParse(raw)
      if (!parsed.success) return
      const identity = {
        ...parsed.data.identity,
        projectID: newProjectID,
        sessionID,
      }
      const id = `kernel-${Bun.hash(
        `${identity.projectID}\0${identity.sessionID}\0${identity.name}\0${identity.language}`,
      ).toString(36)}`
      const target = ["kernel_registry", newProjectID, sessionID, id]
      const existing = await Storage.read<unknown>(target).catch((error) => {
        if (Storage.NotFoundError.isInstance(error)) return
        throw error
      })
      if (!existing) {
        await Storage.write(target, {
          ...parsed.data,
          identity,
        })
      }
      await Storage.remove(source)
    })
  }

  async function moveWorkspace(fromBucket: string, newProjectID: string, sessionID: string) {
    const source = ["session_workspace", fromBucket, sessionID]
    const workspace = await Storage.read<SessionWorkspace.Info>(source).catch((error) => {
      if (Storage.NotFoundError.isInstance(error)) return
      throw error
    })
    if (!workspace) return

    const target = ["session_workspace", newProjectID, sessionID]
    const existing = await Storage.read<SessionWorkspace.Info>(target).catch((error) => {
      if (Storage.NotFoundError.isInstance(error)) return
      throw error
    })
    if (!existing) {
      await Storage.write<SessionWorkspace.Info>(target, {
        ...workspace,
        projectID: newProjectID,
      })
    }
    await Storage.remove(source)
  }

  async function moveFilesystem(fromBucket: string, newProjectID: string, sessionID: string) {
    const source = ["session_filesystem", fromBucket, sessionID]
    const legacy = await Storage.read<SessionFilesystem.State>(source).catch((error) => {
      if (Storage.NotFoundError.isInstance(error)) return
      throw error
    })
    if (!legacy) return

    const target = ["session_filesystem", newProjectID, sessionID]
    const existing = await Storage.read<SessionFilesystem.State>(target).catch((error) => {
      if (Storage.NotFoundError.isInstance(error)) return
      throw error
    })
    const grants = existing
      ? [
          ...existing.grants,
          ...legacy.grants.filter((grant) => !existing.grants.some((current) => current.id === grant.id)),
        ]
      : legacy.grants
    const changed = !!existing && grants.length !== existing.grants.length
    await Storage.write<SessionFilesystem.State>(target, {
      ...(existing ?? legacy),
      sessionID,
      projectID: newProjectID,
      grants,
      revision: existing ? Math.max(existing.revision, legacy.revision) + (changed ? 1 : 0) : legacy.revision,
    })
    await Storage.remove(source)
  }

  async function moveFilesystemBucket(
    fromBucket: string,
    newProjectID: string,
    keep: (state: SessionFilesystem.State) => boolean,
  ) {
    const records = await Storage.list(["session_filesystem", fromBucket]).catch(() => [])
    await work(10, records, async (key) => {
      const state = await Storage.read<SessionFilesystem.State>(key)
      if (!keep(state)) return
      const session = await Storage.read<Session.Info>(["session", newProjectID, state.sessionID]).catch((error) => {
        if (Storage.NotFoundError.isInstance(error)) return
        throw error
      })
      if (!session) return
      await moveFilesystem(fromBucket, newProjectID, state.sessionID)
    })
  }

  export async function setInitialized(projectID: string) {
    await Storage.update<Info>(["project", projectID], (draft) => {
      draft.time.initialized = Date.now()
    })
  }

  export async function list() {
    const keys = await Storage.list(["project"])
    const projects = await Promise.all(keys.map((x) => Storage.read<Info>(x)))
    return projects.map((project) => ({
      ...project,
      sandboxes: project.sandboxes?.filter((x) => existsSync(x)),
    }))
  }

  export const update = fn(
    z.object({
      projectID: z.string(),
      name: z.string().optional(),
      icon: Info.shape.icon.optional(),
      commands: Info.shape.commands.optional(),
      archived: z.boolean().optional(),
    }),
    async (input) => {
      const result = await Storage.update<Info>(["project", input.projectID], (draft) => {
        if (input.name !== undefined) draft.name = input.name
        if (input.icon !== undefined) {
          draft.icon = {
            ...draft.icon,
          }
          if (input.icon.url !== undefined) draft.icon.url = input.icon.url
          if (input.icon.override !== undefined) draft.icon.override = input.icon.override || undefined
          if (input.icon.color !== undefined) draft.icon.color = input.icon.color
        }

        if (input.commands?.start !== undefined) {
          const start = input.commands.start || undefined
          draft.commands = {
            ...(draft.commands ?? {}),
          }
          draft.commands.start = start
          if (!draft.commands.start) draft.commands = undefined
        }

        if (input.archived !== undefined) {
          draft.time.archived = input.archived ? Date.now() : undefined
        }

        draft.time.updated = Date.now()
      })
      GlobalBus.emit("event", {
        payload: {
          type: Event.Updated.type,
          properties: result,
        },
      })
      return result
    },
  )

  export async function sandboxes(projectID: string) {
    const project = await Storage.read<Info>(["project", projectID]).catch(() => undefined)
    if (!project?.sandboxes) return []
    const valid: string[] = []
    for (const dir of project.sandboxes) {
      const stat = await fs.stat(dir).catch(() => undefined)
      if (stat?.isDirectory()) valid.push(dir)
    }
    return valid
  }

  export async function addSandbox(projectID: string, directory: string) {
    const result = await Storage.update<Info>(["project", projectID], (draft) => {
      const sandboxes = draft.sandboxes ?? []
      if (!sandboxes.includes(directory)) sandboxes.push(directory)
      draft.sandboxes = sandboxes
      draft.time.updated = Date.now()
    })
    GlobalBus.emit("event", {
      payload: {
        type: Event.Updated.type,
        properties: result,
      },
    })
    return result
  }

  export async function removeSandbox(projectID: string, directory: string) {
    const result = await Storage.update<Info>(["project", projectID], (draft) => {
      const sandboxes = draft.sandboxes ?? []
      draft.sandboxes = sandboxes.filter((sandbox) => sandbox !== directory)
      draft.time.updated = Date.now()
    })
    GlobalBus.emit("event", {
      payload: {
        type: Event.Updated.type,
        properties: result,
      },
    })
    return result
  }
}

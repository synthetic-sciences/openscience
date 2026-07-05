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

export namespace Project {
  const log = Log.create({ service: "project" })
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

  function idForPath(worktree: string) {
    return crypto.createHash("sha256").update(worktree).digest("hex").slice(0, 40)
  }

  export async function fromDirectory(input: string) {
    const directory = canonicalize(input)
    log.info("fromDirectory", { directory })

    const { sandbox, worktree, vcs } = await iife(async () => {
      const matches = Filesystem.up({ targets: [".git"], start: directory })
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

    // Identity is a pure function of the canonical project-root path — never of git
    // status. The same folder keeps one id across spelling variants and across a later
    // `git init` (the canonical worktree is unchanged, so the id is too).
    const id = idForPath(worktree)

    let existing = await Storage.read<Info>(["project", id]).catch(() => undefined)
    if (!existing) {
      await adoptLegacy(id, worktree)
      existing = await Storage.read<Info>(["project", id]).catch(() => undefined)
    }
    if (!existing) {
      existing = {
        id,
        worktree,
        vcs: vcs as Info["vcs"],
        sandboxes: [],
        time: {
          created: Date.now(),
          updated: Date.now(),
        },
      }
    }

    // migrate old projects before sandboxes
    if (!existing.sandboxes) existing.sandboxes = []

    if (Flag.OPENSCIENCE_EXPERIMENTAL_ICON_DISCOVERY) discover(existing)

    const result: Info = {
      ...existing,
      worktree,
      vcs: vcs as Info["vcs"],
      time: {
        ...existing.time,
        updated: Date.now(),
      },
    }
    if (sandbox !== result.worktree && !result.sandboxes.includes(sandbox)) result.sandboxes.push(sandbox)
    result.sandboxes = result.sandboxes.filter((x) => existsSync(x))
    await Storage.write<Info>(["project", id], result)
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

  // Fold any legacy records for this folder into the canonical path id. Runs once, the
  // first time a folder is opened under the path-identity scheme:
  //   1. the shared `global` bucket — adopt only sessions whose directory matches
  //   2. legacy per-directory project records (old git-root-commit ids, `ng-…` hashes)
  //      pointing at the same canonical worktree — adopt all their sessions, then drop
  //      the now-duplicate project record
  async function adoptLegacy(newProjectID: string, worktree: string) {
    await moveSessions(
      "global",
      newProjectID,
      (session) => !session.directory || canonicalize(session.directory) === worktree,
    )

    const keys = await Storage.list(["project"]).catch(() => [])
    for (const key of keys) {
      const projectID = key[key.length - 1]
      if (projectID === newProjectID || projectID === "global") continue
      const record = await Storage.read<Info>(key).catch(() => undefined)
      if (!record?.worktree || canonicalize(record.worktree) !== worktree) continue
      await moveSessions(projectID, newProjectID, () => true)
      await Storage.remove(["project", projectID]).catch(() => undefined)
    }
  }

  async function moveSessions(fromBucket: string, newProjectID: string, keep: (session: Session.Info) => boolean) {
    const sessions = await Storage.list(["session", fromBucket]).catch(() => [])
    if (sessions.length === 0) return

    log.info("migrating sessions", { from: fromBucket, to: newProjectID, count: sessions.length })

    await work(10, sessions, async (key) => {
      const sessionID = key[key.length - 1]
      const session = await Storage.read<Session.Info>(key).catch(() => undefined)
      if (!session) return
      if (!keep(session)) return
      session.projectID = newProjectID
      await Storage.write(["session", newProjectID, sessionID], session)
      await Storage.remove(key)
    }).catch((error) => {
      log.error("failed to migrate sessions", { error, from: fromBucket, to: newProjectID })
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

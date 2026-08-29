import { $ } from "bun"
import path from "path"
import fs from "fs/promises"
import { Log } from "../util/log"
import { Global } from "../global"
import z from "zod"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { Scheduler } from "../scheduler"
import { Filesystem } from "../util/filesystem"
import { SnapshotSafeIO } from "./safe-io"

export namespace Snapshot {
  const log = Log.create({ service: "snapshot" })
  const hour = 60 * 60 * 1000
  const prune = "7.days"

  type TestHooks = {
    afterMutationParentVerify?: (operation: "remove" | "restore", target: string) => void | Promise<void>
    writeChunkLimit?: (offset: number, remaining: number) => number
    mountIdentity?: (target: string, actual: string) => string | Promise<string>
  }

  const hooks = { value: undefined as TestHooks | undefined }

  /** Deterministic parent-swap barrier for the real snapshot mutation path. */
  export function testing(input: TestHooks) {
    if (!process.env.OPENSCIENCE_TEST_HOME) throw new Error("Snapshot test hooks are disabled outside tests")
    const prior = hooks.value
    hooks.value = input
    return {
      [Symbol.dispose]() {
        if (hooks.value === input) hooks.value = prior
      },
    }
  }

  export function init() {
    Scheduler.register({
      id: "snapshot.cleanup",
      interval: hour,
      run: cleanup,
      scope: "instance",
    })
  }

  export async function cleanup() {
    if (Instance.project.vcs !== "git") return
    const cfg = await Config.get()
    if (cfg.snapshot === false) return
    const git = gitdir()
    if (!(await ready(git))) return
    const result = await $`git --git-dir ${git} --work-tree ${Instance.worktree} gc --prune=${prune}`
      .quiet()
      .cwd(Instance.directory)
      .nothrow()
    if (result.exitCode !== 0) {
      log.warn("cleanup failed", {
        exitCode: result.exitCode,
        stderr: result.stderr.toString(),
        stdout: result.stdout.toString(),
      })
      return
    }
    log.info("cleanup", { prune })
  }

  // A failed `git add` must never be swallowed: write-tree would then snapshot a
  // stale (or empty) index, and a later revert() against that tree deletes every
  // file the tree is missing. Retry once for transient failures (index.lock
  // contention), then report the failure to the caller.
  async function stageAll(git: string) {
    let result = await $`git --git-dir ${git} --work-tree ${Instance.worktree} add -A -- .`
      .quiet()
      .cwd(Instance.directory)
      .nothrow()
    if (result.exitCode !== 0) {
      log.warn("add failed, retrying", { exitCode: result.exitCode, stderr: result.stderr.toString() })
      result = await $`git --git-dir ${git} --work-tree ${Instance.worktree} add -A -- .`
        .quiet()
        .cwd(Instance.directory)
        .nothrow()
    }
    if (result.exitCode !== 0) {
      log.error("add failed", { exitCode: result.exitCode, stderr: result.stderr.toString() })
      return false
    }
    return true
  }

  export async function track() {
    if (Instance.project.vcs !== "git") return
    const cfg = await Config.get()
    if (cfg.snapshot === false) return
    const git = await repository()
    if (!git) return
    const hash = await writeTree(git).catch((error) => {
      log.error("write-tree failed", { error })
      return undefined
    })
    if (!hash) return
    log.info("tracking", { hash, cwd: Instance.directory, git })
    return hash
  }

  /** Capture transaction rollback state even if snapshots were disabled after an undo began. */
  export async function capture() {
    if (Instance.project.vcs !== "git") return
    const git = await repository()
    if (!git) return
    return writeTree(git).catch((error) => {
      log.error("capture failed", { error })
      return undefined
    })
  }

  export async function availability() {
    if (Instance.project.vcs !== "git") return { available: false as const, reason: "Undo requires a Git project." }
    const cfg = await Config.get()
    if (cfg.snapshot === false) {
      return { available: false as const, reason: "Undo is unavailable because project snapshots are disabled." }
    }
    const git = await repository()
    if (!git) return { available: false as const, reason: "Undo could not initialize project snapshots." }
    return { available: true as const, git }
  }

  export const Patch = z.object({
    hash: z.string(),
    files: z.string().array(),
  })
  export type Patch = z.infer<typeof Patch>

  export const RevertIssue = z.object({
    file: z.string(),
    message: z.string(),
  })
  export type RevertIssue = z.infer<typeof RevertIssue>

  export const RevertResult = z.object({
    status: z.enum(["applied", "noop", "partial"]),
    restored: z.string().array(),
    removed: z.string().array(),
    skipped: z.string().array(),
    errors: RevertIssue.array(),
  })
  export type RevertResult = z.infer<typeof RevertResult>

  export async function patch(hash: string): Promise<Patch> {
    const git = gitdir()
    if (!(await stageAll(git))) throw new Error("Could not stage the project before computing its snapshot patch.")
    const result =
      await $`git -c core.autocrlf=false -c core.quotepath=false --git-dir ${git} --work-tree ${Instance.worktree} diff --no-ext-diff --no-renames --name-only -z ${hash} -- .`
        .quiet()
        .cwd(Instance.directory)
        .nothrow()

    // If git diff fails, return empty patch
    if (result.exitCode !== 0) {
      log.warn("failed to get diff", { hash, exitCode: result.exitCode })
      return { hash, files: [] }
    }

    return {
      hash,
      files: result
        .text()
        .split("\0")
        .filter(Boolean)
        .map((x) => path.join(Instance.worktree, x)),
    }
  }

  type TreeEntry = {
    mode: string
    type: string
    sha: string
  }

  type PlannedEntry = TreeEntry & {
    content: Uint8Array
  }

  function treePath(file: string) {
    const root = path.resolve(Instance.worktree)
    const target = path.resolve(file)
    const relative = path.relative(root, target)
    if (!relative || !Filesystem.contains(root, target)) return
    return relative.split(path.sep).join("/")
  }

  function worktreePath(file: string) {
    return path.join(Instance.worktree, ...file.split("/"))
  }

  async function listTree(git: string, hash: string) {
    const listing = await $`git --git-dir ${git} --work-tree ${Instance.worktree} ls-tree -r -z ${hash}`
      .quiet()
      .cwd(Instance.worktree)
      .nothrow()
    if (listing.exitCode !== 0) {
      throw new Error(`Could not read snapshot ${hash}: ${listing.stderr.toString().trim() || "unknown Git error"}`)
    }
    const entries = new Map<string, TreeEntry>()
    for (const line of listing.text().split("\0")) {
      const tab = line.indexOf("\t")
      if (tab < 0) continue
      const [mode, type, sha] = line.slice(0, tab).split(" ")
      if (!mode || !sha || !type) continue
      entries.set(line.slice(tab + 1), { mode, type, sha })
    }
    return entries
  }

  async function changedFiles(git: string, from: string, to: string) {
    const result =
      await $`git -c core.autocrlf=false -c core.quotepath=false --git-dir ${git} --work-tree ${Instance.worktree} diff --no-ext-diff --no-renames --name-only -z ${from} ${to} -- .`
        .quiet()
        .cwd(Instance.directory)
        .nothrow()
    if (result.exitCode !== 0) {
      throw new Error(`Could not compare project snapshots: ${result.stderr.toString().trim() || "unknown Git error"}`)
    }
    return result.text().split("\0").filter(Boolean).map(worktreePath)
  }

  async function writeTree(git: string) {
    if (!(await stageAll(git))) throw new Error("Could not stage the project before capturing its snapshot.")
    const result = await $`git --git-dir ${git} --work-tree ${Instance.worktree} write-tree`
      .quiet()
      .cwd(Instance.directory)
      .nothrow()
    if (result.exitCode !== 0) {
      throw new Error(
        `Could not capture the current project state: ${result.stderr.toString().trim() || "unknown Git error"}`,
      )
    }
    return result.text().trim()
  }

  async function applyTree(hash: string, files: string[]): Promise<RevertResult> {
    if (files.length === 0) return { status: "noop", restored: [], removed: [], skipped: [], errors: [] }
    const git = gitdir()
    const root = path.resolve(Instance.worktree)
    const restored: string[] = []
    const removed: string[] = []
    const skipped: string[] = []
    const errors: RevertIssue[] = []

    let entries: Map<string, TreeEntry>
    try {
      entries = await listTree(git, hash)
    } catch (error) {
      return {
        status: "partial",
        restored,
        removed,
        skipped: files,
        errors: [{ file: Instance.worktree, message: error instanceof Error ? error.message : String(error) }],
      }
    }

    const plans = new Map<string, PlannedEntry | undefined>()
    for (const file of files) {
      const relative = treePath(file)
      if (!relative) {
        skipped.push(file)
        errors.push({ file, message: "Path is outside the project worktree." })
        continue
      }
      if (plans.has(relative)) continue
      const entry = entries.get(relative)
      if (!entry) {
        plans.set(relative, undefined)
        continue
      }
      if (entry.mode === "160000" || entry.type !== "blob") {
        skipped.push(relative)
        errors.push({ file: relative, message: "Submodule entries cannot be restored automatically." })
        continue
      }
      const blob = await $`git --git-dir ${git} cat-file blob ${entry.sha}`.quiet().cwd(Instance.worktree).nothrow()
      if (blob.exitCode !== 0) {
        skipped.push(relative)
        errors.push({
          file: relative,
          message: `Could not read snapshot content: ${blob.stderr.toString().trim() || "unknown Git error"}`,
        })
        continue
      }
      plans.set(relative, { ...entry, content: blob.bytes() })
    }

    // Remove paths that should not exist before writing restored entries. Deep
    // paths go first so rename and file/directory transitions settle cleanly.
    const deletions = [...plans.entries()]
      .filter(([, entry]) => !entry)
      .toSorted(([a], [b]) => b.split("/").length - a.split("/").length)
    for (const [relative] of deletions) {
      try {
        const changed = await SnapshotSafeIO.remove(root, relative, {
          afterParentVerify: hooks.value?.afterMutationParentVerify,
          mountIdentity: hooks.value?.mountIdentity,
        })
        if (changed) removed.push(relative)
      } catch (error) {
        errors.push({ file: relative, message: error instanceof Error ? error.message : String(error) })
      }
    }

    // Parents first. A restored directory can therefore replace a current
    // symlink without any write ever traversing that symlink's destination.
    const writes = [...plans.entries()]
      .filter((item): item is [string, PlannedEntry] => Boolean(item[1]))
      .toSorted(([a], [b]) => a.split("/").length - b.split("/").length)
    for (const [relative, entry] of writes) {
      try {
        if (entry.mode === "120000") {
          await SnapshotSafeIO.restore(
            root,
            relative,
            { kind: "symlink", target: new TextDecoder().decode(entry.content) },
            {
              afterParentVerify: hooks.value?.afterMutationParentVerify,
              writeChunkLimit: hooks.value?.writeChunkLimit,
              mountIdentity: hooks.value?.mountIdentity,
            },
          )
        } else {
          await SnapshotSafeIO.restore(
            root,
            relative,
            { kind: "file", content: entry.content, mode: entry.mode === "100755" ? 0o755 : 0o644 },
            {
              afterParentVerify: hooks.value?.afterMutationParentVerify,
              writeChunkLimit: hooks.value?.writeChunkLimit,
              mountIdentity: hooks.value?.mountIdentity,
            },
          )
        }
        restored.push(relative)
      } catch (error) {
        errors.push({ file: relative, message: error instanceof Error ? error.message : String(error) })
      }
    }

    const status =
      errors.length > 0 || skipped.length > 0
        ? "partial"
        : restored.length > 0 || removed.length > 0
          ? "applied"
          : "noop"
    return { status, restored, removed, skipped, errors }
  }

  export async function restore(snapshot: string, scopedFiles?: string[]): Promise<RevertResult> {
    log.info("restore", { commit: snapshot, scoped: scopedFiles?.length })
    const git = gitdir()
    if (!(await ready(git))) {
      return {
        status: "partial",
        restored: [],
        removed: [],
        skipped: [],
        errors: [{ file: Instance.worktree, message: "The project snapshot repository is unavailable." }],
      }
    }
    try {
      const files = scopedFiles
        ? scopedFiles.map((file) => (path.isAbsolute(file) ? file : worktreePath(file)))
        : await changedFiles(git, snapshot, await writeTree(git))
      return applyTree(snapshot, files)
    } catch (error) {
      return {
        status: "partial",
        restored: [],
        removed: [],
        skipped: [],
        errors: [{ file: Instance.worktree, message: error instanceof Error ? error.message : String(error) }],
      }
    }
  }

  export async function revert(patches: Patch[]): Promise<RevertResult> {
    const first = patches[0]
    const files = [...new Set(patches.flatMap((item) => item.files))]
    if (!first || files.length === 0) return { status: "noop", restored: [], removed: [], skipped: [], errors: [] }
    return applyTree(first.hash, files)
  }

  export async function diff(hash: string) {
    const git = gitdir()
    if (!(await stageAll(git))) throw new Error("Could not stage the project before computing its snapshot diff.")
    const result =
      await $`git -c core.autocrlf=false -c core.quotepath=false --git-dir ${git} --work-tree ${Instance.worktree} diff --no-ext-diff ${hash} -- .`
        .quiet()
        .cwd(Instance.worktree)
        .nothrow()

    if (result.exitCode !== 0) {
      log.warn("failed to get diff", {
        hash,
        exitCode: result.exitCode,
        stderr: result.stderr.toString(),
        stdout: result.stdout.toString(),
      })
      return ""
    }

    return result.text().trim()
  }

  export const FileDiff = z
    .object({
      file: z.string(),
      before: z.string(),
      after: z.string(),
      additions: z.number(),
      deletions: z.number(),
    })
    .meta({
      ref: "FileDiff",
    })
  export type FileDiff = z.infer<typeof FileDiff>
  export async function diffFull(from: string, to: string): Promise<FileDiff[]> {
    const git = gitdir()
    const result: FileDiff[] = []
    for await (const line of $`git -c core.autocrlf=false -c core.quotepath=false --git-dir ${git} --work-tree ${Instance.worktree} diff --no-ext-diff --no-renames --numstat ${from} ${to} -- .`
      .quiet()
      .cwd(Instance.directory)
      .nothrow()
      .lines()) {
      if (!line) continue
      const [additions, deletions, file] = line.split("\t")
      const isBinaryFile = additions === "-" && deletions === "-"
      const before = isBinaryFile
        ? ""
        : await $`git -c core.autocrlf=false --git-dir ${git} --work-tree ${Instance.worktree} show ${from}:${file}`
            .quiet()
            .nothrow()
            .text()
      const after = isBinaryFile
        ? ""
        : await $`git -c core.autocrlf=false --git-dir ${git} --work-tree ${Instance.worktree} show ${to}:${file}`
            .quiet()
            .nothrow()
            .text()
      const added = isBinaryFile ? 0 : parseInt(additions)
      const deleted = isBinaryFile ? 0 : parseInt(deletions)
      result.push({
        file,
        before,
        after,
        additions: Number.isFinite(added) ? added : 0,
        deletions: Number.isFinite(deleted) ? deleted : 0,
      })
    }
    return result
  }

  function gitdir() {
    const project = Instance.project
    return path.join(Global.Path.data, "snapshot", project.id)
  }

  async function ready(git: string) {
    const [head, objects, refs] = await Promise.all([
      fs.stat(path.join(git, "HEAD")).catch(() => undefined),
      fs.stat(path.join(git, "objects")).catch(() => undefined),
      fs.stat(path.join(git, "refs")).catch(() => undefined),
    ])
    return head?.isFile() === true && objects?.isDirectory() === true && refs?.isDirectory() === true
  }

  async function repository() {
    const git = gitdir()
    if (await ready(git)) return git
    await fs.mkdir(git, { recursive: true })
    const result = await $`git init`
      .env({
        ...process.env,
        GIT_DIR: git,
        GIT_WORK_TREE: Instance.worktree,
      })
      .quiet()
      .cwd(Instance.directory)
      .nothrow()
    if (result.exitCode !== 0) {
      log.error("initialization failed", { exitCode: result.exitCode, stderr: result.stderr.toString() })
      return
    }
    await $`git --git-dir ${git} config core.autocrlf false`.quiet().nothrow()
    log.info("initialized")
    return git
  }
}

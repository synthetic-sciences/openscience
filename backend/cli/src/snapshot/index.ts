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

export namespace Snapshot {
  const log = Log.create({ service: "snapshot" })
  const hour = 60 * 60 * 1000
  const prune = "7.days"

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
    let result = await $`git --git-dir ${git} --work-tree ${Instance.worktree} add .`
      .quiet()
      .cwd(Instance.directory)
      .nothrow()
    if (result.exitCode !== 0) {
      log.warn("add failed, retrying", { exitCode: result.exitCode, stderr: result.stderr.toString() })
      result = await $`git --git-dir ${git} --work-tree ${Instance.worktree} add .`
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
    if (!(await stageAll(git))) return
    const result = await $`git --git-dir ${git} --work-tree ${Instance.worktree} write-tree`
      .quiet()
      .cwd(Instance.directory)
      .nothrow()
    if (result.exitCode !== 0) {
      log.error("write-tree failed", { exitCode: result.exitCode, stderr: result.stderr.toString() })
      return
    }
    const hash = result.text().trim()
    log.info("tracking", { hash, cwd: Instance.directory, git })
    return hash
  }

  export const Patch = z.object({
    hash: z.string(),
    files: z.string().array(),
  })
  export type Patch = z.infer<typeof Patch>

  export async function patch(hash: string): Promise<Patch> {
    const git = gitdir()
    await stageAll(git)
    const result =
      await $`git -c core.autocrlf=false -c core.quotepath=false --git-dir ${git} --work-tree ${Instance.worktree} diff --no-ext-diff --name-only ${hash} -- .`
        .quiet()
        .cwd(Instance.directory)
        .nothrow()

    // If git diff fails, return empty patch
    if (result.exitCode !== 0) {
      log.warn("failed to get diff", { hash, exitCode: result.exitCode })
      return { hash, files: [] }
    }

    const files = result.text()
    return {
      hash,
      files: files
        .trim()
        .split("\n")
        .map((x) => x.trim())
        .filter(Boolean)
        .map((x) => path.join(Instance.worktree, x)),
    }
  }

  export async function restore(snapshot: string) {
    log.info("restore", { commit: snapshot })
    const git = gitdir()
    const result =
      await $`git --git-dir ${git} --work-tree ${Instance.worktree} read-tree ${snapshot} && git --git-dir ${git} --work-tree ${Instance.worktree} checkout-index -a -f`
        .quiet()
        .cwd(Instance.worktree)
        .nothrow()

    if (result.exitCode !== 0) {
      log.error("failed to restore snapshot", {
        snapshot,
        exitCode: result.exitCode,
        stderr: result.stderr.toString(),
        stdout: result.stdout.toString(),
      })
    }
  }

  export async function revert(patches: Patch[]) {
    const files = new Set<string>()
    const git = gitdir()
    const root = await fs.realpath(Instance.worktree).catch(() => path.resolve(Instance.worktree))
    for (const item of patches) {
      // Restore never builds a per-file git pathspec: `git checkout <tree> --
      // <path>` proved unreliable for unusual filenames depending on platform.
      // Instead the tree is listed once (-z: NUL-delimited, unquoted raw
      // paths), and each file is rewritten from its blob via `cat-file`, which
      // addresses content by sha only. If the listing itself fails we know
      // nothing about the snapshot, and deleting on an unverified miss would
      // be destructive — keep everything in that case.
      const listing = await $`git --git-dir ${git} --work-tree ${Instance.worktree} ls-tree -r -z ${item.hash}`
        .quiet()
        .cwd(Instance.worktree)
        .nothrow()
      if (listing.exitCode !== 0) {
        log.warn("could not list snapshot tree, keeping files", {
          hash: item.hash,
          exitCode: listing.exitCode,
          stderr: listing.stderr.toString(),
        })
        continue
      }
      // each entry: <mode> SP <type> SP <sha> TAB <path>
      const entries = new Map<string, { mode: string; sha: string }>()
      for (const line of listing.text().split("\0")) {
        const tab = line.indexOf("\t")
        if (tab < 0) continue
        const [mode, , sha] = line.slice(0, tab).split(" ")
        entries.set(path.join(Instance.worktree, line.slice(tab + 1)), { mode, sha })
      }
      for (const file of item.files) {
        const target = path.resolve(file)
        if (files.has(target)) continue
        files.add(target)
        if (!Filesystem.contains(Instance.worktree, target)) {
          log.warn("skipping snapshot revert outside worktree", { file, hash: item.hash })
          continue
        }
        const parent = await realExistingParent(path.dirname(target))
        if (!parent || !Filesystem.contains(root, parent)) {
          log.warn("skipping snapshot revert through external parent", { file, parent, hash: item.hash })
          continue
        }
        log.info("reverting", { file: target, hash: item.hash })
        const entry = entries.get(target)
        if (!entry) {
          log.info("file did not exist in snapshot, deleting", { file: target })
          await fs.rm(target, { force: true }).catch(() => {})
          continue
        }
        if (entry.mode === "160000") {
          log.info("skipping submodule entry", { file: target })
          continue
        }
        const blob = await $`git --git-dir ${git} cat-file blob ${entry.sha}`.quiet().cwd(Instance.worktree).nothrow()
        if (blob.exitCode !== 0) {
          log.warn("could not read blob, keeping file", {
            file: target,
            sha: entry.sha,
            stderr: blob.stderr.toString(),
          })
          continue
        }
        await fs.mkdir(path.dirname(target), { recursive: true }).catch(() => {})
        // remove the current entry first: it may be a symlink (writing through
        // it would clobber the target) or have the wrong file type
        await fs.rm(target, { force: true }).catch(() => {})
        if (entry.mode === "120000") {
          await fs
            .symlink(blob.text(), target)
            .catch((e) => log.warn("could not restore symlink", { file: target, error: String(e) }))
          continue
        }
        await fs.writeFile(target, blob.bytes())
        await fs.chmod(target, entry.mode === "100755" ? 0o755 : 0o644).catch(() => {})
      }
    }
  }

  async function realExistingParent(dir: string): Promise<string | undefined> {
    const real = await fs.realpath(dir).catch(() => undefined)
    if (real) return real
    const parent = path.dirname(dir)
    if (parent === dir) return
    return realExistingParent(parent)
  }

  export async function diff(hash: string) {
    const git = gitdir()
    await stageAll(git)
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

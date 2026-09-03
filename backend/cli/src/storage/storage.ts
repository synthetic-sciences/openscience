import { Log } from "../util/log"
import path from "path"
import fs from "fs/promises"
import { randomUUID } from "crypto"
import { Global } from "../global"
import { Filesystem } from "../util/filesystem"
import { lazy } from "../util/lazy"
import { Lock } from "../util/lock"
import { $ } from "bun"
import { NamedError } from "@synsci/util/error"
import z from "zod"
import { DataRootBarrier } from "@/global/data-root-barrier"
import { LockCoordination } from "@/util/lock-coordination"

export namespace Storage {
  const log = Log.create({ service: "storage" })
  const timeout = 10_000
  const grace = 5_000

  type Migration = (dir: string) => Promise<void>

  export const NotFoundError = NamedError.create(
    "NotFoundError",
    z.object({
      message: z.string(),
    }),
  )

  const MIGRATIONS: Migration[] = [
    async (dir) => {
      const project = path.resolve(dir, "../project")
      if (!(await Filesystem.isDir(project))) return
      for await (const projectDir of new Bun.Glob("*").scan({
        cwd: project,
        onlyFiles: false,
      })) {
        log.info(`migrating project ${projectDir}`)
        let projectID = projectDir
        const fullProjectDir = path.join(project, projectDir)
        let worktree = "/"

        if (projectID !== "global") {
          for await (const msgFile of new Bun.Glob("storage/session/message/*/*.json").scan({
            cwd: path.join(project, projectDir),
            absolute: true,
          })) {
            const json = await Bun.file(msgFile).json()
            worktree = json.path?.root
            if (worktree) break
          }
          if (!worktree) continue
          if (!(await Filesystem.isDir(worktree))) continue
          const [id] = await $`git rev-list --max-parents=0 --all`
            .quiet()
            .nothrow()
            .cwd(worktree)
            .text()
            .then((x) =>
              x
                .split("\n")
                .filter(Boolean)
                .map((x) => x.trim())
                .toSorted(),
            )
          if (!id) continue
          projectID = id

          await Bun.write(
            path.join(dir, "project", projectID + ".json"),
            JSON.stringify({
              id,
              vcs: "git",
              worktree,
              time: {
                created: Date.now(),
                initialized: Date.now(),
              },
            }),
          )

          log.info(`migrating sessions for project ${projectID}`)
          for await (const sessionFile of new Bun.Glob("storage/session/info/*.json").scan({
            cwd: fullProjectDir,
            absolute: true,
          })) {
            const dest = path.join(dir, "session", projectID, path.basename(sessionFile))
            log.info("copying", {
              sessionFile,
              dest,
            })
            const session = await Bun.file(sessionFile).json()
            await Bun.write(dest, JSON.stringify(session))
            log.info(`migrating messages for session ${session.id}`)
            for await (const msgFile of new Bun.Glob(`storage/session/message/${session.id}/*.json`).scan({
              cwd: fullProjectDir,
              absolute: true,
            })) {
              const dest = path.join(dir, "message", session.id, path.basename(msgFile))
              log.info("copying", {
                msgFile,
                dest,
              })
              const message = await Bun.file(msgFile).json()
              await Bun.write(dest, JSON.stringify(message))

              log.info(`migrating parts for message ${message.id}`)
              for await (const partFile of new Bun.Glob(`storage/session/part/${session.id}/${message.id}/*.json`).scan(
                {
                  cwd: fullProjectDir,
                  absolute: true,
                },
              )) {
                const dest = path.join(dir, "part", message.id, path.basename(partFile))
                const part = await Bun.file(partFile).json()
                log.info("copying", {
                  partFile,
                  dest,
                })
                await Bun.write(dest, JSON.stringify(part))
              }
            }
          }
        }
      }
    },
    async (dir) => {
      for await (const item of new Bun.Glob("session/*/*.json").scan({
        cwd: dir,
        absolute: true,
      })) {
        const session = await Bun.file(item).json()
        if (!session.projectID) continue
        if (!session.summary?.diffs) continue
        const { diffs } = session.summary
        await Bun.file(path.join(dir, "session_diff", session.id + ".json")).write(JSON.stringify(diffs))
        await Bun.file(path.join(dir, "session", session.projectID, session.id + ".json")).write(
          JSON.stringify({
            ...session,
            summary: {
              additions: diffs.reduce((sum: any, x: any) => sum + x.additions, 0),
              deletions: diffs.reduce((sum: any, x: any) => sum + x.deletions, 0),
            },
          }),
        )
      }
    },
  ]

  const state = lazy(async () => {
    const dir = path.join(Global.Path.data, "storage")
    const migration = await Bun.file(path.join(dir, "migration"))
      .json()
      .then((x) => parseInt(x))
      .catch(() => 0)
    for (let index = migration; index < MIGRATIONS.length; index++) {
      log.info("running migration", { index })
      const migration = MIGRATIONS[index]
      // Only a completed migration advances the marker; a failed one is
      // retried on the next start instead of being silently skipped forever.
      const ok = await migration(dir).then(
        () => true,
        (error) => {
          log.error("failed to run migration", { index, error })
          return false
        },
      )
      if (!ok) break
      await Bun.write(path.join(dir, "migration"), (index + 1).toString())
    }
    return {
      dir,
    }
  })

  export async function remove(key: string[]) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      await using operation = await DataRootBarrier.enter(target)
      using _ = await Lock.write(target)
      await using __ = await interprocess(target)
      await fs.unlink(target).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return
        throw error
      })
    })
  }

  export async function read<T>(key: string[]) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      using _ = await Lock.read(target)
      const result = await Bun.file(target).json()
      return result as T
    })
  }

  /**
   * Publish a record by rename. Lock is an in-process map, so it orders writers
   * inside one process and nothing at all between processes — and several
   * openscience processes share this directory routinely (a CLI run alongside a
   * running server; `Project.fromDirectory` rewrites a record on every instance
   * creation). A plain write truncates in place, so a reader in another process
   * can observe a half-written file and fail to parse it. Rename is atomic, so
   * every reader sees either the old record or the new one.
   */
  async function publish(target: string, content: string) {
    const tmp = `${target}.${process.pid}.${randomUUID()}.tmp`
    await Bun.write(tmp, content)
    await fs.rename(tmp, target).catch(async (error) => {
      await fs.unlink(tmp).catch(() => {})
      throw error
    })
  }

  /** A narrow cross-process lock for storage mutations. OpenScience commonly
   * runs a production and development server against one data directory; the
   * in-memory Lock cannot serialize those writers. O_EXCL lock creation does,
   * while the stale timeout recovers a lock left by a crashed process. */
  async function abandoned(lockfile: string) {
    const owner = await Bun.file(lockfile)
      .json()
      .catch(() => undefined)
    const pid =
      owner &&
      typeof owner === "object" &&
      "pid" in owner &&
      typeof owner.pid === "number" &&
      Number.isSafeInteger(owner.pid) &&
      owner.pid > 0
        ? owner.pid
        : undefined
    const dead = (() => {
      if (!pid) return undefined
      try {
        process.kill(pid, 0)
        return false
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === "ESRCH"
      }
    })()
    const stale = await fs
      .stat(lockfile)
      .then((stat) => Date.now() - stat.mtimeMs > grace)
      .catch(() => false)
    return dead === true || (dead === undefined && stale)
  }

  async function reclaim(lockfile: string, deadline: number) {
    if (!(await abandoned(lockfile))) return false
    await using claim = await LockCoordination.claim(lockfile, 30_000)
    if (!(await claim.drain(deadline))) return false
    if (!(await abandoned(lockfile))) return false
    const tombstone = `${lockfile}.${process.pid}.${randomUUID()}.dead`
    return fs
      .rename(lockfile, tombstone)
      .then(async () => {
        await fs.unlink(tombstone).catch(() => {})
        return true
      })
      .catch(() => false)
  }

  async function interprocess(target: string) {
    const lockfile = `${target}.lock`
    const deadline = Date.now() + timeout
    await fs.mkdir(path.dirname(target), { recursive: true })
    for (;;) {
      const attempt = await (async () => {
        await using intent = await LockCoordination.intent(lockfile, 30_000)
        if (await intent.blocked()) return { status: "blocked" as const }
        const handle = await fs.open(lockfile, "wx", 0o600).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "EEXIST") return
          throw error
        })
        if (handle) return { status: "acquired" as const, handle }
        return { status: "occupied" as const }
      })()
      if (attempt.status === "acquired") {
        const handle = attempt.handle
        const token = randomUUID()
        // The lock JSON is only an ownership hint read back on dispose; the
        // O_EXCL create is what excludes other writers, so no fsync is needed.
        await handle
          .writeFile(JSON.stringify({ pid: process.pid, token, created: Date.now() }))
          .catch(async (error) => {
            await handle.close().catch(() => undefined)
            await fs.unlink(lockfile).catch(() => undefined)
            throw error
          })
        return {
          async [Symbol.asyncDispose]() {
            await handle.close().catch(() => {})
            const owner = await Bun.file(lockfile)
              .json()
              .catch(() => undefined)
            if (!owner || typeof owner !== "object" || !("token" in owner) || owner.token !== token) return
            await fs.unlink(lockfile).catch((error: NodeJS.ErrnoException) => {
              if (error.code !== "ENOENT") throw error
            })
          },
        }
      }
      if (await reclaim(lockfile, deadline)) continue
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for storage mutation lock: ${target}`)
      await new Promise<void>((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 20)))
    }
  }

  export async function update<T>(key: string[], fn: (draft: T) => void) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      await using operation = await DataRootBarrier.enter(target)
      using _ = await Lock.write(target)
      await using __ = await interprocess(target)
      const content = await Bun.file(target).json()
      fn(content)
      await publish(target, JSON.stringify(content, null, 2))
      return content as T
    })
  }

  export async function write<T>(key: string[], content: T) {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      await using operation = await DataRootBarrier.enter(target)
      using _ = await Lock.write(target)
      await using __ = await interprocess(target)
      await publish(target, JSON.stringify(content, null, 2))
    })
  }

  /** Atomically read-or-create and replace one record under the same
   * interprocess lock. Callers use this when computing a revision from the
   * previous value; splitting read() + write() would lose concurrent changes. */
  export async function upsert<T>(key: string[], fn: (current: T | undefined) => T): Promise<T> {
    const dir = await state().then((x) => x.dir)
    const target = path.join(dir, ...key) + ".json"
    return withErrorHandling(async () => {
      await using operation = await DataRootBarrier.enter(target)
      using _ = await Lock.write(target)
      await using __ = await interprocess(target)
      const current = await Bun.file(target)
        .json()
        .then((value) => value as T)
        .catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined
          throw error
        })
      const next = fn(current)
      await publish(target, JSON.stringify(next, null, 2))
      return next
    })
  }

  async function withErrorHandling<T>(body: () => Promise<T>) {
    return body().catch((e) => {
      if (!(e instanceof Error)) throw e
      const errnoException = e as NodeJS.ErrnoException
      if (errnoException.code === "ENOENT") {
        throw new NotFoundError({ message: `Resource not found: ${errnoException.path}` })
      }
      throw e
    })
  }

  // Records are `.json` files and nothing else. `publish` stages every write as
  // a sibling `<target>.<pid>.<uuid>.tmp` in the same directory — it has to,
  // since rename is only atomic within one filesystem — so a bare `**/*` also
  // matched the staging file during the write→rename window, and permanently
  // when a writer died in between (nothing sweeps them). Every caller here
  // strips a fixed 5 characters assuming ".json", so those entries became
  // phantom keys whose `read` throws NotFoundError. Matching on the suffix
  // makes that assumption true by construction, and unlike relocating temp
  // files it also hides debris already left on disk by earlier runs.
  const glob = new Bun.Glob("**/*.json")
  export async function list(prefix: string[]) {
    const dir = await state().then((x) => x.dir)
    try {
      const result = await Array.fromAsync(
        glob.scan({
          cwd: path.join(dir, ...prefix),
          onlyFiles: true,
        }),
      ).then((results) => results.map((x) => [...prefix, ...x.slice(0, -5).split(path.sep)]))
      result.sort()
      return result
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === "ENOENT" || code === "ENOTDIR") return []
      log.error("failed to list storage keys", { prefix, error })
      throw error
    }
  }
}

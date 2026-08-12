import fs from "fs/promises"
import path from "path"
import { Lock } from "./lock"
import { DataRootBarrier } from "@/global/data-root-barrier"

/**
 * Shared persistence for small JSON-object credential stores (auth.json,
 * mcp-auth.json). Every write goes through a temp file in the same directory
 * followed by a rename, so a crash or concurrent reader never observes a torn
 * file, and every read-modify-write cycle is serialized behind the in-process
 * Lock keyed by file path plus an on-disk lease shared by independent CLI
 * processes.
 *
 * A file that exists but cannot be parsed is fatal on the write path:
 * proceeding with `{}` would rewrite the store containing only the entry
 * being saved and silently destroy every other credential. The corrupt file
 * is backed up alongside and the write throws. The read path degrades to
 * `{}` so the CLI still boots.
 */
export namespace JsonStore {
  const LOCK_TIMEOUT = 10_000
  const INVALID_LOCK_GRACE = 5_000

  function running(pid: number) {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM"
    }
  }

  async function abandoned(lockpath: string) {
    const owner = await Bun.file(lockpath)
      .json()
      .catch(() => undefined)
    if (owner && typeof owner === "object" && "pid" in owner && typeof owner.pid === "number") {
      return !running(owner.pid)
    }
    const stat = await fs.stat(lockpath).catch(() => undefined)
    return !!stat && Date.now() - stat.mtimeMs > INVALID_LOCK_GRACE
  }

  async function fileLock(filepath: string) {
    const lockpath = `${filepath}.lock`
    const start = Date.now()
    await fs.mkdir(path.dirname(filepath), { recursive: true })

    const acquire = async (): Promise<Awaited<ReturnType<typeof fs.open>>> => {
      const handle = await fs.open(lockpath, "wx", 0o600).catch(async (error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error
        if (await abandoned(lockpath)) {
          await fs.unlink(lockpath).catch(() => undefined)
          return acquire()
        }
        if (Date.now() - start >= LOCK_TIMEOUT) {
          throw new Error(`Timed out waiting for another OpenScience process to release ${filepath}`)
        }
        await Bun.sleep(15)
        return acquire()
      })
      return handle
    }

    const handle = await acquire()
    await handle.writeFile(JSON.stringify({ pid: process.pid, created: Date.now() })).catch(async (error) => {
      await handle.close().catch(() => undefined)
      await fs.unlink(lockpath).catch(() => undefined)
      throw error
    })
    await handle.sync().catch(async (error) => {
      await handle.close().catch(() => undefined)
      await fs.unlink(lockpath).catch(() => undefined)
      throw error
    })
    return {
      async [Symbol.asyncDispose]() {
        await handle.close().catch(() => undefined)
        await fs.unlink(lockpath).catch(() => undefined)
      },
    }
  }

  async function parse(filepath: string): Promise<Record<string, unknown>> {
    const file = Bun.file(filepath)
    if (!(await file.exists())) return {}
    const text = await file.text()
    if (!text.trim()) return {}
    return JSON.parse(text) as Record<string, unknown>
  }

  /** Read path: a missing, empty, or corrupt file degrades to `{}`. */
  export async function read(filepath: string): Promise<Record<string, unknown>> {
    using _ = await Lock.read(filepath)
    return await parse(filepath).catch(() => ({}) as Record<string, unknown>)
  }

  /** Write path: refuse to build on a file that exists but cannot be parsed. */
  async function load(filepath: string): Promise<Record<string, unknown>> {
    try {
      return await parse(filepath)
    } catch (error) {
      const backup = `${filepath}.corrupt-${process.pid}`
      await fs.copyFile(filepath, backup).catch(() => {})
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(
        `${filepath} exists but could not be parsed (${reason}). ` +
          `Refusing to overwrite it — that would discard every other entry. ` +
          `The unmodified file was backed up to ${backup}; repair or remove ${filepath} and retry.`,
      )
    }
  }

  async function replace(filepath: string, data: Record<string, unknown>) {
    const temp = `${filepath}.${process.pid}.tmp`
    await Bun.write(temp, JSON.stringify(data, null, 2), { mode: 0o600 })
    await fs.chmod(temp, 0o600)
    try {
      await fs.rename(temp, filepath)
    } catch (error) {
      await fs.unlink(temp).catch(() => {})
      throw error
    }
  }

  /** Serialized, atomic read-modify-write. The callback may mutate `data` in
   *  place or return a replacement object. */
  export async function update(
    filepath: string,
    fn: (data: Record<string, unknown>) => Record<string, unknown> | void | Promise<Record<string, unknown> | void>,
  ): Promise<void> {
    await using operation = await DataRootBarrier.enter(filepath)
    using _ = await Lock.write(filepath)
    await using file = await fileLock(filepath)
    const data = await load(filepath)
    const next = (await fn(data)) ?? data
    await replace(filepath, next)
  }
}

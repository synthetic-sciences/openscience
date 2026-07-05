import fs from "fs/promises"
import { Lock } from "./lock"

/**
 * Shared persistence for small JSON-object credential stores (auth.json,
 * mcp-auth.json). Every write goes through a temp file in the same directory
 * followed by a rename, so a crash or concurrent reader never observes a torn
 * file, and every read-modify-write cycle is serialized behind the in-process
 * Lock keyed by file path.
 *
 * A file that exists but cannot be parsed is fatal on the write path:
 * proceeding with `{}` would rewrite the store containing only the entry
 * being saved and silently destroy every other credential. The corrupt file
 * is backed up alongside and the write throws. The read path degrades to
 * `{}` so the CLI still boots.
 */
export namespace JsonStore {
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
    fn: (data: Record<string, unknown>) => Record<string, unknown> | void,
  ): Promise<void> {
    using _ = await Lock.write(filepath)
    const data = await load(filepath)
    const next = fn(data) ?? data
    await replace(filepath, next)
  }
}

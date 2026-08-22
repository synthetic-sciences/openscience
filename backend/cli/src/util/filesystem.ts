import { realpathSync } from "fs"
import { lstat, realpath, stat } from "fs/promises"
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "path"

export namespace Filesystem {
  export const exists = (p: string) =>
    Bun.file(p)
      .stat()
      .then(() => true)
      .catch(() => false)

  export const isDir = (p: string) =>
    Bun.file(p)
      .stat()
      .then((s) => s.isDirectory())
      .catch(() => false)
  /**
   * On Windows, normalize a path to its canonical casing using the filesystem.
   * This is needed because Windows paths are case-insensitive but LSP servers
   * may return paths with different casing than what we send them.
   */
  export function normalizePath(p: string): string {
    if (process.platform !== "win32") return p
    try {
      return realpathSync.native(p)
    } catch {
      return p
    }
  }
  export function overlaps(a: string, b: string) {
    const relA = relative(a, b)
    const relB = relative(b, a)
    return containsRelative(relA) || containsRelative(relB)
  }

  export function contains(parent: string, child: string) {
    return containsRelative(relative(parent, child))
  }

  function containsRelative(value: string) {
    return value === "" || (value !== ".." && !value.startsWith(`..${sep}`) && !isAbsolute(value))
  }

  async function canonicalize(cursor: string, tail: string[]): Promise<string | undefined> {
    const result = await realpath(cursor).then(
      (value) => ({ value }),
      (error: NodeJS.ErrnoException) => ({ error }),
    )
    if ("error" in result) {
      if (result.error.code !== "ENOENT" && result.error.code !== "ENOTDIR") return
      const info = await lstat(cursor).catch(() => undefined)
      if (info?.isSymbolicLink()) return
      const parent = dirname(cursor)
      if (parent === cursor) return
      return canonicalize(parent, [basename(cursor), ...tail])
    }
    const base = result.value
    if (!tail.length) return base
    const info = await stat(base).catch(() => undefined)
    if (!info?.isDirectory()) return
    return resolve(base, ...tail)
  }

  /**
   * Resolve a path by filesystem identity, including a target that does not
   * exist yet. Existing symlinks are followed; a broken symlink is rejected
   * instead of being reconstructed as if it were an ordinary path segment.
   */
  export function canonical(p: string): Promise<string | undefined> {
    return canonicalize(resolve(p), [])
  }

  export async function containsCanonical(parent: string, child: string): Promise<boolean> {
    const [root, target] = await Promise.all([canonical(parent), canonical(child)])
    if (!root || !target) return false
    return contains(root, target)
  }

  export async function findUp(target: string, start: string, stop?: string) {
    let current = start
    const result = []
    while (true) {
      const search = join(current, target)
      if (await exists(search)) result.push(search)
      if (stop === current) break
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    return result
  }

  export async function* up(options: { targets: string[]; start: string; stop?: string }) {
    const { targets, start, stop } = options
    let current = start
    while (true) {
      for (const target of targets) {
        const search = join(current, target)
        if (await exists(search)) yield search
      }
      if (stop === current) break
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }

  export async function globUp(pattern: string, start: string, stop?: string) {
    let current = start
    const result = []
    while (true) {
      try {
        const glob = new Bun.Glob(pattern)
        for await (const match of glob.scan({
          cwd: current,
          absolute: true,
          onlyFiles: true,
          followSymlinks: true,
          dot: true,
        })) {
          result.push(match)
        }
      } catch {
        // Skip invalid glob patterns
      }
      if (stop === current) break
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    return result
  }
}

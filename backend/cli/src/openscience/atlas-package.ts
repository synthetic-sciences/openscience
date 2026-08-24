import { existsSync } from "fs"
import { createRequire } from "module"
import path from "path"
import { fileURLToPath } from "url"

export interface AtlasPackageResolutionOptions {
  execPath?: string
  moduleUrl?: string
  cwd?: string
  resolvePackageJson?: () => string
}

/** Locate a separately installed legacy @synsci/atlas package.
 *
 * OpenScience no longer depends on or installs this package. During the
 * transition, an existing sibling installation can still be discovered from a
 * compiled native package, where import.meta.url is not a reliable anchor.
 * Walk from process.execPath first, then retain source-mode fallbacks. */
export function resolveAtlasPackageDir(options: AtlasPackageResolutionOptions = {}): string | null {
  const moduleUrl = options.moduleUrl ?? import.meta.url
  try {
    const resolvePackageJson =
      options.resolvePackageJson ?? (() => createRequire(moduleUrl).resolve("@synsci/atlas/package.json"))
    return path.dirname(resolvePackageJson())
  } catch {}

  const execPath = options.execPath ?? process.execPath
  const starts = [
    execPath ? path.dirname(execPath) : "",
    (() => {
      try {
        return path.dirname(fileURLToPath(moduleUrl))
      } catch {
        return ""
      }
    })(),
    options.cwd ?? process.cwd(),
  ].filter(Boolean)

  for (const start of new Set(starts)) {
    let dir = start
    while (true) {
      const candidate = path.join(dir, "node_modules", "@synsci", "atlas", "package.json")
      if (existsSync(candidate)) return path.dirname(candidate)
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return null
}

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

/** Locate the bundled @synsci/atlas package.
 *
 * Compiled npm installs run the native binary from a platform package such as
 * `node_modules/@synsci/openscience-darwin-arm64/bin/openscience`, while Atlas
 * is a sibling dependency at `node_modules/@synsci/atlas`. A compiled bundle's
 * import.meta.url is not a reliable anchor for that install tree, so walk from
 * process.execPath first, then retain the source-mode module/cwd fallbacks. */
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

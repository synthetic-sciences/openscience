import { constants as FS } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/** Resolve authority-bearing host tools without consulting ambient PATH.
 * Project configuration may influence PATH, so credentialed brokers use only
 * fixed OS/package-manager install roots (or an explicit internal test root). */
export namespace TrustedExecutable {
  function systemDirectories() {
    if (process.platform === "win32") {
      const windows = process.env.SYSTEMROOT ?? process.env.WINDIR ?? "C:\\Windows"
      return [path.join(windows, "System32", "OpenSSH"), path.join(windows, "System32")]
    }
    return ["/usr/bin", "/bin", "/usr/sbin", "/sbin"]
  }

  function userDirectories() {
    if (process.platform === "win32") {
      return [
        process.env.ProgramFiles,
        process.env["ProgramFiles(x86)"],
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Programs"),
      ].filter((item): item is string => Boolean(item))
    }
    const home = os.homedir()
    return [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      path.join(home, ".local", "bin"),
      path.join(home, ".cargo", "bin"),
      path.join(home, "go", "bin"),
    ]
  }

  export function directories(options: { systemOnly?: boolean } = {}) {
    return [...systemDirectories(), ...(options.systemOnly ? [] : userDirectories())]
  }

  export function searchPath(options: { systemOnly?: boolean } = {}) {
    return directories(options).join(path.delimiter)
  }

  export async function resolve(
    name: string,
    options: { systemOnly?: boolean; directories?: string[] } = {},
  ): Promise<string | undefined> {
    if (!name || path.basename(name) !== name || name === "." || name === "..") {
      throw new Error(`Invalid trusted executable name: ${name}`)
    }
    const extensions = process.platform === "win32" ? [".exe", ".cmd", ".bat", ".com", ""] : [""]
    const roots = options.directories ?? directories(options)
    for (const directory of roots) {
      if (!path.isAbsolute(directory)) continue
      for (const extension of extensions) {
        const candidate = path.join(directory, process.platform === "win32" ? `${name}${extension}` : name)
        const canonical = await fs.realpath(candidate).catch(() => undefined)
        if (!canonical) continue
        const info = await fs.stat(canonical).catch(() => undefined)
        if (!info?.isFile()) continue
        if (process.platform !== "win32") {
          const executable = await fs
            .access(canonical, FS.X_OK)
            .then(() => true)
            .catch(() => false)
          if (!executable) continue
        }
        return canonical
      }
    }
  }
}

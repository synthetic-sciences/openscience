import { constants as FS } from "node:fs"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

/** Resolve authority-bearing host tools without consulting ambient PATH.
 * Project configuration may influence PATH, so credentialed brokers use only
 * fixed OS/package-manager install roots (or an explicit internal test root). */
export namespace TrustedExecutable {
  export interface Attestation {
    version: 1
    name: string
    path: string
    sha256: string
    size: string
    device: string
    inode: string
    mode: string
  }

  export class ReplacedError extends Error {
    constructor(name: string, options?: ErrorOptions) {
      super(
        `Trusted executable ${name} changed after it was approved; disconnect and reconnect the provider to approve the new binary`,
        options,
      )
      this.name = "TrustedExecutableReplacedError"
    }
  }

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

  async function fingerprint(name: string, executablePath: string): Promise<Attestation> {
    if (!path.isAbsolute(executablePath)) throw new Error(`Trusted executable path must be absolute: ${name}`)
    const noFollow = typeof FS.O_NOFOLLOW === "number" ? FS.O_NOFOLLOW : 0
    const handle = await fs.open(executablePath, FS.O_RDONLY | noFollow).catch((error) => {
      throw new ReplacedError(name, { cause: error })
    })
    try {
      const before = await handle.stat({ bigint: true })
      if (!before.isFile()) throw new ReplacedError(name)
      if (process.platform !== "win32" && (before.mode & 0o111n) === 0n) throw new ReplacedError(name)
      const hash = createHash("sha256")
      const chunk = Buffer.allocUnsafe(64 * 1024)
      let position = 0
      for (;;) {
        const { bytesRead } = await handle.read(chunk, 0, chunk.byteLength, position)
        if (!bytesRead) break
        hash.update(chunk.subarray(0, bytesRead))
        position += bytesRead
      }
      const after = await handle.stat({ bigint: true })
      const stable =
        before.dev === after.dev &&
        before.ino === after.ino &&
        before.size === after.size &&
        before.mode === after.mode &&
        before.mtimeMs === after.mtimeMs &&
        before.ctimeMs === after.ctimeMs
      if (!stable) throw new ReplacedError(name)
      return {
        version: 1,
        name,
        path: executablePath,
        sha256: hash.digest("hex"),
        size: before.size.toString(),
        device: before.dev.toString(),
        inode: before.ino.toString(),
        mode: before.mode.toString(),
      }
    } finally {
      await handle.close()
    }
  }

  function same(left: Attestation, right: Attestation) {
    return (
      left.version === right.version &&
      left.name === right.name &&
      left.path === right.path &&
      left.sha256 === right.sha256 &&
      left.size === right.size &&
      left.device === right.device &&
      left.inode === right.inode &&
      left.mode === right.mode
    )
  }

  /** Resolve a reviewed executable and capture an exact, durable file identity.
   * Credential-bearing callers persist this value before admitting a secret. */
  export async function attest(
    name: string,
    options: { systemOnly?: boolean; directories?: string[] } = {},
  ): Promise<Attestation | undefined> {
    const executablePath = await resolve(name, options)
    if (!executablePath) return
    return fingerprint(name, executablePath)
  }

  /** Re-open and hash the pinned canonical path. Both file identity and content
   * must still match immediately before the credential-bearing spawn. */
  export async function revalidate(attestation: Attestation): Promise<string> {
    const current = await fingerprint(attestation.name, attestation.path)
    if (!same(attestation, current)) throw new ReplacedError(attestation.name)
    return attestation.path
  }
}

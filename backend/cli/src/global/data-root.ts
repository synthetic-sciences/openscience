import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { WindowsJunction } from "./windows-junction"

/**
 * Stable indirection for the mutable OpenScience data root.
 *
 * Most persistence modules intentionally compute their paths once at module
 * load. A settings-time relocation therefore cannot change a process-local
 * string without leaving half the process on the old root. All normal boots
 * instead point those strings through one directory link in the XDG config
 * directory. Retargeting that link moves every existing path in every server
 * process after the cross-process relocation barrier drains active writers.
 */
export namespace DataRoot {
  export const LINK_NAME = "data-root"

  export interface Managed {
    path: string
    target: string
    managed: boolean
  }

  function inside(parent: string, candidate: string) {
    const relative = path.relative(parent, candidate)
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
  }

  async function targetOf(link: string): Promise<string | undefined> {
    const stat = await fs.lstat(link).catch(() => undefined)
    if (!stat?.isSymbolicLink()) return
    const target = await fs.realpath(link).catch(() => undefined)
    if (!target) return
    const targetStat = await fs.stat(target).catch(() => undefined)
    return targetStat?.isDirectory() ? target : undefined
  }

  /** Read the active physical target without creating the indirection. */
  export async function active(config: string): Promise<string | undefined> {
    return targetOf(path.join(config, LINK_NAME))
  }

  async function link(target: string, destination: string) {
    const current = await fs.lstat(destination).catch(() => undefined)
    if (process.platform === "win32" && current?.isSymbolicLink()) {
      WindowsJunction.retarget(destination, target)
      return
    }
    const temporary = `${destination}.${process.pid}.${randomUUID()}.next`
    await fs.symlink(target, temporary, process.platform === "win32" ? "junction" : "dir")
    try {
      await fs.rename(temporary, destination)
    } catch (error) {
      await fs.rm(temporary, { force: true }).catch(() => undefined)
      // Another process may have established the managed junction after our
      // initial lstat. Windows cannot rename over it; update that same reparse
      // record in place. Ordinary files/directories fail closed in CreateFile
      // or with a reparse-tag mismatch.
      const winner = await fs.lstat(destination).catch(() => undefined)
      if (process.platform === "win32" && winner?.isSymbolicLink()) {
        WindowsJunction.retarget(destination, target)
        return
      }
      throw error
    }
  }

  /**
   * Establish the stable link on first boot. Explicit test/administrator data
   * roots deliberately remain direct: they are already an external authority
   * and may share no XDG config directory with sibling test processes.
   */
  export async function ensure(config: string, initial: string, explicit: boolean): Promise<Managed> {
    const requested = path.resolve(initial)
    await fs.mkdir(requested, { recursive: true })
    const target = await fs.realpath(requested)
    if (explicit) return { path: target, target, managed: false }

    await fs.mkdir(config, { recursive: true })
    const destination = path.join(config, LINK_NAME)
    const current = await targetOf(destination)
    if (current) return { path: destination, target: current, managed: true }

    const existing = await fs.lstat(destination).catch(() => undefined)
    if (existing) {
      throw new Error(
        `${destination} must be a managed OpenScience directory link, but an ordinary file or directory exists there`,
      )
    }
    await link(target, destination)
    return { path: destination, target, managed: true }
  }

  /** Retarget the stable data-root link while the relocation barrier has
   * drained OpenScience writers. POSIX replaces the link name atomically;
   * Windows updates the existing junction's reparse record in place because
   * Win32 cannot rename over a directory junction. */
  export async function switchTo(root: string, target: string): Promise<void> {
    const requested = path.resolve(target)
    const stat = await fs.stat(requested).catch(() => undefined)
    if (!stat?.isDirectory()) throw new Error(`Data target does not exist or is not a directory: ${requested}`)
    const destination = await fs.realpath(requested)
    if (inside(destination, root)) throw new Error("The managed data-root link cannot live inside its own target")
    await link(destination, root)
    const selected = await fs.realpath(root)
    if (selected !== destination) {
      throw new Error(`Data-root switch selected ${selected}, expected ${destination}`)
    }
  }
}

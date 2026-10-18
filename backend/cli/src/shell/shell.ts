import { Flag } from "@/flag/flag"
import { lazy } from "@synsci/util/lazy"
import path from "path"
import fs from "fs"
import { spawn, spawnSync, type ChildProcess } from "child_process"
import { WindowsJobLauncher } from "../process/windows-job-launcher"

const SIGKILL_TIMEOUT_MS = 200

export namespace Shell {
  export function pipefail(shell: string, command: string) {
    const name = path
      .basename(shell)
      .toLowerCase()
      .replace(/\.exe$/, "")
    if (name !== "bash" && name !== "zsh") return command
    return `set -o pipefail\n${command}`
  }

  /** POSIX: true only when `pid` leads its own process group, so a negative-pid
   * signal targets only its group and can never reach ours. */
  function leadsOwnGroup(pid: number): boolean {
    if (process.platform !== "linux") return true
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
      // Fields after the closing ")" are: state, ppid, pgrp, session, ...
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
      return Number(fields[2]) === pid
    } catch {
      return false
    }
  }

  export async function killTree(
    proc: ChildProcess,
    opts?: { exited?: () => boolean; detached?: boolean },
  ): Promise<void> {
    const pid = proc.pid
    if (!pid) return

    if (process.platform === "win32") {
      if (opts?.exited?.()) return
      await new Promise<void>((resolve) => {
        const killer = spawn("taskkill", ["/pid", String(pid), "/f", "/t"], { stdio: "ignore" })
        killer.once("exit", () => resolve())
        killer.once("error", () => resolve())
      })
      return
    }

    if (process.platform === "linux" && WindowsJobLauncher.isLinuxSubreaper(proc)) {
      // This child is a verified subreaper, not the payload. A direct control
      // signal makes it quiesce, kill, and waitpid-reap its adopted tree. Never
      // group-signal or SIGKILL the anchor: on timeout it must remain alive so
      // escaped descendants cannot reparent to host init.
      if (opts?.exited?.()) return
      try {
        proc.kill("SIGTERM")
      } catch (error) {
        if (opts?.exited?.() || (error as NodeJS.ErrnoException).code === "ESRCH") return
        throw error
      }
      for (let attempt = 0; attempt < 250; attempt++) {
        if (opts?.exited?.() || proc.exitCode !== null || proc.signalCode !== null) return
        await Bun.sleep(20)
      }
      throw new Error(`Linux child-subreaper ${pid} did not finish cooperative descendant cleanup`)
    }

    // `detached` is captured at spawn time, so it remains trustworthy after the
    // group leader exits and /proc/<pid> disappears. POSIX process groups outlive
    // their leader while any grandchild remains.
    const ownsGroup = opts?.detached === true || leadsOwnGroup(pid)
    if (ownsGroup) {
      try {
        process.kill(-pid, "SIGTERM")
      } catch {
        // ESRCH means the group is already gone. If the leader is also gone,
        // there is no direct child left to clean up.
        if (opts?.exited?.()) return
        try {
          proc.kill("SIGTERM")
        } catch {}
        return
      }
      await Bun.sleep(SIGKILL_TIMEOUT_MS)
      // Always make the group-kill attempt. The leader may have exited while a
      // joblib/BLAS grandchild ignored SIGTERM; ESRCH is the successful no-op.
      try {
        process.kill(-pid, "SIGKILL")
      } catch {}
      return
    }

    if (opts?.exited?.()) return
    try {
      proc.kill("SIGTERM")
      await Bun.sleep(SIGKILL_TIMEOUT_MS)
      if (!opts?.exited?.()) proc.kill("SIGKILL")
    } catch {}
  }

  export function interruptTree(proc: ChildProcess, opts?: { detached?: boolean }): boolean {
    const pid = proc.pid
    if (!pid || proc.exitCode !== null) return false

    if (process.platform !== "win32" && (opts?.detached === true || leadsOwnGroup(pid))) {
      try {
        process.kill(-pid, "SIGINT")
        return true
      } catch {}
    }

    try {
      return proc.kill("SIGINT")
    } catch {
      return false
    }
  }

  /**
   * Signal the payload processes below a Linux namespace wrapper without
   * interrupting the wrapper itself. Bubblewrap owns the host-visible process
   * group, so signaling that group tears down the PID namespace before a
   * persistent Python kernel can catch KeyboardInterrupt and return to idle.
   */
  export function interruptDescendants(proc: ChildProcess, opts?: { exclude?: string[] }): boolean {
    const root = proc.pid
    if (process.platform !== "linux" || !root || proc.exitCode !== null) return false

    const read = (pid: number) => {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
        const end = stat.lastIndexOf(")")
        const fields = stat.slice(end + 2).split(" ")
        return {
          pid,
          name: stat.slice(stat.indexOf("(") + 1, end),
          parent: Number(fields[1]),
          started: fields[19],
        }
      } catch {
        return
      }
    }
    const nodes = fs
      .readdirSync("/proc", { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^\d+$/.test(entry.name))
      .map((entry) => read(Number(entry.name)))
      .filter((entry) => entry !== undefined)
    const indexed = new Map(nodes.map((entry) => [entry.pid, entry]))
    const descends = (pid: number, seen = new Set<number>()): boolean => {
      const node = indexed.get(pid)
      if (!node || seen.has(pid)) return false
      if (node.parent === root) return true
      seen.add(pid)
      return descends(node.parent, seen)
    }
    const excluded = new Set(opts?.exclude ?? [])
    const targets = nodes.filter((node) => descends(node.pid) && !excluded.has(node.name))
    return targets.reduce((sent, node) => {
      const current = read(node.pid)
      if (!current || current.started !== node.started) return sent
      try {
        process.kill(node.pid, "SIGINT")
        return true
      } catch {
        return sent
      }
    }, false)
  }

  /**
   * Best-effort synchronous process-tree cleanup for process exit handlers.
   * Exit handlers cannot wait for killTree's timer or an asynchronous taskkill.
   */
  export function killTreeSync(proc: ChildProcess, opts?: { detached?: boolean }): void {
    const pid = proc.pid
    if (!pid) return

    if (process.platform === "win32") {
      try {
        spawnSync("taskkill", ["/pid", String(pid), "/f", "/t"], {
          stdio: "ignore",
          windowsHide: true,
          timeout: 5_000,
        })
      } catch {}
      return
    }

    if (process.platform === "linux" && WindowsJobLauncher.isLinuxSubreaper(proc)) {
      // Exit handlers cannot await cleanup. Ask the subreaper to drain and
      // deliberately leave it alive rather than replacing containment with a
      // best-effort group SIGKILL.
      try {
        proc.kill("SIGTERM")
      } catch {}
      return
    }

    if (opts?.detached === true || leadsOwnGroup(pid)) {
      try {
        process.kill(-pid, "SIGKILL")
        return
      } catch {}
    }
    try {
      proc.kill("SIGKILL")
    } catch {}
  }
  const BLACKLIST = new Set(["fish", "nu"])

  function exists(p: string) {
    try {
      return fs.existsSync(p)
    } catch {
      return false
    }
  }

  /** Git Bash exposes different git.exe directories depending on its entry
   * point. Search within that installation, never System32's WSL bash.exe. */
  export function windowsGitBash(git: string | null, available: (file: string) => boolean = exists) {
    if (!git) return
    const directory = path.win32.dirname(git)
    const name = path.win32.basename(directory).toLowerCase()
    const parent = path.win32.dirname(directory)
    const nested = ["mingw64", "mingw32", "ucrt64", "usr"].includes(path.win32.basename(parent).toLowerCase())
    const root = name === "cmd" ? parent : name === "bin" ? (nested ? path.win32.dirname(parent) : parent) : undefined
    if (!root) return
    return [path.win32.join(root, "bin", "bash.exe"), path.win32.join(root, "usr", "bin", "bash.exe")].find(available)
  }

  export function requirePosix(shell: string, platform: NodeJS.Platform = process.platform) {
    if (platform !== "win32") return shell
    const name = path.win32.basename(shell).toLowerCase()
    if (
      ["bash", "bash.exe", "sh", "sh.exe", "zsh", "zsh.exe"].includes(name) &&
      !/[\\/](?:system32|sysnative|syswow64)[\\/]/i.test(shell)
    )
      return shell
    throw new Error(
      "Local compute jobs require Git Bash on Windows. Install Git for Windows or set OPENSCIENCE_GIT_BASH_PATH to its bash.exe; cmd.exe and PowerShell cannot execute the generated POSIX job script.",
    )
  }

  export function posix() {
    // A terminal may prefer cmd or PowerShell. Compute emits POSIX scripts
    // and must select Git Bash independently of that terminal preference.
    const shell = requirePosix(process.platform === "win32" ? fallback() : acceptable())
    if (process.platform === "win32" && !exists(shell)) {
      throw new Error(
        `Configured Git Bash was not found at ${shell}. Set OPENSCIENCE_GIT_BASH_PATH to an installed bash.exe.`,
      )
    }
    return shell
  }

  function fallback() {
    if (process.platform === "win32") {
      if (Flag.OPENSCIENCE_GIT_BASH_PATH) return Flag.OPENSCIENCE_GIT_BASH_PATH
      const bash = windowsGitBash(Bun.which("git"))
      if (bash) return bash
      return process.env.COMSPEC || "cmd.exe"
    }
    if (process.platform === "darwin") {
      if (exists("/bin/zsh")) return "/bin/zsh"
    }
    const bash = Bun.which("bash")
    if (bash) return bash
    if (exists("/bin/bash")) return "/bin/bash"
    return "/bin/sh"
  }

  export const preferred = lazy(() => {
    const s = process.env.SHELL
    if (s) return s
    return fallback()
  })

  export const acceptable = lazy(() => {
    const s = process.env.SHELL
    if (s && !BLACKLIST.has(process.platform === "win32" ? path.win32.basename(s) : path.basename(s))) return s
    return fallback()
  })

  /** The shell behind the model's `bash` tool. Models write bash, and zsh
   * (the login shell on macOS) is close but not the same: `status` is a
   * read-only variable there, so `status=$?` fails a script that runs
   * everywhere else. Bash when it is installed; the person's shell otherwise. */
  export const forTool = lazy(() => {
    if (process.platform === "win32") return acceptable()
    const bash = Bun.which("bash") ?? (exists("/bin/bash") ? "/bin/bash" : undefined)
    return bash ?? acceptable()
  })
}

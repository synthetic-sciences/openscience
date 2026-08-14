import { Flag } from "@/flag/flag"
import { lazy } from "@/util/lazy"
import path from "path"
import fs from "fs"
import { spawn, spawnSync, type ChildProcess } from "child_process"
import { WindowsJobLauncher } from "../process/windows-job-launcher"

const SIGKILL_TIMEOUT_MS = 200

export namespace Shell {
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

  function fallback() {
    if (process.platform === "win32") {
      if (Flag.OPENSCIENCE_GIT_BASH_PATH) return Flag.OPENSCIENCE_GIT_BASH_PATH
      const git = Bun.which("git")
      if (git) {
        // git.exe is typically at: C:\Program Files\Git\cmd\git.exe
        // bash.exe is at: C:\Program Files\Git\bin\bash.exe
        const bash = path.join(git, "..", "..", "bin", "bash.exe")
        if (Bun.file(bash).size) return bash
      }
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
}

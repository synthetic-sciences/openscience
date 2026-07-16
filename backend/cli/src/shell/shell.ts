import { Flag } from "@/flag/flag"
import { lazy } from "@/util/lazy"
import path from "path"
import fs from "fs"
import { spawn, spawnSync, type ChildProcess } from "child_process"

const SIGKILL_TIMEOUT_MS = 200

export namespace Shell {
  export async function killTree(
    proc: ChildProcess,
    opts?: { detached?: boolean; exited?: () => boolean },
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

    if (opts?.detached) {
      try {
        process.kill(-pid, "SIGTERM")
      } catch {}
      await Bun.sleep(SIGKILL_TIMEOUT_MS)
      // The group can outlive its leader. Always escalate against the group so
      // a worker that ignores SIGTERM cannot survive after `proc` has exited.
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

  /** Synchronous best-effort group SIGKILL for process-exit handlers. */
  export function killTreeSync(proc: ChildProcess, opts?: { detached?: boolean }): void {
    const pid = proc.pid
    if (!pid) return
    if (process.platform === "win32") {
      try {
        spawnSync("taskkill", ["/pid", String(pid), "/f", "/t"], { stdio: "ignore" })
      } catch {}
      return
    }
    if (opts?.detached) {
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

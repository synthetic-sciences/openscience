import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { DarwinResponsibilityLauncher } from "./darwin-responsibility-launcher"
import { ProcessIdentity } from "./process-identity"

export const WINDOWS_JOB_LAUNCHER_ARG = "__openscience_windows_job_launcher__"

export namespace WindowsJobLauncher {
  export interface Invocation {
    file: string
    args: string[]
    release?: string
  }

  export function wrap(input: {
    file: string
    args?: string[]
    shell?: boolean | string
    linuxOwner?: { pid: number; identity: string }
  }): Invocation {
    if (process.platform === "darwin") return DarwinResponsibilityLauncher.wrap(input)
    if (process.platform !== "win32" && !(process.platform === "linux" && input.linuxOwner)) {
      return { file: input.file, args: input.args ?? [] }
    }
    const release = path.join(os.tmpdir(), `openscience-job-release-${process.pid}-${crypto.randomUUID()}`)
    const executable = path.basename(process.execPath).toLowerCase()
    const sourceRuntime = executable === "bun" || executable === "bun.exe"
    const entry = fileURLToPath(new URL("../index.ts", import.meta.url))
    return {
      file: process.execPath,
      args: [
        ...(sourceRuntime ? [entry] : []),
        WINDOWS_JOB_LAUNCHER_ARG,
        release,
        ...(input.linuxOwner ? ["linux", String(input.linuxOwner.pid), input.linuxOwner.identity] : []),
        input.shell === true ? "1" : typeof input.shell === "string" ? input.shell : "0",
        input.file,
        ...(input.args ?? []),
      ],
      release,
    }
  }

  async function supervise(
    file: string,
    commandArgs: string[],
    shell: string,
    owner?: { pid: number; identity: string },
  ): Promise<number> {
    // Internal launchers enter through index.ts, whose static graph installs
    // the server's signal handlers. Replace those with this supervisor's
    // forwarding contract so a signal is not translated twice.
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.removeAllListeners(signal)
    const child = spawn(file, commandArgs, {
      cwd: process.cwd(),
      env: process.env,
      shell: shell === "1" ? true : shell === "0" ? false : shell,
      windowsHide: true,
      stdio: "inherit",
    })
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      process.on(signal, () => child.kill(signal))
    }
    const result = new Promise<number>((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolve(code ?? 1))
    })
    if (!owner) return result

    let settled = false
    let code = 1
    let failure: unknown
    void result.then(
      (value) => {
        settled = true
        code = value
      },
      (error) => {
        settled = true
        failure = error
      },
    )
    while (!settled) {
      if (!(await ProcessIdentity.owns(owner.pid, owner.identity))) {
        // The durable server owner disappeared. Kill the direct sandbox root;
        // bubblewrap's die-with-parent/PID namespace reaps every descendant
        // when this supervisor returns and exits immediately afterward.
        try {
          child.kill("SIGKILL")
        } catch {}
        return 137
      }
      await Bun.sleep(20)
    }
    if (failure) throw failure
    return code
  }

  async function runLinux(args: string[]): Promise<number> {
    const [release, , ownerText, ownerIdentity, shell, file, ...commandArgs] = args
    const owner = Number(ownerText)
    if (!release || !Number.isSafeInteger(owner) || owner <= 0 || !ownerIdentity || !shell || !file) {
      throw new Error("The Linux durable-launch gate requires an owner identity and command")
    }
    try {
      for (let attempt = 0; attempt < 3_000; attempt++) {
        const assigned = await fs.readFile(release, "utf8").catch(() => undefined)
        if (assigned?.trim() === String(process.pid)) {
          return supervise(file, commandArgs, shell, { pid: owner, identity: ownerIdentity })
        }
        // Before release, the launcher has inherited the prospective job's
        // old-root handles but cannot execute project code. If the server dies
        // in this registration window, exit silently so relocation can drain.
        if (!(await ProcessIdentity.owns(owner, ownerIdentity))) return 137
        await Bun.sleep(10)
      }
      return 124
    } finally {
      await fs.rm(release, { force: true }).catch(() => undefined)
    }
  }

  export async function run(args: string[]): Promise<number> {
    if (args[1] === "linux") return runLinux(args)
    const [release, shell, file, ...commandArgs] = args
    if (!release || !shell || !file)
      throw new Error("The Windows Job Object launcher requires a release marker and command")
    try {
      for (let attempt = 0; attempt < 3_000; attempt++) {
        const owner = await fs.readFile(release, "utf8").catch(() => undefined)
        if (owner?.trim() === String(process.pid)) break
        if (attempt === 2_999) throw new Error("Timed out waiting for durable Windows Job Object ownership")
        await Bun.sleep(10)
      }
      const child = spawn(file, commandArgs, {
        cwd: process.cwd(),
        env: process.env,
        shell: shell === "1" ? true : shell === "0" ? false : shell,
        windowsHide: true,
        stdio: "inherit",
      })
      for (const signal of ["SIGINT", "SIGTERM"] as const) {
        process.on(signal, () => child.kill(signal))
      }
      return new Promise<number>((resolve, reject) => {
        child.once("error", reject)
        child.once("exit", (code) => resolve(code ?? 1))
      })
    } finally {
      await fs.rm(release, { force: true }).catch(() => undefined)
    }
  }

  export async function release(file: string, pid: number): Promise<void> {
    await fs.writeFile(file, String(pid), { encoding: "utf8", flag: "wx", mode: 0o600 })
  }
}

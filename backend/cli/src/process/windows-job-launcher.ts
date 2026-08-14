import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { fileURLToPath } from "node:url"
import { DarwinResponsibilityLauncher } from "./darwin-responsibility-launcher"
import { ProcessIdentity } from "./process-identity"
import { LinuxSubreaper } from "./linux-subreaper"

export const WINDOWS_JOB_LAUNCHER_ARG = "__openscience_windows_job_launcher__"

const pendingLinuxLaunches = new Set<string>()
const linuxSubreapers = new WeakSet<ChildProcess>()

type ControlSignal = "SIGHUP" | "SIGINT" | "SIGTERM"

interface LinuxControl {
  readonly signal: ControlSignal | undefined
  readonly requested: Promise<ControlSignal>
}

function latchLinuxControl(): LinuxControl {
  let signal: ControlSignal | undefined
  let request: ((signal: ControlSignal) => void) | undefined
  const requested = new Promise<ControlSignal>((resolve) => {
    request = resolve
  })
  for (const candidate of ["SIGHUP", "SIGINT", "SIGTERM"] as const) {
    const inherited = process.listeners(candidate)
    process.on(candidate, () => {
      if (signal) return
      signal = candidate
      request?.(candidate)
    })
    // Install the containment latch first, then remove server handlers. There
    // is never a default-disposition window where a revoke can kill the gate.
    for (const listener of inherited) process.removeListener(candidate, listener as (...args: unknown[]) => void)
  }
  return {
    get signal() {
      return signal
    },
    requested,
  }
}

function signalExitCode(signal: ControlSignal): number {
  return signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 129
}

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
    if (process.platform === "linux" && input.linuxOwner) pendingLinuxLaunches.add(release)
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

  /** Bind the trusted server-side spawn handle to a release token minted by
   * wrap(). Project argv cannot forge this process-local WeakSet brand. */
  export function bind(process: ChildProcess, release?: string): void {
    if (!release || !pendingLinuxLaunches.delete(release)) return
    linuxSubreapers.add(process)
  }

  export function isLinuxSubreaper(process: ChildProcess): boolean {
    return linuxSubreapers.has(process)
  }

  async function supervise(
    file: string,
    commandArgs: string[],
    shell: string,
    owner: { pid: number; identity: string },
    subreaper: LinuxSubreaper.Handle,
    control: LinuxControl,
  ): Promise<number> {
    // Internal launchers enter through index.ts, whose static graph installs
    // the server's signal handlers. Replace those with this supervisor's
    // forwarding contract so a signal is not translated twice.
    const child = spawn(file, commandArgs, {
      cwd: process.cwd(),
      env: process.env,
      shell: shell === "1" ? true : shell === "0" ? false : shell,
      windowsHide: true,
      stdio: "inherit",
    })
    const result = new Promise<{ code: number; failure?: unknown }>((resolve) => {
      child.once("error", (failure) => resolve({ code: 1, failure }))
      child.once("exit", (code) => resolve({ code: code ?? 1 }))
    })
    if (!child.pid) {
      const outcome = await result
      if (outcome.failure) throw outcome.failure
      throw new Error("Linux child-subreaper launcher started a payload without a process id")
    }
    const primaryPID = child.pid
    let settled = false
    void result.then(() => {
      settled = true
    })
    let primary: string | undefined
    let paused: LinuxSubreaper.Paused[] | undefined
    while (!primary && !settled) {
      try {
        primary = await ProcessIdentity.capture(primaryPID)
      } catch {}
      if (primary || settled) break
      // Identity capture must fail closed while a live body exists. Stop the
      // complete current closure, not only the primary: it may already have
      // forked before the first /proc read. An already-delivered immediate
      // exit is handled below with its original status.
      paused ??= await subreaper.pause()
      primary = paused.find((member) => member.pid === primaryPID)?.identity
      await Bun.sleep(20)
    }
    if (!primary) {
      const outcome = await result
      await subreaper.drain()
      if (outcome.failure) throw outcome.failure
      return outcome.code
    }
    let ownerAlive: boolean | undefined
    while (ownerAlive === undefined && !settled && !control.signal) {
      try {
        ownerAlive = await ProcessIdentity.owns(owner.pid, owner.identity)
      } catch {
        // Do not let arbitrary code continue through an owner-authentication
        // outage. Quiesce first, then retry until the owner is proven live or
        // dead (or a control request chooses termination).
        paused ??= await subreaper.pause({ pid: primaryPID, identity: primary })
        await Bun.sleep(20)
      }
    }
    const ownerLost = ownerAlive === false
    if (paused && ownerAlive && !control.signal && !settled) {
      await subreaper.resume(paused)
      paused = undefined
    }
    const event = await Promise.race([
      result.then(() => "complete" as const),
      control.requested.then((signal) => ({ signal }) as const),
      (async () => {
        if (ownerLost) return "owner-lost" as const
        while (!settled) {
          try {
            if (!(await ProcessIdentity.owns(owner.pid, owner.identity))) return "owner-lost" as const
          } catch {
            const stopped = await subreaper.pause({ pid: primaryPID, identity: primary })
            while (!settled) {
              if (control.signal) return { signal: control.signal } as const
              try {
                if (!(await ProcessIdentity.owns(owner.pid, owner.identity))) return "owner-lost" as const
                await subreaper.resume(stopped)
                break
              } catch {
                await Bun.sleep(20)
              }
            }
          }
          await Bun.sleep(20)
        }
        return "complete" as const
      })(),
    ])
    if (event === "owner-lost" || typeof event === "object") {
      await subreaper.terminate({ pid: primaryPID, identity: primary })
    }
    const outcome = await result
    // Once Bun has delivered the managed primary's exit status it is safe to
    // waitpid() every child adopted by this verified subreaper. This closes
    // both setsid and double-fork escapes before the launcher can return.
    await subreaper.drain()
    if (event === "owner-lost") return 137
    if (typeof event === "object") return signalExitCode(event.signal)
    if (outcome.failure) throw outcome.failure
    return outcome.code
  }

  async function runLinux(args: string[]): Promise<number> {
    const [release, , ownerText, ownerIdentity, shell, file, ...commandArgs] = args
    const owner = Number(ownerText)
    if (!release || !Number.isSafeInteger(owner) || owner <= 0 || !ownerIdentity || !shell || !file) {
      throw new Error("The Linux durable-launch gate requires an owner identity and command")
    }
    let subreaper: LinuxSubreaper.Handle | undefined
    try {
      // This is established and kernel-verified before project code can run.
      // If prctl or /proc containment is unavailable, activation throws and
      // the body is never spawned.
      subreaper = LinuxSubreaper.activate()
      const control = latchLinuxControl()
      for (let attempt = 0; attempt < 3_000; attempt++) {
        if (control.signal) return signalExitCode(control.signal)
        const assigned = await fs.readFile(release, "utf8").catch(() => undefined)
        if (assigned?.trim() === String(process.pid)) {
          return supervise(file, commandArgs, shell, { pid: owner, identity: ownerIdentity }, subreaper, control)
        }
        // Before release, the launcher has inherited the prospective job's
        // old-root handles but cannot execute project code. If the server dies
        // in this registration window, exit silently so relocation can drain.
        if (!(await ProcessIdentity.owns(owner, ownerIdentity))) return 137
        await Bun.sleep(10)
      }
      return 124
    } finally {
      subreaper?.close()
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

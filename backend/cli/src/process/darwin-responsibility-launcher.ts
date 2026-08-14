import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"
import { fileURLToPath } from "node:url"
import { DarwinResponsibility } from "./darwin-responsibility"

export const DARWIN_RESPONSIBILITY_LAUNCHER_ARG = "__openscience_darwin_responsibility_launcher__"
const SUPERVISE = "supervise"
export const DARWIN_RESPONSIBILITY_ACTIVATION_SUFFIX = ".owned"

/**
 * A two-stage Darwin launcher.
 *
 * Stage one waits until the durable ledger entry exists. It then uses
 * POSIX_SPAWN_SETEXEC + responsibility_spawnattrs_setdisclaim to replace
 * itself at the same PID with stage two as an independent kernel
 * responsibility root. Stage two remains alive until every responsibility
 * member exits, so setsid()+double-fork cannot escape by reparenting to
 * launchd. It also observes the exact start identity of the owning server and
 * reaps the tree if that server is killed.
 */
export namespace DarwinResponsibilityLauncher {
  export interface Invocation {
    file: string
    args: string[]
    release?: string
  }

  function sourceArgs(): string[] {
    const executable = path.basename(process.execPath).toLowerCase()
    const sourceRuntime = executable === "bun" || executable === "bun.exe"
    const entry = fileURLToPath(new URL("../index.ts", import.meta.url))
    return sourceRuntime ? [entry] : []
  }

  export function wrap(input: {
    file: string
    args?: string[]
    shell?: boolean | string
    /** Marker written after optional session creation but before ledger release. */
    ready?: string
    /** Create an owned POSIX session when the spawning API has no detached flag. */
    ownSession?: boolean
  }): Invocation {
    if (process.platform !== "darwin") return { file: input.file, args: input.args ?? [] }
    const ownerIdentity = DarwinResponsibility.identity(process.pid)
    if (!ownerIdentity) throw new Error(`Could not capture macOS owner identity for process ${process.pid}`)
    const release = path.join(os.tmpdir(), `openscience-responsibility-release-${process.pid}-${crypto.randomUUID()}`)
    return {
      file: process.execPath,
      args: [
        ...sourceArgs(),
        DARWIN_RESPONSIBILITY_LAUNCHER_ARG,
        release,
        input.ready ?? "-",
        input.ownSession ? "1" : "0",
        input.shell === true ? "1" : typeof input.shell === "string" ? input.shell : "0",
        String(process.pid),
        ownerIdentity,
        input.file,
        ...(input.args ?? []),
      ],
      release,
    }
  }

  async function waitForRelease(file: string): Promise<void> {
    for (let attempt = 0; attempt < 3_000; attempt++) {
      const owner = await fs.readFile(file, "utf8").catch(() => undefined)
      if (owner?.trim() === String(process.pid)) return
      if (attempt === 2_999) throw new Error("Timed out waiting for durable macOS responsibility ownership")
      await Bun.sleep(10)
    }
  }

  async function reapOwned(): Promise<void> {
    // The responsibility root is the durable containment marker owner. It may
    // not exit while any member could still be alive, even when enumeration or
    // signalling fails transiently. The external ledger has its own bounded
    // wait and retains ownership on timeout; this supervisor deliberately has
    // no timeout and keeps retrying until it observes an empty responsibility.
    while (true) {
      const owner = DarwinResponsibility.unique(process.pid)
      if (!owner) {
        await Bun.sleep(20)
        continue
      }
      const members = (() => {
        try {
          return DarwinResponsibility.uniqueMembers(owner).filter((pid) => pid !== process.pid)
        } catch {
          return
        }
      })()
      if (!members) {
        await Bun.sleep(20)
        continue
      }
      if (!members.length) return
      for (const pid of members) {
        try {
          if (!DarwinResponsibility.uniquelyOwns(owner, pid)) continue
          process.kill(pid, "SIGKILL")
        } catch {}
      }
      await Bun.sleep(20)
    }
  }

  async function supervise(args: string[]): Promise<number> {
    const [activation, shell, ownerText, ownerIdentity, file, ...commandArgs] = args
    const owner = Number(ownerText)
    if (!activation || !shell || !Number.isSafeInteger(owner) || owner <= 0 || !ownerIdentity || !file) {
      throw new Error("The macOS responsibility supervisor received an invalid launch contract")
    }
    if (DarwinResponsibility.responsible(process.pid) !== process.pid || !DarwinResponsibility.unique(process.pid)) {
      throw new Error(`Process ${process.pid} did not become an independent macOS responsibility root`)
    }
    // The source launcher enters through index.ts, whose static module graph
    // installs the server's normal SIGINT/SIGTERM exit hooks. Those hooks are
    // correct for a server, but would make this internal supervisor exit with
    // 130 before it can forward an interrupt to a persistent kernel. Replace
    // them with the supervisor-specific forwarding contract below.
    for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) process.removeAllListeners(signal)
    let child: ReturnType<typeof spawn> | undefined
    let interruptPending = false
    let teardownSignal: "SIGHUP" | "SIGTERM" | undefined
    let requestTeardown: ((signal: "SIGHUP" | "SIGTERM") => void) | undefined
    const teardownRequested = new Promise<"SIGHUP" | "SIGTERM">((resolve) => {
      requestTeardown = resolve
    })
    const forward = (signal: NodeJS.Signals) => {
      if (!child) {
        if (signal === "SIGINT") interruptPending = true
        return
      }
      try {
        // Forward exactly once to the payload leader. Responsibility teardown
        // remains the descendant-wide hard-stop path; broad group delivery
        // here can make runtime wrappers and their interpreter both translate
        // the same interrupt.
        child.kill(signal)
      } catch {}
    }
    // Install the supervisor latches synchronously before activation can admit
    // project code. TERM/HUP only record a control request; this responsibility
    // root remains alive to reap. SIGINT remains a payload-only interrupt and
    // is delivered once if it arrives just before the payload is spawned.
    process.on("SIGINT", () => forward("SIGINT"))
    for (const signal of ["SIGHUP", "SIGTERM"] as const) {
      process.on(signal, () => {
        if (teardownSignal) return
        teardownSignal = signal
        requestTeardown?.(signal)
      })
    }
    const latchReady = process.env.OPENSCIENCE_DARWIN_SUPERVISOR_TEST_READY
    if (process.env.OPENSCIENCE_TEST_HOME && latchReady) {
      await fs.writeFile(latchReady, String(process.pid), { encoding: "utf8", flag: "wx", mode: 0o600 })
    }
    // Do not expose project code until the durable ledger has persisted the
    // kernel responsibility unique ID. If registration fails, the supervisor
    // is still an empty process-group root that can be safely torn down.
    try {
      const event = await Promise.race([
        waitForRelease(activation).then(() => "activated" as const),
        teardownRequested.then(() => "teardown" as const),
      ])
      if (event === "teardown") {
        await reapOwned()
        return teardownSignal === "SIGTERM" ? 143 : 129
      }
    } finally {
      await fs.rm(activation, { force: true }).catch(() => undefined)
    }

    if (teardownSignal) {
      await reapOwned()
      return teardownSignal === "SIGTERM" ? 143 : 129
    }
    try {
      child = spawn(file, commandArgs, {
        cwd: process.cwd(),
        env: process.env,
        shell: shell === "1" ? true : shell === "0" ? false : shell,
        stdio: "inherit",
        // Keep the responsibility supervisor out of the payload's process
        // group. Callers signal the registered supervisor group; if the
        // payload shared it, it would receive that signal once from the
        // kernel and a second time from the forwarding handler below.
        // Responsibility ownership is independent of POSIX process groups,
        // so a new payload session preserves exact descendant containment.
        detached: true,
      })
    } catch (error) {
      await reapOwned()
      throw error
    }
    const result = new Promise<number>((resolve, reject) => {
      child.once("error", reject)
      child.once("exit", (code, signal) => resolve(code ?? (signal ? 128 : 1)))
    })
    if (interruptPending) forward("SIGINT")

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
    while (true) {
      if (DarwinResponsibility.identity(owner) !== ownerIdentity) {
        await reapOwned()
        return 137
      }
      if (teardownSignal) {
        await reapOwned()
        return teardownSignal === "SIGTERM" ? 143 : 129
      }
      if (settled) {
        // A normal command completion is also a lifecycle boundary. Reap any
        // background or fully reparented members before reporting the command
        // complete, matching the durable ledger's completion contract.
        await reapOwned()
        if (failure) throw failure
        return code
      }
      await Bun.sleep(20)
    }
  }

  export async function run(args: string[]): Promise<number> {
    if (process.platform !== "darwin") throw new Error("The macOS responsibility launcher requires Darwin")
    if (args[0] === SUPERVISE) return supervise(args.slice(1))

    const [release, ready, ownSession, shell, owner, ownerIdentity, file, ...commandArgs] = args
    if (!release || !ready || !ownSession || !shell || !owner || !ownerIdentity || !file) {
      throw new Error("The macOS responsibility launcher requires a release marker and command")
    }
    if (ownSession === "1") {
      const session = DarwinResponsibility.startSession()
      if (session !== process.pid) {
        throw new Error(`Could not establish an owned macOS process group (setsid returned ${session})`)
      }
    } else if (ownSession !== "0") {
      throw new Error("The macOS responsibility launcher received an invalid session contract")
    }
    if (ready !== "-") {
      await fs.writeFile(ready, String(process.pid), { encoding: "utf8", flag: "wx", mode: 0o600 })
    }
    try {
      await waitForRelease(release)
    } finally {
      await fs.rm(release, { force: true }).catch(() => undefined)
    }
    DarwinResponsibility.execSelfResponsible({
      file: process.execPath,
      args: [
        ...sourceArgs(),
        DARWIN_RESPONSIBILITY_LAUNCHER_ARG,
        SUPERVISE,
        `${release}${DARWIN_RESPONSIBILITY_ACTIVATION_SUFFIX}`,
        shell,
        owner,
        ownerIdentity,
        file,
        ...commandArgs,
      ],
      env: process.env,
    })
  }
}

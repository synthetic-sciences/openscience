import type { ChildProcess } from "node:child_process"
import z from "zod"
import { CredentialProcessLedger } from "../../credentials/process-ledger"
import { ProcessIdentity } from "../../process/process-identity"
import { WindowsJobLauncher } from "../../process/windows-job-launcher"

export const CommandStatus = z.object({
  id: z.string(),
  projectID: z.string(),
  sessionID: z.string(),
  messageID: z.string(),
  callID: z.string().optional(),
  description: z.string(),
  command: z.string(),
  state: z.literal("running"),
  process_id: z.number().int(),
  started_at: z.number().int(),
  resources: z
    .object({
      cpu_percent: z.number(),
      memory_bytes: z.number().int(),
    })
    .partial()
    .optional(),
})
export type CommandStatus = z.infer<typeof CommandStatus>

type Entry = CommandStatus & {
  process: ChildProcess
  stop: () => Promise<void>
  linuxSubreaper: boolean
}

const entries = new Map<string, Entry>()

export namespace CommandRuntime {
  /** Keep command bodies behind a Linux owner gate until their process group
   * is durably registered. This closes the spawn/register race for commands
   * that exit before the ledger write completes while retaining the existing
   * Windows Job Object and macOS responsibility launchers. */
  export async function wrap(input: Omit<Parameters<typeof WindowsJobLauncher.wrap>[0], "linuxOwner">) {
    const launch = input
    const linuxOwner =
      globalThis.process.platform === "linux"
        ? await ProcessIdentity.capture(globalThis.process.pid).then((identity) =>
            identity ? { pid: globalThis.process.pid, identity } : undefined,
          )
        : undefined
    if (globalThis.process.platform === "linux" && !linuxOwner) {
      throw new Error("Could not capture the Linux server identity for command launch")
    }
    const wrapped = WindowsJobLauncher.wrap({ ...launch, linuxOwner })
    return {
      ...wrapped,
      // A launcher with a release gate encodes the requested shell inside its
      // argv. Spawning that launcher through another shell would register the
      // outer shell PID and leave the actual gate waiting on a different PID.
      spawnShell: wrapped.release ? false : launch.shell,
    }
  }

  export async function start(
    input: Omit<CommandStatus, "id" | "state" | "process_id" | "started_at" | "resources">,
    process: ChildProcess,
    stop: () => Promise<void>,
    options: { authorityGeneration?: string; windowsRelease?: string } = {},
  ) {
    if (!process.pid) throw new Error("Shell command started without a process id")
    const bound = WindowsJobLauncher.bind(process, options.windowsRelease)
    const subreaper = globalThis.process.platform === "linux" && bound && WindowsJobLauncher.isLinuxSubreaper(process)
    if (globalThis.process.platform === "linux" && !subreaper) {
      await stop()
      throw new Error("Linux command was not launched behind the verified child-subreaper registration gate")
    }
    const value: Entry = {
      ...input,
      id: `command-${crypto.randomUUID()}`,
      state: "running",
      process_id: process.pid,
      started_at: Date.now(),
      process,
      stop,
      linuxSubreaper: subreaper,
    }
    let completed = false
    const complete = () => {
      completed = true
      entries.delete(value.id)
      // Never discard durable ownership merely because the group leader
      // exited. `complete` authenticates and reaps any same-PGID background
      // descendants before it removes the ledger entry; on failure the entry
      // remains available to trust/session/credential revocation.
      void CredentialProcessLedger.complete(value.id).catch(() => undefined)
    }
    process.once("exit", complete)
    process.once("error", complete)
    if (
      globalThis.process.env.OPENSCIENCE_TEST_HOME &&
      globalThis.process.env.OPENSCIENCE_COMMAND_TEST_REGISTRATION_FAILURE
    ) {
      await stop()
      throw new Error("Injected command registration failure")
    }
    const registered = await CredentialProcessLedger.register({
      id: value.id,
      kind: "command",
      pid: value.process_id,
      detached: globalThis.process.platform !== "win32",
      projectID: value.projectID,
      sessionID: value.sessionID,
      authorityGeneration: options.authorityGeneration,
      windowsRelease: options.windowsRelease,
      ...(value.linuxSubreaper ? { subreaper: process } : {}),
    })
    if (!registered) {
      await stop()
      throw new Error("Command exited before durable process-group ownership could be established")
    }
    if (globalThis.process.platform === "linux" && options.windowsRelease) {
      try {
        await WindowsJobLauncher.release(options.windowsRelease, value.process_id)
      } catch (error) {
        const failures: unknown[] = []
        await CredentialProcessLedger.revoke(
          { id: value.id, kind: "command", projectID: value.projectID, sessionID: value.sessionID },
          {
            onPinned: async (id) => {
              if (id === value.id) await stop()
            },
          },
        ).catch((failure) => failures.push(failure))
        if (!value.linuxSubreaper) await stop().catch((failure) => failures.push(failure))
        if (failures.length) {
          throw new AggregateError([error, ...failures], "Command launch ownership cleanup failed")
        }
        throw error
      }
    }
    if (completed) {
      await CredentialProcessLedger.complete(value.id)
      return value
    }
    entries.set(value.id, value)
    return value
  }

  export function finish(id: string) {
    entries.delete(id)
    void CredentialProcessLedger.complete(id).catch(() => undefined)
  }

  /** Await durable normal-exit cleanup before a caller accepts output or
   * releases a sandbox that same-group descendants could still access. */
  export async function settle(id: string) {
    entries.delete(id)
    const complete = await CredentialProcessLedger.complete(id)
    if (!complete) throw new Error(`Command ${id} is still running and cannot be settled`)
  }

  export function list(projectID: string, sessionID?: string): CommandStatus[] {
    return [...entries.values()]
      .filter((value) => value.projectID === projectID && (!sessionID || value.sessionID === sessionID))
      .map(({ process: _process, stop: _stop, linuxSubreaper: _linuxSubreaper, ...value }) => value)
      .toSorted((a, b) => b.started_at - a.started_at)
  }

  export function owned(id: string, projectID: string, sessionID: string) {
    const value = entries.get(id)
    if (!value || value.projectID !== projectID || value.sessionID !== sessionID) return
    return value
  }

  export async function stop(id: string, projectID: string, sessionID: string) {
    const value = owned(id, projectID, sessionID)
    if (!value) return false
    let stopped = false
    const stop = async () => {
      if (stopped) return
      stopped = true
      await value.stop()
    }
    await CredentialProcessLedger.revoke(
      { id: value.id, kind: "command", projectID, sessionID },
      {
        onPinned: async (entryID) => {
          if (entryID === value.id) await stop()
        },
      },
    )
    await stopEntry(value, stop)
    return true
  }

  async function stopEntry(value: Entry, stop: () => Promise<void> = value.stop): Promise<void> {
    if (!value.linuxSubreaper) await stop()
    if (value.process.exitCode !== null || value.process.signalCode !== null) return
    await new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer)
        value.process.off("exit", done)
        value.process.off("error", failed)
        resolve()
      }
      const failed = (error: Error) => {
        clearTimeout(timer)
        value.process.off("exit", done)
        value.process.off("error", failed)
        reject(error)
      }
      const timer = setTimeout(() => {
        value.process.off("exit", done)
        value.process.off("error", failed)
        reject(new Error(`Command ${value.id} did not exit after revocation`))
      }, 2_000)
      timer.unref()
      value.process.once("exit", done)
      value.process.once("error", failed)
    })
  }

  async function stopMatching(
    scope: CredentialProcessLedger.Scope,
    matches: (value: Entry) => boolean,
  ): Promise<number> {
    const targets = [...entries.values()].filter(matches)
    // Durable teardown must enumerate the leader's live descendant closure
    // before a competing best-effort stop can kill the leader and reparent a
    // setsid child outside that closure.
    const targetsByID = new Map(targets.map((value) => [value.id, value]))
    const stopped = new Set<string>()
    const stop = async (value: Entry) => {
      if (stopped.has(value.id)) return
      stopped.add(value.id)
      await value.stop()
    }
    const recovered = await CredentialProcessLedger.revoke(
      { kind: "command", ...scope },
      {
        onPinned: async (id) => {
          const value = targetsByID.get(id)
          if (value) await stop(value)
        },
      },
    )
    const results = await Promise.allSettled(targets.map((value) => stopEntry(value, () => stop(value))))
    const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
    if (failures.length) throw new AggregateError(failures, "Commands could not be revoked")
    return Math.max(recovered, targets.length)
  }

  export function stopSession(projectID: string, sessionID: string) {
    return stopMatching(
      { projectID, sessionID },
      (value) => value.projectID === projectID && value.sessionID === sessionID,
    )
  }

  export function stopProject(projectID: string) {
    return stopMatching({ projectID }, (value) => value.projectID === projectID)
  }

  /** Stop every live Bash command before a credential mutation is acknowledged.
   * Unlike project/session cleanup, this is fail-closed: a stop callback that
   * rejects or a child that remains alive after SIGKILL blocks reconciliation
   * so the process cannot continue with a stale inherited environment. */
  export async function stopAll(): Promise<number> {
    return stopMatching({}, () => true)
  }
}

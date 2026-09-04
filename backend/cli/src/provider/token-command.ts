import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { Config } from "../config/config"
import { CredentialLifecycle } from "../credentials/lifecycle"
import { CredentialProcessLedger } from "../credentials/process-ledger"
import { CredentialRevocation } from "../credentials/revocation"
import { OpenScience } from "../openscience"
import { ProcessIdentity } from "../process/process-identity"
import { WindowsJobLauncher } from "../process/windows-job-launcher"
import { AuthoritySignal } from "../project/authority-signal"
import { Instance } from "../project/instance"
import { ProjectTrust } from "../project/trust"
import { Sandbox } from "../sandbox/sandbox"
import { Shell } from "../shell/shell"

/**
 * Governed execution boundary for provider `tokenCommand` helpers.
 *
 * A token helper is project-controlled code at the exact moment it can mint a
 * bearer credential. It therefore gets neither the server's ambient secrets
 * nor an unowned process. The command is admitted under the trust and
 * credential revision barriers, sandboxed with the machine policy, durably
 * registered before its launcher gate opens, and bounded in time and output.
 */
export namespace ProviderTokenCommand {
  export const DEFAULT_TIMEOUT_MS = 15_000
  export const MAX_STDOUT_BYTES = 64 * 1024
  export const MAX_STDERR_BYTES = 32 * 1024

  const POSIX_ENV = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_RUNTIME_DIR",
    "AWS_PROFILE",
    "AWS_DEFAULT_PROFILE",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_CONFIG_FILE",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AZURE_CONFIG_DIR",
    "CLOUDSDK_CONFIG",
    "CLOUDSDK_ACTIVE_CONFIG_NAME",
    "GH_HOST",
    "KUBECONFIG",
  ])
  const WINDOWS_ENV = new Set([
    ...POSIX_ENV,
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "TEMP",
    "TMP",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
  ])

  interface ActiveState {
    projectID: string
    ids: Set<string>
  }

  const active = Instance.state<ActiveState>(
    () => ({ projectID: Instance.project.id, ids: new Set() }),
    async (state) => {
      const results = await Promise.allSettled(
        [...state.ids].map((id) =>
          CredentialProcessLedger.revoke({ id, kind: "provider", projectID: state.projectID }),
        ),
      )
      state.ids.clear()
      const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []))
      if (failures.length) throw new AggregateError(failures, "Provider token commands could not be revoked")
    },
  )

  export interface RunOptions {
    command: string
    projectDeclared: boolean
    timeoutMs?: number
    maxStdoutBytes?: number
    maxStderrBytes?: number
  }

  interface Launched {
    child: ChildProcess
    completion: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
    id: string
    state: ActiveState
    sandbox: Sandbox.Plan
  }

  /** A deliberately small environment for credential-minting helpers. Cloud
   * profile selectors and config paths are allowed; provider/API secret vars,
   * dynamic-loader injection, language startup injection, and OpenScience
   * control-plane variables are not. */
  export function environment(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
    const allowed = process.platform === "win32" ? WINDOWS_ENV : POSIX_ENV
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(source)) {
      if (!value) continue
      const normalized = process.platform === "win32" ? key.toUpperCase() : key
      if (normalized.startsWith("LC_") || allowed.has(normalized)) result[key] = value
    }
    return {
      ...result,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    }
  }

  function credentialRoots(env: Record<string, string>): string[] {
    const home = env.HOME || env.USERPROFILE
    const roots = new Set<string>()
    const add = (value?: string) => {
      if (!value) return
      const resolved = path.resolve(value)
      if (path.isAbsolute(resolved)) roots.add(resolved)
    }
    if (home) {
      add(path.join(home, ".aws"))
      add(path.join(home, ".azure"))
      add(path.join(home, ".config", "gcloud"))
      add(path.join(home, ".config", "gh"))
      add(path.join(home, ".kube"))
    }
    for (const key of [
      "AWS_CONFIG_FILE",
      "AWS_SHARED_CREDENTIALS_FILE",
      "AZURE_CONFIG_DIR",
      "CLOUDSDK_CONFIG",
      "KUBECONFIG",
    ]) {
      add(env[key])
    }
    return [...roots]
  }

  function outsideRoots(value: string, roots: string[]): boolean {
    const exact = path.resolve(value)
    return !roots.some((root) => exact === root || exact.startsWith(root + path.sep))
  }

  function shell(): string {
    if (process.platform === "win32") return process.env.ComSpec || process.env.COMSPEC || "cmd.exe"
    return "/bin/sh"
  }

  function output(stream: NodeJS.ReadableStream, limit: number, name: "stdout" | "stderr"): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let size = 0
      let settled = false
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        reject(error)
      }
      stream.on("data", (value: Buffer | string) => {
        if (settled) return
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
        size += chunk.length
        if (size > limit) {
          fail(new Error(`tokenCommand ${name} exceeded ${limit} bytes`))
          return
        }
        chunks.push(chunk)
      })
      stream.once("error", fail)
      stream.once("end", () => {
        if (settled) return
        settled = true
        resolve(Buffer.concat(chunks, size).toString("utf8"))
      })
    })
  }

  async function rawStop(child: ChildProcess, detached: boolean): Promise<void> {
    await Shell.killTree(child, {
      detached,
      exited: () => child.exitCode !== null || child.signalCode !== null,
    })
  }

  async function launch(input: RunOptions): Promise<Launched> {
    return AuthoritySignal.exclusive(async () => {
      if (input.projectDeclared) await ProjectTrust.require(Instance.project, "provider_token_command")
      return CredentialLifecycle.admit(async () => {
        // The credential barrier may have awaited another server's mutation;
        // trust is rechecked afterward while the authority lease is still held.
        if (input.projectDeclared) await ProjectTrust.require(Instance.project, "provider_token_command")

        const env = environment()
        const readable = credentialRoots(env)
        const policy = await Config.trustedSandbox()
        const sandbox = Sandbox.plan({
          command: input.command,
          shell: shell(),
          cwd: Instance.directory,
          workspace: [Instance.directory, Instance.worktree],
          readable,
          unreadable: OpenScience.kernelSensitivePaths().filter((value) => outsideRoots(value, readable)),
          options: policy,
        })
        const linuxOwner =
          process.platform === "linux"
            ? await ProcessIdentity.capture(process.pid).then((identity) =>
                identity ? { pid: process.pid, identity } : undefined,
              )
            : undefined
        if (process.platform === "linux" && !linuxOwner) {
          Sandbox.cleanup(sandbox)
          throw new Error("Could not capture the Linux server identity for tokenCommand launch")
        }
        const wrapped = WindowsJobLauncher.wrap({
          file: sandbox.file,
          args: sandbox.args ?? [],
          shell: sandbox.sandboxed ? false : sandbox.useShell,
          linuxOwner,
        })
        let child: ChildProcess
        try {
          child = spawn(wrapped.file, wrapped.args, {
            cwd: Instance.directory,
            env,
            shell: false,
            detached: process.platform !== "win32",
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
          })
          WindowsJobLauncher.bind(child, wrapped.release)
        } catch (error) {
          Sandbox.cleanup(sandbox)
          throw error
        }
        const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
          child.once("error", reject)
          child.once("close", (code, signal) => resolve({ code, signal }))
        })
        const id = `provider-token-${crypto.randomUUID()}`
        const state = active()
        try {
          const registered = await CredentialProcessLedger.register({
            id,
            kind: "provider",
            pid: child.pid!,
            detached: process.platform !== "win32",
            projectID: Instance.project.id,
            windowsRelease: wrapped.release,
          })
          if (!registered) throw new Error("tokenCommand exited before durable process registration")
          // The generic ledger owns Windows and Darwin gate release because it
          // must persist their kernel ownership handles first. Linux has no Job
          // handle to assign, but still uses the same pre-exec server-identity
          // gate so even a one-shot `echo` cannot beat durable registration.
          if (process.platform === "linux" && wrapped.release) {
            await WindowsJobLauncher.release(wrapped.release, child.pid!)
          }
          state.ids.add(id)
          return { child, completion, id, state, sandbox }
        } catch (error) {
          const failures: unknown[] = []
          await CredentialProcessLedger.revoke({ id }).catch((failure) => failures.push(failure))
          await rawStop(child, process.platform !== "win32").catch((failure) => failures.push(failure))
          Sandbox.cleanup(sandbox)
          if (failures.length) {
            throw new AggregateError([error, ...failures], "tokenCommand launch ownership cleanup failed")
          }
          throw error
        }
      })
    })
  }

  export async function run(input: RunOptions): Promise<string> {
    if (!input.command.trim()) throw new Error("tokenCommand must not be empty")
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxStdout = input.maxStdoutBytes ?? MAX_STDOUT_BYTES
    const maxStderr = input.maxStderrBytes ?? MAX_STDERR_BYTES
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error("tokenCommand timeout must be positive")
    if (!Number.isSafeInteger(maxStdout) || maxStdout <= 0)
      throw new Error("tokenCommand stdout limit must be positive")
    if (!Number.isSafeInteger(maxStderr) || maxStderr <= 0)
      throw new Error("tokenCommand stderr limit must be positive")

    const launched = await launch(input)
    const streams = Promise.all([
      output(launched.child.stdout!, maxStdout, "stdout"),
      output(launched.child.stderr!, maxStderr, "stderr"),
    ])
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`tokenCommand timed out after ${timeoutMs}ms`)), timeoutMs)
    })
    let normal = false
    let bodyFailure: unknown
    try {
      const [[stdout, stderr], settled] = await Promise.race([Promise.all([streams, launched.completion]), timeout])
      normal = true
      if (settled.code !== 0) {
        const status = settled.code === null ? `signal ${settled.signal ?? "unknown"}` : `exit ${settled.code}`
        throw new Error(`tokenCommand ${status}: ${OpenScience.redactSecrets(stderr.trim()) || "no stderr"}`)
      }
      const token = stdout.trim()
      if (!token) throw new Error("tokenCommand produced no output")
      return token
    } catch (error) {
      bodyFailure = error
      if (!normal) {
        const failures: unknown[] = []
        await CredentialProcessLedger.revoke({ id: launched.id, kind: "provider" }).catch((failure) =>
          failures.push(failure),
        )
        await rawStop(launched.child, process.platform !== "win32").catch((failure) => failures.push(failure))
        if (failures.length) {
          throw new AggregateError([error, ...failures], "tokenCommand process cleanup failed")
        }
      }
      throw error
    } finally {
      if (timer) clearTimeout(timer)
      launched.state.ids.delete(launched.id)
      if (normal) {
        try {
          const complete = await CredentialProcessLedger.complete(launched.id)
          if (!complete) await CredentialProcessLedger.revoke({ id: launched.id, kind: "provider" })
        } catch (cleanupFailure) {
          if (bodyFailure) {
            throw new AggregateError([bodyFailure, cleanupFailure], "tokenCommand completion cleanup failed")
          }
          throw cleanupFailure
        }
      }
      Sandbox.cleanup(launched.sandbox)
    }
  }

  export function revoke(projectID?: string): Promise<number> {
    return CredentialProcessLedger.revoke({ kind: "provider", ...(projectID ? { projectID } : {}) })
  }
}

// Credential rotations from this or another server revoke an in-flight helper
// before any new helper is admitted against the refreshed snapshot. An expired
// synced overlay reaches only helpers that inherited it.
CredentialLifecycle.onRevoke(async ({ reason }) => {
  await CredentialProcessLedger.revoke({ kind: "provider", ...CredentialRevocation.scope(reason) })
})

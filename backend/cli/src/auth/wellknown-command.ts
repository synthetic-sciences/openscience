import os from "node:os"
import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { Config } from "../config/config"
import { CredentialLifecycle } from "../credentials/lifecycle"
import { CredentialProcessLedger } from "../credentials/process-ledger"
import { OpenScience } from "../openscience"
import { ProcessIdentity } from "../process/process-identity"
import { WindowsJobLauncher } from "../process/windows-job-launcher"
import { Instance } from "../project/instance"
import { Sandbox } from "../sandbox/sandbox"
import { Shell } from "../shell/shell"

/**
 * Executes a command returned by an unsigned well-known document only after
 * the CLI has obtained an explicit, local approval for its exact argv.
 *
 * This runner deliberately has no approval UI of its own. Keeping consent in
 * the CLI and execution here makes it impossible for a network response to
 * accidentally become ambient local execution through another call site.
 */
export namespace WellKnownAuthCommand {
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

  export interface RunOptions {
    argv: string[]
    timeoutMs?: number
    maxStdoutBytes?: number
    maxStderrBytes?: number
  }

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
      roots.add(path.resolve(value))
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

  function collect(stream: NodeJS.ReadableStream, limit: number, label: string): Promise<string> {
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
        if (size > limit) return fail(new Error(`Well-known auth ${label} exceeded ${limit} bytes`))
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

  async function stop(child: ChildProcess): Promise<void> {
    await Shell.killTree(child, {
      detached: process.platform !== "win32",
      exited: () => child.exitCode !== null || child.signalCode !== null,
    })
  }

  export async function run(input: RunOptions): Promise<string> {
    if (!input.argv.length || input.argv.some((value) => !value || value.includes("\0"))) {
      throw new Error("Well-known auth command contains an invalid argv")
    }
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const maxStdout = input.maxStdoutBytes ?? MAX_STDOUT_BYTES
    const maxStderr = input.maxStderrBytes ?? MAX_STDERR_BYTES
    for (const [label, value] of [
      ["timeout", timeoutMs],
      ["stdout limit", maxStdout],
      ["stderr limit", maxStderr],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Well-known auth ${label} must be positive`)
    }

    // Hold the shared credential mutation lease for the whole short-lived
    // helper. A second server cannot rotate the credential snapshot midway
    // through token acquisition, and this CLI mutates auth.json only afterward.
    return CredentialLifecycle.admit(async () => {
      const env = environment()
      const readable = credentialRoots(env)
      const policy = await Config.trustedSandbox()
      const sandbox = Sandbox.wrapArgv({
        file: input.argv[0]!,
        args: input.argv.slice(1),
        workspace: [],
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
        throw new Error("Could not capture the Linux server identity for well-known auth launch")
      }
      const wrapped = WindowsJobLauncher.wrap({ file: sandbox.file, args: sandbox.args, linuxOwner })
      let child: ChildProcess
      try {
        child = spawn(wrapped.file, wrapped.args, {
          cwd: os.tmpdir(),
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

      const id = `wellknown-auth-${crypto.randomUUID()}`
      const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
        child.once("error", reject)
        child.once("close", (code, signal) => resolve({ code, signal }))
      })
      let registered = false
      let normal = false
      let timer: ReturnType<typeof setTimeout> | undefined
      let bodyFailure: unknown
      try {
        registered = await CredentialProcessLedger.register({
          id,
          kind: "provider",
          pid: child.pid!,
          detached: process.platform !== "win32",
          projectID: Instance.project.id,
          windowsRelease: wrapped.release,
        })
        if (!registered) throw new Error("Well-known auth command exited before durable process registration")
        if (process.platform === "linux" && wrapped.release) {
          await WindowsJobLauncher.release(wrapped.release, child.pid!)
        }

        const output = Promise.all([
          collect(child.stdout!, maxStdout, "stdout"),
          collect(child.stderr!, maxStderr, "stderr"),
        ])
        const timeout = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Well-known auth command timed out after ${timeoutMs}ms`)),
            timeoutMs,
          )
        })
        const [[stdout, stderr], settled] = await Promise.race([Promise.all([output, completion]), timeout])
        normal = true
        if (settled.code !== 0) {
          const status = settled.code === null ? `signal ${settled.signal ?? "unknown"}` : `exit ${settled.code}`
          throw new Error(
            `Well-known auth command ${status}: ${OpenScience.redactSecrets(stderr.trim()) || "no stderr"}`,
          )
        }
        const token = stdout.trim()
        if (!token) throw new Error("Well-known auth command produced no token")
        return token
      } catch (error) {
        bodyFailure = error
        if (!normal) {
          const failures: unknown[] = []
          if (registered) {
            await CredentialProcessLedger.revoke({ id, kind: "provider" }).catch((failure) => failures.push(failure))
          }
          await stop(child).catch((failure) => failures.push(failure))
          if (failures.length) throw new AggregateError([error, ...failures], "Well-known auth cleanup failed")
        }
        throw error
      } finally {
        if (timer) clearTimeout(timer)
        if (normal && registered) {
          try {
            const complete = await CredentialProcessLedger.complete(id)
            if (!complete) await CredentialProcessLedger.revoke({ id, kind: "provider" })
          } catch (cleanupFailure) {
            if (bodyFailure) {
              throw new AggregateError([bodyFailure, cleanupFailure], "Well-known auth completion cleanup failed")
            }
            throw cleanupFailure
          }
        }
        Sandbox.cleanup(sandbox)
      }
    })
  }
}

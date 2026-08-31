import fs from "fs/promises"
import path from "path"
import { spawn, type ChildProcess } from "node:child_process"
import driver from "./volume.py" with { type: "file" }
import { Global } from "../../global"
import { DataRootBarrier } from "../../global/data-root-barrier"
import { CredentialLifecycle } from "../../credentials/lifecycle"
import { CredentialProcessLedger } from "../../credentials/process-ledger"
import { ProcessIdentity } from "../../process/process-identity"
import { DARWIN_RESPONSIBILITY_ACTIVATION_SUFFIX } from "../../process/darwin-responsibility-launcher"
import { WindowsJobLauncher } from "../../process/windows-job-launcher"
import { TrustedExecutable } from "../../process/trusted-executable"
import { Shell } from "../../shell/shell"

export namespace ModalVolume {
  export const VERSION = "1.1.4"
  export const DOWNLOAD_DISK_RESERVE_BYTES = 512 * 1024 * 1024 // preserve 512 MiB for the host

  export type Context = {
    tokenId: string
    tokenSecret: string
    environment?: string
    command?: string[]
    env?: Record<string, string | undefined>
    python?: string
    uv?: string
  }

  type TestHooks = {
    probe?: { argv: string[]; timeout: number }
    beforeUv?: () => void | Promise<void>
    directories?: string[]
  }

  const hooks = { value: undefined as TestHooks | undefined }

  /** Deterministic SDK-selection barriers for process-ownership regressions. */
  export function testing(input: TestHooks) {
    if (!process.env.OPENSCIENCE_TEST_HOME) throw new Error("Modal Volume test hooks are disabled outside tests")
    const prior = hooks.value
    hooks.value = input
    return {
      [Symbol.dispose]() {
        if (hooks.value === input) hooks.value = prior
      },
    }
  }

  export type Entry = {
    path: string
    type: string
    size: number
    mtime?: number
  }

  export type Volume = {
    name: string
  }

  export type Download = {
    path: string
    staging: string
    size: number
    sha256: string
  }

  export type DownloadOptions = {
    signal?: AbortSignal
    /** Aggregate size reported by the already-completed provider listing. */
    declaredBytes?: number
  }

  export class DownloadCapacityError extends Error {
    constructor(
      readonly safeCapacityBytes: number,
      readonly responseBytes?: number,
      readonly storageCode?: "ENOSPC" | "EDQUOT",
    ) {
      const observed = responseBytes === undefined ? "" : `; response size ${responseBytes} bytes`
      const heading = storageCode
        ? `Modal Volume download could not continue because staging storage returned ${storageCode}. ` +
          `The current disk-derived staging capacity is ${safeCapacityBytes} bytes${observed}. `
        : `Modal Volume download exceeds the current safe staging capacity of ${safeCapacityBytes} bytes${observed}. `
      super(
        heading +
          `This capacity is computed from live free disk minus the ${DOWNLOAD_DISK_RESERVE_BYTES}-byte (512 MiB) host reserve. ` +
          "No partial staging files were kept. Free disk space, select smaller outputs, or use a dedicated approved transfer path before retrying.",
      )
      this.name = "ModalVolumeDownloadCapacityError"
    }
  }

  type Request =
    | { action: "check" }
    | { action: "volumes"; environment?: string }
    | { action: "list"; volume: string; environment?: string; path: string; recursive: boolean }
    | {
        action: "wait"
        volume: string
        environment?: string
        path: string
        recursive: boolean
        marker: string
        attempts: number
        interval_ms: number
      }
    | {
        action: "download"
        volume: string
        environment?: string
        paths: string[]
        staging: string
        capacity_bytes: number
        reserve_bytes: number
      }

  const LIST_TIMEOUT = 60_000
  const PROBE_TIMEOUT = 15_000
  const MAX_STDOUT = 8 * 1024 * 1024
  const MAX_STDERR = 1024 * 1024
  const text = new TextDecoder()

  class TimeoutError extends Error {
    constructor(action: string, timeout: number) {
      super(`Modal Volume ${action} timed out after ${timeout}ms`)
      this.name = "ModalVolumeTimeoutError"
    }
  }

  const clean = (value: string) => value.replaceAll("\\", "/").replace(/^\/+/, "")
  const safe = (value: string) => {
    const result = clean(value)
    if (!result || result.split("/").includes("..")) throw new Error(`Modal Volume returned an unsafe path: ${value}`)
    return result
  }
  const abortReason = (signal: AbortSignal) =>
    signal.reason ?? new DOMException("Modal Volume request was aborted", "AbortError")

  function storageCapacityCode(error: unknown) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code
    return code === "ENOSPC" || code === "EDQUOT" ? code : undefined
  }

  async function availableDownloadBytes(root: string) {
    const disk = await fs.statfs(root)
    const available = disk.bavail * disk.bsize
    if (!Number.isSafeInteger(available) || available < 0) {
      throw new Error("Modal Volume staging capacity could not be represented safely; the download was not started")
    }
    return Math.max(0, available - DOWNLOAD_DISK_RESERVE_BYTES)
  }

  function driverCapacityError(message: string) {
    const prefix = "modal volume bridge capacity:"
    const line = message
      .split(/\r?\n/)
      .map((item) => item.trim())
      .findLast((item) => item.startsWith(prefix))
    if (!line) return
    try {
      const value = JSON.parse(line.slice(prefix.length).trim()) as Record<string, unknown>
      const safe = value.safe_capacity_bytes
      const response = value.response_bytes
      const storage = value.storage_code
      if (typeof safe !== "number" || !Number.isSafeInteger(safe) || safe < 0) return
      if (response !== undefined && (typeof response !== "number" || !Number.isSafeInteger(response) || response < 0)) {
        return
      }
      if (storage !== undefined && storage !== "ENOSPC" && storage !== "EDQUOT") return
      return new DownloadCapacityError(safe, response as number | undefined, storage as "ENOSPC" | "EDQUOT" | undefined)
    } catch {
      return
    }
  }

  const cache: { path?: Promise<string> } = {}

  export async function driverPath() {
    if (cache.path) return cache.path
    const pending = Promise.resolve().then(async () => {
      const source = Bun.file(driver)
      const bytes = Buffer.from(await source.arrayBuffer())
      const target = path.join(Global.Path.data, "runtime", `modal-volume-${Bun.hash(bytes)}.py`)
      const temp = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`
      await fs.mkdir(path.dirname(target), { recursive: true })
      const installed = Bun.file(target)
      if ((await installed.exists()) && Bun.hash(await installed.arrayBuffer()) === Bun.hash(bytes)) return target
      await fs.writeFile(temp, bytes, { mode: 0o600, flag: "wx" })
      await fs.rename(temp, target).catch(async (error) => {
        await fs.unlink(temp).catch(() => undefined)
        if (await Bun.file(target).exists()) return
        throw error
      })
      return target
    })
    cache.path = pending.catch((error) => {
      cache.path = undefined
      throw error
    })
    return cache.path
  }

  export async function command(context: Context, signal?: AbortSignal) {
    if (signal?.aborted) throw abortReason(signal)
    if (context.command) return context.command
    const file = await driverPath()
    const env = environment({ ...process.env, ...context.env })
    // Finder-launched desktop apps inherit a minimal PATH. Resolve existing
    // Homebrew/user installations directly, without sourcing shell startup
    // files or making the user reinstall a runtime that is already present.
    const search =
      process.platform === "win32" ? Object.entries(env).find(([key]) => key.toUpperCase() === "PATH")?.[1] : env.PATH
    const executable = async (name: string) =>
      Bun.which(name, { PATH: search ?? "" }) ??
      (await TrustedExecutable.resolve(name, { directories: hooks.value?.directories }))
    const python = context.python ?? (await executable("python3")) ?? (await executable("python"))
    if (python) {
      const probe = await execute(
        hooks.value?.probe?.argv ?? [
          python,
          "-I",
          "-c",
          `import modal; assert modal.__version__ == '${VERSION}'; assert hasattr(modal.Volume, 'read_file')`,
        ],
        env,
        hooks.value?.probe?.timeout ?? PROBE_TIMEOUT,
        "SDK probe",
        undefined,
        signal,
      ).catch((error) => {
        if (signal?.aborted) throw abortReason(signal)
        if (error instanceof TimeoutError) return undefined
        throw error
      })
      if (probe?.signal) throw new Error(`Modal Volume SDK probe was killed by ${probe.signal}`)
      if (probe?.code === 0) return [python, "-I", file]
      if (probe?.code === null) throw new Error("Modal Volume SDK probe ended without an exit code")
    }
    if (signal?.aborted) throw abortReason(signal)
    const uv = context.uv ?? (await executable("uv"))
    if (uv) {
      await hooks.value?.beforeUv?.()
      return [uv, "run", "--no-project", "--python", "3.12", "--with", `modal==${VERSION}`, "python", "-I", file]
    }
    throw new Error(
      `OpenScience could not find uv or an isolated Python installation with Modal SDK ${VERSION}. ` +
        "Install uv, then retry Modal Volumes.",
    )
  }

  const RUNTIME_ENV = new Set([
    "PATH",
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "LANG",
    "TMPDIR",
    "TMP",
    "TEMP",
    "XDG_CACHE_HOME",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "REQUESTS_CA_BUNDLE",
    "CURL_CA_BUNDLE",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "PATHEXT",
    "USERPROFILE",
  ])

  /** Minimal runtime environment for the trusted bridge. Provider/cloud keys,
   * OpenScience control-plane state, dynamic-loader injection, and Python
   * startup injection are deliberately absent. */
  export function environment(source: Record<string, string | undefined> = process.env): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [name, value] of Object.entries(source)) {
      if (!value) continue
      const key = process.platform === "win32" ? name.toUpperCase() : name
      if (RUNTIME_ENV.has(key) || key.startsWith("LC_")) env[name] = value
    }
    return {
      ...env,
      PYTHONNOUSERSITE: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    }
  }

  function output(stream: NodeJS.ReadableStream, limit: number, label: string): Promise<Buffer> {
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
          fail(new Error(`Modal Volume ${label} exceeded ${limit} bytes`))
          return
        }
        chunks.push(chunk)
      })
      stream.once("error", fail)
      stream.once("end", () => {
        if (settled) return
        settled = true
        resolve(Buffer.concat(chunks, size))
      })
    })
  }

  async function cleanupGate(release?: string) {
    if (!release) return
    await Promise.all([
      fs.rm(release, { force: true }).catch(() => undefined),
      fs.rm(`${release}${DARWIN_RESPONSIBILITY_ACTIVATION_SUFFIX}`, { force: true }).catch(() => undefined),
    ])
  }

  async function stop(id: string, child: ChildProcess, detached: boolean, identity?: string) {
    const failures: unknown[] = []
    await CredentialProcessLedger.revoke({ id, kind: "modal-volume" }).catch((error) => failures.push(error))
    const stillOwned = child.pid && identity ? await CredentialProcessLedger.owns(child.pid, identity) : true
    if (stillOwned && child.exitCode === null && child.signalCode === null) {
      await Shell.killTree(child, {
        detached,
        exited: () => child.exitCode !== null || child.signalCode !== null,
      }).catch((error) => failures.push(error))
    }
    if (failures.length) throw new AggregateError(failures, "Modal Volume bridge could not be stopped")
  }

  async function complete(id: string) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await CredentialProcessLedger.complete(id)) return
      await Bun.sleep(20)
    }
    await CredentialProcessLedger.revoke({ id, kind: "modal-volume" })
  }

  async function execute(
    argv: string[],
    env: Record<string, string>,
    timeout: number | undefined,
    action: string,
    stdin?: Buffer,
    signal?: AbortSignal,
  ) {
    if (signal?.aborted) throw abortReason(signal)
    await using operation = await DataRootBarrier.enter(Global.Path.data)
    return await operation.during(async () => {
      const launched = await CredentialLifecycle.admit(async () => {
        if (signal?.aborted) throw abortReason(signal)
        const linuxOwner =
          process.platform === "linux"
            ? await ProcessIdentity.capture(process.pid).then((identity) =>
                identity ? { pid: process.pid, identity } : undefined,
              )
            : undefined
        if (process.platform === "linux" && !linuxOwner) {
          throw new Error("Could not capture the Linux server identity for Modal Volume launch")
        }
        const wrapped = WindowsJobLauncher.wrap({
          file: argv[0]!,
          args: argv.slice(1),
          linuxOwner,
        })
        const detached = process.platform !== "win32"
        const child = spawn(wrapped.file, wrapped.args, {
          env,
          detached,
          windowsHide: true,
          stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
        })
        WindowsJobLauncher.bind(child, wrapped.release)
        const completion = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
          child.once("error", reject)
          child.once("close", (code, signal) => resolve({ code, signal }))
        })
        const stdout = output(child.stdout!, MAX_STDOUT, `${action} stdout`)
        const stderr = output(child.stderr!, MAX_STDERR, `${action} stderr`)
        // Registration can fail before the main result race is installed. Keep
        // these promises observed during that window without changing their
        // eventual rejected state for the caller.
        void completion.catch(() => undefined)
        void stdout.catch(() => undefined)
        void stderr.catch(() => undefined)
        const id = `modal-volume-${crypto.randomUUID()}`
        let identity: string | undefined
        try {
          if (!child.pid) throw new Error("Modal Volume bridge started without a process id")
          identity = await CredentialProcessLedger.identity(child.pid)
          if (!identity) throw new Error(`Could not establish a safe identity for Modal Volume ${action}`)
          const registered = await CredentialProcessLedger.register({
            id,
            kind: "modal-volume",
            pid: child.pid,
            detached,
            identity,
            windowsRelease: wrapped.release,
          })
          if (!registered) throw new Error(`Modal Volume ${action} exited before durable ownership was established`)
          if (process.platform === "linux" && wrapped.release) {
            await WindowsJobLauncher.release(wrapped.release, child.pid)
          }
          if (stdin) child.stdin!.end(stdin)
          return { child, completion, stdout, stderr, id, detached, identity, release: wrapped.release }
        } catch (error) {
          await stop(id, child, detached, identity).catch(() => undefined)
          await cleanupGate(wrapped.release)
          throw error
        }
      })

      let timer: ReturnType<typeof setTimeout> | undefined
      const expired =
        timeout === undefined
          ? undefined
          : new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new TimeoutError(action, timeout)), timeout)
            })
      const result = Promise.all([launched.stdout, launched.stderr, launched.completion] as const)
      const interrupted = signal ? Promise.withResolvers<never>() : undefined
      const abort = () => interrupted?.reject(abortReason(signal!))
      if (signal?.aborted) abort()
      else signal?.addEventListener("abort", abort, { once: true })
      let normal = false
      try {
        const [stdout, stderr, status] = await Promise.race([
          result,
          ...(expired ? [expired] : []),
          ...(interrupted ? [interrupted.promise] : []),
        ])
        normal = true
        return { stdout, stderr, code: status.code, signal: status.signal }
      } catch (error) {
        result.catch(() => undefined)
        await stop(launched.id, launched.child, launched.detached, launched.identity)
        throw error
      } finally {
        if (timer) clearTimeout(timer)
        signal?.removeEventListener("abort", abort)
        if (normal) await complete(launched.id)
        await cleanupGate(launched.release)
      }
    })
  }

  async function invoke(request: Request, context: Context, timeout?: number, signal?: AbortSignal) {
    if (signal?.aborted) throw abortReason(signal)
    const env = environment({ ...process.env, ...context.env })
    env.MODAL_TOKEN_ID = context.tokenId
    env.MODAL_TOKEN_SECRET = context.tokenSecret
    const {
      stdout,
      stderr,
      code,
      signal: killed,
    } = await execute(
      await command(context, signal),
      env,
      timeout,
      request.action,
      Buffer.from(JSON.stringify(request)),
      signal,
    )
    if (signal?.aborted) throw abortReason(signal)
    if (killed) throw new Error(`Modal Volume ${request.action} was killed by ${killed}`)
    if (code !== 0) {
      const detail = stderr.byteLength ? stderr : stdout
      const message = [context.tokenId, context.tokenSecret].reduce(
        (value, secret) => (secret ? value.replaceAll(secret, "[REDACTED]") : value),
        text.decode(detail).trim(),
      )
      if (request.action === "download") {
        const capacity = driverCapacityError(message)
        if (capacity) throw capacity
      }
      throw new Error(`Modal Volume ${request.action} failed (exit ${code}): ${message}`)
    }
    try {
      return JSON.parse(text.decode(stdout)) as unknown
    } catch (cause) {
      throw new Error(`Modal Volume ${request.action} returned invalid JSON`, { cause })
    }
  }

  export async function check(context: Context) {
    const result = await invoke({ action: "check" }, context, LIST_TIMEOUT)
    if (!result || typeof result !== "object" || !("version" in result) || typeof result.version !== "string") {
      throw new Error("Modal Volume check returned an invalid SDK version")
    }
    return result.version
  }

  export async function volumes(context: Context): Promise<Volume[]> {
    const result = await invoke({ action: "volumes", environment: context.environment }, context, LIST_TIMEOUT)
    if (!Array.isArray(result)) throw new Error("Modal Volume discovery did not return an array")
    return result.map((entry) => {
      if (!entry || typeof entry !== "object" || !("name" in entry) || typeof entry.name !== "string") {
        throw new Error("Modal Volume discovery returned an invalid name")
      }
      if (!entry.name.trim()) throw new Error("Modal Volume discovery returned an empty name")
      return { name: entry.name }
    })
  }

  export async function list(context: Context, volume: string, root = "/", recursive = false): Promise<Entry[]> {
    const requested = root.replaceAll("\\", "/")
    if (requested.includes("\0") || requested.split("/").includes("..")) {
      throw new Error(`Modal Volume list received an unsafe path: ${root}`)
    }
    const result = await invoke(
      { action: "list", volume, environment: context.environment, path: requested, recursive },
      context,
      LIST_TIMEOUT,
    )
    return entries(result, "list")
  }

  export async function wait(
    context: Context,
    volume: string,
    marker: string,
    attempts = 20,
    interval = 500,
  ): Promise<Entry[]> {
    const target = safe(marker)
    const result = await invoke(
      {
        action: "wait",
        volume,
        environment: context.environment,
        path: "/",
        recursive: true,
        marker: target,
        attempts,
        interval_ms: interval,
      },
      context,
      LIST_TIMEOUT,
    )
    return entries(result, "wait")
  }

  function entries(result: unknown, action: "list" | "wait"): Entry[] {
    if (!Array.isArray(result)) throw new Error(`Modal Volume ${action} did not return an array`)
    return result.map((entry) => {
      if (!entry || typeof entry !== "object") throw new Error(`Modal Volume ${action} returned an invalid entry`)
      if (!("path" in entry) || typeof entry.path !== "string") {
        throw new Error(`Modal Volume ${action} returned an entry without a path`)
      }
      if (!("type" in entry) || typeof entry.type !== "string") {
        throw new Error(`Modal Volume ${action} returned an invalid type for ${entry.path}`)
      }
      if (!("size" in entry) || typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 0) {
        throw new Error(`Modal Volume ${action} returned an invalid size for ${entry.path}`)
      }
      const mtime = "mtime" in entry && typeof entry.mtime === "number" ? entry.mtime : undefined
      return { path: safe(entry.path), type: entry.type, size: entry.size, ...(mtime === undefined ? {} : { mtime }) }
    })
  }

  export async function download(
    context: Context,
    volume: string,
    paths: string[],
    staging: string,
    options: DownloadOptions = {},
  ): Promise<Download[]> {
    const { signal, declaredBytes } = options
    if (signal?.aborted) throw abortReason(signal)
    const files = paths.map(safe)
    if (declaredBytes !== undefined && (!Number.isSafeInteger(declaredBytes) || declaredBytes < 0)) {
      throw new Error("Modal Volume download received an invalid declared aggregate size")
    }
    let capacity = 0
    try {
      await fs.rm(staging, { recursive: true, force: true })
      const parent = path.dirname(staging)
      await fs.mkdir(parent, { recursive: true, mode: 0o700 })
      capacity = await availableDownloadBytes(parent)
      if (capacity === 0 || (declaredBytes !== undefined && declaredBytes > capacity)) {
        throw new DownloadCapacityError(capacity, declaredBytes)
      }
      await fs.mkdir(staging, { recursive: true, mode: 0o700 })
      const result = await invoke(
        {
          action: "download",
          volume,
          environment: context.environment,
          paths: files,
          staging,
          capacity_bytes: capacity,
          reserve_bytes: DOWNLOAD_DISK_RESERVE_BYTES,
        },
        context,
        undefined,
        signal,
      )
      if (signal?.aborted) throw abortReason(signal)
      if (!Array.isArray(result)) throw new Error("Modal Volume download did not return an array")
      const root = await fs.realpath(staging)
      const downloaded = await Promise.all(
        result.map(async (entry) => {
          if (!entry || typeof entry !== "object") throw new Error("Modal Volume download returned an invalid entry")
          if (!("path" in entry) || typeof entry.path !== "string") {
            throw new Error("Modal Volume download returned an entry without a path")
          }
          if (!("staging" in entry) || typeof entry.staging !== "string") {
            throw new Error(`Modal Volume download returned no local path for ${entry.path}`)
          }
          if (
            !("size" in entry) ||
            typeof entry.size !== "number" ||
            !Number.isSafeInteger(entry.size) ||
            entry.size < 0
          ) {
            throw new Error(`Modal Volume download returned an invalid size for ${entry.path}`)
          }
          if (!("sha256" in entry) || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) {
            throw new Error(`Modal Volume download returned an invalid checksum for ${entry.path}`)
          }
          const relative = safe(entry.path)
          const expected = path.resolve(root, ...relative.split("/"))
          const actual = await fs.realpath(entry.staging).catch(() => undefined)
          if (actual !== expected) {
            throw new Error(`Modal Volume download escaped its staging directory: ${entry.path}`)
          }
          return { path: relative, staging: expected, size: entry.size, sha256: entry.sha256 }
        }),
      )
      if (signal?.aborted) throw abortReason(signal)
      return downloaded
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined)
      if (error instanceof DownloadCapacityError) throw error
      const storage = storageCapacityCode(error)
      if (storage) throw new DownloadCapacityError(capacity, undefined, storage)
      throw error
    }
  }
}

// A credential rotation in this or another server must revoke any helper that
// inherited the prior Modal token pair before the new revision is acknowledged.
CredentialLifecycle.onRevoke(async () => {
  await CredentialProcessLedger.revoke("modal-volume")
})

import z from "zod"
import { Tool } from "./tool"
import { spawn, type ChildProcess } from "child_process"
import path from "path"
import os from "os"
import { accessSync, constants, mkdirSync, statSync, unlinkSync } from "fs"
import { Shell } from "@/shell/shell"
import { Instance } from "@/project/instance"
import { OpenScience } from "@/openscience"
import { SessionFilesystem } from "@/session/filesystem"
import { Sandbox } from "@/sandbox/sandbox"
import { KernelQueue } from "@/science/kernel/queue"
import { KernelProcessIdentity } from "@/science/kernel/process"
import { KernelRuntime } from "@/science/kernel/registry"
import { KernelEnvironmentMutation } from "@/science/kernel/environment-mutation"
import { AtlasEnvironment } from "@/science/kernel/types"
import type {
  Kernel,
  KernelManager,
  KernelLanguage,
  KernelEnvironment,
  KernelStartOptions,
  ExecuteOptions,
  ExecuteResult,
  KernelOutput,
  KernelProcess,
} from "@/science/kernel/types"
import { WindowsJobLauncher } from "@/process/windows-job-launcher"
import { ExecutionAuthority } from "@/project/execution"
import { ToolRetryGuard } from "@/session/tool-retry-guard"

/**
 * Persistent R runtime, following the same pattern as the Python runtime in
 * `tool/notebook.ts` and the biology kernel it generalizes.
 *
 * One long-lived `Rscript` process per sessionID evaluates code in the global
 * environment, so objects/attached packages persist across `execute` calls.
 * stdout (print output) is captured; warnings/messages/errors are surfaced; and
 * base-graphics or ggplot2 plots left on the device are captured as `image/png`
 * where the platform's png device is available.
 *
 * Host requirement: `Rscript` on PATH (base R only — grDevices/utils are default
 * packages; no CRAN packages required). If Rscript is missing the tool degrades
 * gracefully with an install hint instead of throwing.
 */

// The driver runs a REPL over blocking stdin. Real newlines here are real
// newlines in the R source; `\\n` sequences are escaped newlines inside R string
// literals. Results are framed by section markers (no JSON dependency in base R):
// a header (OK / IMG path), then the captured stdout section, then the
// warnings/messages/error section. The PNG is passed back by file path and read +
// base64-encoded on the TS side, avoiding any base64 package requirement.
const KERNEL_SCRIPT = `
run_code <- function(code) {
  imgfile <- tempfile(fileext = ".png")
  dev_ok <- tryCatch({
    grDevices::png(filename = imgfile, width = 900, height = 650, res = 110, type = "cairo")
    TRUE
  }, error = function(e) tryCatch({
    grDevices::png(filename = imgfile, width = 900, height = 650, res = 110)
    TRUE
  }, error = function(e2) FALSE))

  msgs <- character(0)
  add_msg <- function(x) msgs[[length(msgs) + 1L]] <<- x

  ok <- TRUE
  errmsg <- NULL

  out <- tryCatch(
    utils::capture.output(
      withCallingHandlers(
        {
          exprs <- parse(text = code)
          for (i in seq_along(exprs)) {
            wv <- withVisible(eval(exprs[[i]], envir = globalenv()))
            if (isTRUE(wv$visible)) print(wv$value)
          }
        },
        warning = function(w) { add_msg(paste0("Warning: ", conditionMessage(w))); invokeRestart("muffleWarning") },
        message = function(m) { add_msg(sub("\\n$", "", conditionMessage(m))); invokeRestart("muffleMessage") }
      )
    ),
    error = function(e) { ok <<- FALSE; errmsg <<- conditionMessage(e); character(0) }
  )

  plotted <- FALSE
  if (isTRUE(dev_ok)) {
    plotted <- tryCatch(length(grDevices::recordPlot()[[1]]) > 0L, error = function(e) FALSE)
    tryCatch(grDevices::dev.off(), error = function(e) NULL)
  }
  imgpath <- ""
  if (isTRUE(plotted) && file.exists(imgfile) && file.info(imgfile)$size > 0) {
    imgpath <- imgfile
  } else {
    try(unlink(imgfile), silent = TRUE)
  }

  msg_text <- paste(msgs, collapse = "\\n")
  if (!is.null(errmsg)) {
    if (nchar(msg_text) > 0L) msg_text <- paste0(msg_text, "\\n")
    msg_text <- paste0(msg_text, "Error: ", errmsg)
  }
  out_text <- paste(out, collapse = "\\n")

  cat("__OPENSCIENCE_R_RESULT_START__\\n")
  cat("OK:", if (ok) "1" else "0", "\\n", sep = "")
  cat("IMG:", imgpath, "\\n", sep = "")
  cat("__OPENSCIENCE_R_OUT__\\n")
  cat(out_text)
  cat("\\n__OPENSCIENCE_R_MSG__\\n")
  cat(msg_text)
  cat("\\n__OPENSCIENCE_R_END__\\n")
  flush(stdout())
}

con <- file("stdin")
open(con, blocking = TRUE)
cat("__OPENSCIENCE_KERNEL_READY__", R.version.string, "\\n", sep = "")
flush(stdout())

repeat {
  lines <- character(0)
  got_end <- FALSE
  repeat {
    l <- readLines(con, n = 1L)
    if (length(l) == 0L) break
    if (identical(l, "__OPENSCIENCE_CODE_END__")) { got_end <- TRUE; break }
    lines <- c(lines, l)
  }
  if (!isTRUE(got_end)) break
  code <- paste(lines, collapse = "\\n")
  tryCatch(run_code(code), error = function(e) {
    cat("__OPENSCIENCE_R_RESULT_START__\\nOK:0\\nIMG:\\n__OPENSCIENCE_R_OUT__\\n\\n__OPENSCIENCE_R_MSG__\\nError: ", conditionMessage(e), "\\n__OPENSCIENCE_R_END__\\n", sep = "")
    flush(stdout())
  })
}
`.trim()

const READY = "__OPENSCIENCE_KERNEL_READY__"
const START = "__OPENSCIENCE_R_RESULT_START__\n"
const END = "\n__OPENSCIENCE_R_END__"
async function findRscript(override?: string): Promise<{ binary: string; version?: string } | null> {
  const candidates = override ? [override] : ["Rscript"]
  for (const bin of candidates) {
    try {
      // Discovery is metadata-only. A project-selected runtime must not
      // receive a preflight `--version` execution before KernelRuntime has
      // acquired trust, sandbox authority and durable OS ownership. The
      // registered interpreter reports its version in the READY frame.
      const binary = path.isAbsolute(bin) ? bin : Bun.which(bin)
      if (!binary || !statSync(binary).isFile()) continue
      accessSync(binary, process.platform === "win32" ? constants.F_OK : constants.X_OK)
      return { binary }
    } catch {}
  }
  return null
}

interface RawResult {
  ok: boolean
  stdout: string
  messages: string
  imgPath: string
}

function parseFrame(block: string): RawResult {
  const outMarker = "__OPENSCIENCE_R_OUT__\n"
  const msgMarker = "\n__OPENSCIENCE_R_MSG__\n"
  const outIdx = block.indexOf(outMarker)
  const header = outIdx === -1 ? block : block.slice(0, outIdx)
  const rest = outIdx === -1 ? "" : block.slice(outIdx + outMarker.length)
  const msgIdx = rest.indexOf(msgMarker)
  const stdout = msgIdx === -1 ? rest : rest.slice(0, msgIdx)
  const messages = msgIdx === -1 ? "" : rest.slice(msgIdx + msgMarker.length)
  const ok = /OK:1/.test(header)
  const imgMatch = header.match(/IMG:(.*)/)
  const imgPath = imgMatch?.[1]?.trim() ?? ""
  return { ok, stdout, messages, imgPath }
}

async function frameToResult(raw: RawResult): Promise<ExecuteResult> {
  const outputs: KernelOutput[] = []
  if (raw.stdout) outputs.push({ type: "stream", name: "stdout", data: { "text/plain": raw.stdout } })
  if (raw.imgPath) {
    try {
      const bytes = await Bun.file(raw.imgPath).arrayBuffer()
      const b64 = Buffer.from(bytes).toString("base64")
      if (b64) outputs.push({ type: "display", data: { "image/png": b64 } })
    } catch {}
    try {
      unlinkSync(raw.imgPath)
    } catch {}
  }
  if (raw.ok && raw.messages) {
    outputs.push({ type: "stream", name: "stderr", data: { "text/plain": raw.messages } })
  }
  if (!raw.ok) {
    outputs.push({ type: "error", error: { name: "RError", message: raw.messages || "R evaluation error" } })
  }
  return {
    ok: raw.ok,
    outputs,
    stdout: raw.stdout,
    stderr: raw.messages,
  }
}

class RKernel implements Kernel {
  readonly id: string
  readonly language: KernelLanguage = "r"
  proc?: ChildProcess
  scriptPath?: string
  configPath?: string
  private stderrTail = ""
  private queue = new KernelQueue()
  private intentional = false
  environment?: KernelEnvironment
  process?: KernelProcess

  constructor(id: string) {
    this.id = id
  }

  get ready(): boolean {
    return !!this.proc && KernelProcessIdentity.matches(this.proc, this.process)
  }

  get crashed() {
    return !!this.proc && !this.ready && !this.intentional
  }

  get busy() {
    return this.queue.depth > 0
  }

  get queueDepth() {
    return Math.max(this.queue.depth - 1, 0)
  }

  async start(opts?: KernelStartOptions): Promise<void> {
    if (this.ready) return
    const policy = opts?.sandboxPolicy
    if (!policy) throw new Error("R kernel start is missing its authorized sandbox policy")
    this.intentional = false
    this.stderrTail = ""
    const interpreter = await findRscript(opts?.binary)
    if (!interpreter) {
      throw new Error(
        "Rscript not found. Install R (https://www.r-project.org) so `Rscript` is on PATH to use the R kernel.",
      )
    }

    const scriptPath = path.join(os.tmpdir(), `openscience-rkernel-${this.id.slice(0, 8)}-${Date.now()}.R`)
    const configPath = `${scriptPath}.atlas.json`
    await Bun.write(scriptPath, KERNEL_SCRIPT)
    await Bun.write(configPath, "{}\n")
    this.scriptPath = scriptPath
    this.configPath = configPath
    const workspace = opts?.sessionID
      ? await SessionFilesystem.processWriteRoots(opts.sessionID)
      : [Instance.directory, Instance.worktree]
    const readable = opts?.sessionID
      ? await SessionFilesystem.processReadRoots(opts.sessionID)
      : [Instance.directory, Instance.worktree]

    // Confine the kernel to the workspace when the execution sandbox is on: the R
    // kernel runs arbitrary agent-authored code — the same threat model as the
    // bash tool — so it must respect the same boundary.
    const sandboxed = Sandbox.wrapArgv({
      file: interpreter.binary,
      args: ["--vanilla", scriptPath],
      workspace,
      readable,
      extraWritable: [scriptPath, configPath, ...(opts?.extraWritable ?? [])],
      unreadable: OpenScience.kernelSensitivePaths(),
      options: {
        enabled: policy.enabled,
        network: opts?.sandboxNetwork ?? policy.network,
        allowWrite: [...policy.allowWrite],
        onUnavailable: policy.onUnavailable,
      },
    })
    const cwd = opts?.cwd ?? (opts?.sessionID ? await SessionFilesystem.workspace(opts.sessionID) : Instance.directory)
    this.environment = {
      cwd,
      interpreter: {
        name: opts?.environmentName ?? "r",
        binary: interpreter.binary,
        version: interpreter.version,
      },
      atlas: AtlasEnvironment,
      sandbox: {
        ...Sandbox.describe(),
        requested: policy.enabled,
        enforced: sandboxed.sandboxed,
        backend: sandboxed.backend,
        network: opts?.sandboxNetwork ?? policy.network,
        warning: sandboxed.warning,
      },
    }
    const wrapped = WindowsJobLauncher.wrap({
      file: sandboxed.file,
      args: sandboxed.args,
      linuxOwner: opts?.processOwnership?.linuxOwner,
    })
    let proc: ChildProcess
    try {
      proc = spawn(wrapped.file, wrapped.args, {
        cwd,
        env: {
          ...OpenScience.kernelEnv(process.env),
          ...(opts?.env ?? {}),
          ATLAS_CLI_CONFIG_PATH: configPath,
        },
        stdio: ["pipe", "pipe", "pipe"],
        // Own process group so killing the kernel reaps its worker children (#102).
        detached: process.platform !== "win32",
      })
      WindowsJobLauncher.bind(proc, wrapped.release)
    } catch (error) {
      Sandbox.cleanup(sandboxed)
      throw error
    }
    proc.once("exit", () => Sandbox.cleanup(sandboxed))
    proc.once("error", () => Sandbox.cleanup(sandboxed))
    this.proc = proc
    this.process = KernelProcessIdentity.capture(proc)
    const ownership = opts?.processOwnership ? { ...opts.processOwnership, windowsRelease: wrapped.release } : undefined
    try {
      const registered = await KernelProcessIdentity.register(proc, ownership)
      if (!registered) throw new Error("R kernel exited before durable process registration")
      this.process = registered
      const complete = () => {
        proc.off("exit", complete)
        void KernelProcessIdentity.complete(registered).catch(() => undefined)
      }
      proc.once("exit", complete)
      if (proc.exitCode !== null || proc.signalCode !== null) complete()
    } catch (error) {
      await this.terminate(proc, ownership?.id)
      throw error
    }
    proc.once("exit", () => {
      if (!this.intentional) this.cleanupScript()
    })

    proc.stderr?.on("data", (d: Buffer) => {
      this.stderrTail += d.toString()
      if (this.stderrTail.length > 10_000) this.stderrTail = this.stderrTail.slice(-5000)
    })

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        void this.terminate(proc)
        reject(new Error(`R kernel startup timed out. stderr: ${this.stderrTail}`))
      }, 20_000)
      let buf = ""
      const onData = (d: Buffer) => {
        buf += d.toString()
        if (buf.length > 64 * 1024) {
          clearTimeout(timer)
          proc.stdout?.off("data", onData)
          void this.terminate(proc)
          reject(new Error("R kernel startup output exceeded 65536 bytes before the ready handshake"))
          return
        }
        const start = buf.indexOf(READY)
        const end = start === -1 ? -1 : buf.indexOf("\n", start)
        if (start !== -1 && end !== -1) {
          const version = buf.slice(start + READY.length, end).trim()
          if (!version || version.length > 128 || /[\0\r]/.test(version)) {
            clearTimeout(timer)
            proc.stdout?.off("data", onData)
            void this.terminate(proc)
            reject(new Error("R kernel returned an invalid ready handshake"))
            return
          }
          this.environment!.interpreter.version = version
          clearTimeout(timer)
          proc.stdout?.off("data", onData)
          resolve()
        }
      }
      proc.stdout?.on("data", onData)
      proc.once("error", (err) => {
        clearTimeout(timer)
        reject(err)
      })
      proc.once("exit", (code) => {
        clearTimeout(timer)
        reject(new Error(`R kernel exited during startup (code ${code}). stderr: ${this.stderrTail}`))
      })
    })
  }

  async execute(code: string, opts?: ExecuteOptions): Promise<ExecuteResult> {
    return this.queue.run(() => this.run(code, opts), opts?.signal)
  }

  private async run(code: string, opts?: ExecuteOptions): Promise<ExecuteResult> {
    if (!this.ready) throw new Error("R kernel is not running")
    await opts?.onStart?.()
    if (opts?.signal?.aborted) throw new Error("Execution aborted before starting")
    const proc = this.proc!
    const timeout = Math.min(Math.max(opts?.timeout ?? 120_000, 5_000), 600_000)

    const raw = await new Promise<RawResult>((resolve, reject) => {
      let stopping = false
      const stop = (error: Error) => {
        if (stopping) return
        stopping = true
        cleanup()
        // Do not free the queue while an expired interpreter may still be
        // running user code. Retire the process first so the following call is
        // forced onto a clean R incarnation.
        void this.shutdown().then(
          () => reject(error),
          () => reject(error),
        )
      }
      const timer = setTimeout(() => {
        stop(new Error(`Cell execution timed out after ${Math.round(timeout / 1000)}s`))
      }, timeout)

      const onAbort = () => {
        stop(new Error("Execution aborted"))
      }

      let buffer = ""
      const onData = (d: Buffer) => {
        buffer += d.toString()
        const s = buffer.indexOf(START)
        const e = buffer.indexOf(END)
        if (s !== -1 && e !== -1 && e > s) {
          cleanup()
          resolve(parseFrame(buffer.slice(s + START.length, e)))
        }
      }
      const onExit = (code: number | null) => {
        cleanup()
        reject(new Error(`R kernel died during execution (exit code ${code}). stderr: ${this.stderrTail}`))
      }
      function cleanup() {
        clearTimeout(timer)
        proc.stdout?.off("data", onData)
        proc.off("exit", onExit)
        opts?.signal?.removeEventListener("abort", onAbort)
      }

      opts?.signal?.addEventListener("abort", onAbort, { once: true })
      proc.stdout?.on("data", onData)
      proc.once("exit", onExit)
      proc.stdin?.write(code + "\n__OPENSCIENCE_CODE_END__\n")
    })

    return frameToResult(raw)
  }

  async interrupt() {
    if (!this.proc || !this.busy || !KernelProcessIdentity.matches(this.proc, this.process)) return false
    return Shell.interruptTree(this.proc, { detached: process.platform !== "win32" })
  }

  async shutdown(): Promise<void> {
    this.intentional = true
    const proc = this.proc
    if (proc) await this.terminate(proc)
    this.proc = undefined
    this.process = undefined
    this.cleanupScript()
  }

  /** Synchronous group kill for process-exit handlers (async shutdown can't run there). */
  killSync(): void {
    this.intentional = true
    if (this.proc && KernelProcessIdentity.matches(this.proc, this.process)) {
      if (!KernelProcessIdentity.terminateSync(this.process)) {
        Shell.killTreeSync(this.proc, { detached: process.platform !== "win32" })
      }
    }
    this.proc = undefined
    this.process = undefined
    this.cleanupScript()
  }

  private async terminate(proc: ChildProcess, pendingOwnershipID?: string) {
    const identity = this.process
    if (!KernelProcessIdentity.matches(proc, identity)) return
    const stopped = await KernelProcessIdentity.terminate(identity, pendingOwnershipID)
    if (stopped || !KernelProcessIdentity.matches(proc, identity)) return
    await Shell.killTree(proc, { exited: () => proc.exitCode !== null, detached: process.platform !== "win32" })
  }

  private cleanupScript(): void {
    for (const file of [this.scriptPath, this.configPath]) {
      if (!file) continue
      try {
        unlinkSync(file)
      } catch {}
    }
    this.scriptPath = undefined
    this.configPath = undefined
  }
}

class RKernelManager implements KernelManager {
  readonly language: KernelLanguage = "r"
  private kernels = new Map<string, RKernel>()
  private starts = new Map<string, { kernel: RKernel; promise: Promise<RKernel> }>()

  async get(sessionID: string, opts?: KernelStartOptions): Promise<RKernel> {
    const existing = this.kernels.get(sessionID)
    if (existing && existing.ready) return existing
    if (existing) {
      await existing.shutdown()
      this.kernels.delete(sessionID)
    }
    const pending = this.starts.get(sessionID)
    if (pending) return pending.promise
    const kernel = new RKernel(sessionID)
    const start = kernel.start(opts).then(
      () => {
        this.starts.delete(sessionID)
        this.kernels.set(sessionID, kernel)
        return kernel
      },
      async (error) => {
        this.starts.delete(sessionID)
        await kernel.shutdown()
        throw error
      },
    )
    this.starts.set(sessionID, { kernel, promise: start })
    return start
  }

  async release(sessionID: string): Promise<void> {
    const pending = this.starts.get(sessionID)
    if (pending) {
      await pending.kernel.shutdown()
      await pending.promise.catch(() => undefined)
      this.starts.delete(sessionID)
    }
    const kernel = this.kernels.get(sessionID)
    if (kernel) await kernel.shutdown()
    this.kernels.delete(sessionID)
  }

  active(sessionID: string): boolean {
    return this.kernels.get(sessionID)?.ready ?? false
  }

  async shutdownAll(): Promise<void> {
    for (const [id, pending] of this.starts) {
      await pending.kernel.shutdown()
      this.starts.delete(id)
    }
    for (const [id, kernel] of this.kernels) {
      await kernel.shutdown()
      this.kernels.delete(id)
    }
  }

  /** Sync variant for process-exit handlers. */
  shutdownAllSync(): void {
    for (const [id, pending] of this.starts) {
      pending.kernel.killSync()
      this.starts.delete(id)
    }
    for (const [id, kernel] of this.kernels) {
      kernel.killSync()
      this.kernels.delete(id)
    }
  }
}

/** Process-wide singleton manager. */
export const rKernels = new RKernelManager()
KernelRuntime.register(rKernels)
KernelProcessIdentity.onExit(() => rKernels.shutdownAllSync())

function clip(s: string, max = 30_000): string {
  return s.length > max ? s.slice(0, max) + "\n\n... (truncated)" : s
}

const RFields = {
  action: z.enum(["execute", "stop"]).optional().describe("Run code (default) or stop this conversation's R runtime"),
  code: z.string().optional().describe("R code to execute; required when action is execute"),
  title: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe("Short action label for this execution, for example 'Comparing survival curves'"),
  source: z
    .string()
    .trim()
    .min(1)
    .max(1024)
    .optional()
    .describe("Script path associated with this execution, when applicable"),
  environment: z
    .enum(["default", "r"])
    .optional()
    .describe("Optional compatibility selector. Omit it or use 'default'/'r' for the canonical R runtime."),
  timeout: z.number().default(120_000).describe("Execution timeout in ms (default: 120s, max: 600s)"),
}

const RParameters = z
  .object(RFields)
  .strict()
  .superRefine((params, issue) => {
    if (params.action !== "stop" && !params.code) {
      issue.addIssue({ code: "custom", path: ["code"], message: "code is required when action is execute" })
    }
  })

const CompatibilityKernelName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .optional()
  .describe("Deprecated compatibility name for an isolated runtime")

const RKernelParameters = z
  .object({ ...RFields, kernel: CompatibilityKernelName })
  .strict()
  .superRefine((params, issue) => {
    if (params.action !== "stop" && !params.code) {
      issue.addIssue({ code: "custom", path: ["code"], message: "code is required when action is execute" })
    }
  })

type RInput = z.infer<typeof RKernelParameters>

async function executeR(params: RInput, ctx: Tool.Context, compatibilityNamed: boolean) {
  const name = compatibilityNamed ? (params.kernel ?? "agent") : "r"
  const identity = {
    projectID: Instance.project.id,
    sessionID: ctx.sessionID,
    name,
    language: "r" as const,
  }
  if (params.action === "stop") {
    ctx.metadata({
      title: compatibilityNamed ? `Stopped R · ${name}` : "Stopped R",
      metadata: { kernel: name, language: "r", stopped: true },
    })
    await KernelRuntime.release(identity)
    return {
      title: compatibilityNamed ? `Stopped R · ${name}` : "Stopped R",
      output: "Managed R runtime stopped. Its in-memory state was cleared.",
      metadata: {
        kernel: name,
        language: "r",
        stopped: true,
        ok: true,
        available: true,
        output: "Managed R runtime stopped.",
      },
    }
  }
  const title = params.title ?? "R execution"
  const retryInput = { ...params, code: params.code! }
  await ToolRetryGuard.assertKernel(ctx, {
    language: "r",
    environment: "r",
    source: params.source,
    code: params.code!,
  })
  const mutation = KernelEnvironmentMutation.detect({ language: "r", environment: "r", code: params.code! })
  ctx.metadata({
    title,
    metadata: {
      kernel: name,
      language: "r",
      task: title,
      ...(mutation ? { environmentMutation: mutation } : {}),
      ...(params.source ? { source: params.source } : {}),
    },
  })

  // Discovery is metadata-only, so avoid asking for a change that cannot run.
  const bin = await findRscript()
  if (!bin) {
    const msg =
      "Rscript not found. Install R from https://www.r-project.org (or `brew install r`) so `Rscript` is on PATH."
    ctx.metadata({ metadata: { output: msg, ok: false } })
    return {
      title: "R runtime unavailable",
      output: msg,
      metadata: { kernel: name, language: "r", stopped: false, ok: false, available: false, output: msg },
    }
  }

  if (mutation) {
    await ctx.ask(KernelEnvironmentMutation.permission(mutation))
    await ExecutionAuthority.require({
      projectID: Instance.project.id,
      sessionID: ctx.sessionID,
      capability: "package_install",
    })
    await KernelRuntime.release(identity)
  } else {
    await ctx.ask({
      permission: "bash",
      patterns: ["R"],
      always: ["Rscript*"],
      metadata: {},
    })
  }

  let result: ExecuteResult
  try {
    result = await KernelRuntime.execute(
      identity,
      params.code!,
      {
        timeout: params.timeout,
        signal: ctx.abort,
        origin: { messageID: ctx.messageID, callID: ctx.callID, title, source: params.source },
      },
      KernelEnvironmentMutation.rRuntime(!!mutation),
    )
  } catch (error) {
    if (mutation) await KernelRuntime.release(identity).catch(() => undefined)
    throw ToolRetryGuard.annotateKernelTimeout(ctx, retryInput, "r", "r", error)
  }

  let restarted = false
  if (mutation) {
    if (result.ok) {
      await KernelRuntime.restart(identity, KernelEnvironmentMutation.rRuntime())
      restarted = true
    } else {
      await KernelRuntime.release(identity)
    }
  }

  const images = result.outputs.filter((o) => o.type === "display" && o.data?.["image/png"])
  const dataUrls = images.map((o) => `data:image/png;base64,${o.data!["image/png"]}`)

  const parts: string[] = []
  if (result.stdout) parts.push(result.stdout)
  if (result.stderr) parts.push(`${result.ok ? "[messages]" : "[ERROR]"}\n${result.stderr}`)
  if (images.length) parts.push(`[figure] captured ${images.length} inline image(s)`)
  if (restarted) parts.push("[environment] R packages updated; R restarted with cleared in-memory state")
  if (!parts.length) parts.push("(no output)")
  const output = clip(parts.join("\n"))

  ctx.metadata({
    title,
    metadata: {
      output,
      ok: result.ok,
      provenanceID: result.provenanceID,
      kernel: name,
      language: "r",
      task: title,
      restarted,
      ...(mutation ? { environmentMutation: mutation } : {}),
      ...(params.source ? { source: params.source } : {}),
    },
  })

  return {
    title: result.ok ? title : `${title} (error)`,
    output,
    metadata: {
      stopped: false,
      ok: result.ok,
      available: true,
      output,
      kernel: name,
      language: "r",
      task: title,
      restarted,
      ...(mutation ? { environmentMutation: mutation } : {}),
      ...(params.source ? { source: params.source } : {}),
      provenanceID: result.provenanceID,
      hasImages: images.length,
      ...(images.length ? { artifact: { kind: "image", data: { images: dataUrls } } } : {}),
    },
  }
}

const RDefinition: Awaited<ReturnType<Tool.Info<typeof RParameters>["init"]>> = {
  description: [
    "Run R in one long-lived managed process per conversation. Objects, packages, and state persist; child conversations stay isolated.",
    "Treat state as working memory, not reproducibility. For material results, save source, inputs, parameters, and outputs, then clean-rerun when practical.",
    "Omit `environment` or use `default`/`r` for the canonical runtime. Add a concise `title` and `source` for scripts; `action: stop` clears state.",
    "Prefer this over `bash Rscript`. Submit package changes separately; they require approval and automatically restart R after success.",
    "Captures output and inline base/ggplot2 PNGs. Requires Rscript on PATH; otherwise returns install guidance.",
  ].join("\n"),
  parameters: RParameters,
  execute: (params, ctx) => executeR(params, ctx, false),
}

const RKernelDefinition: Awaited<ReturnType<Tool.Info<typeof RKernelParameters>["init"]>> = {
  ...RDefinition,
  description: `${RDefinition.description}\nDeprecated compatibility alias: an existing call may still supply a runtime name.`,
  parameters: RKernelParameters,
  execute: (params, ctx) => executeR(params, ctx, true),
}

/** Canonical model-facing R tool. */
export const RTool = Tool.define("r", async () => ({ ...RDefinition }))

/** @deprecated Compatibility alias. Keep out of the advertised tool registry. */
export const RKernelTool = Tool.define("rkernel", async () => ({ ...RKernelDefinition }))

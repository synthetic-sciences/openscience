import z from "zod"
import { Tool } from "./tool"
import { spawn, type ChildProcess } from "child_process"
import path from "path"
import os from "os"
import { accessSync, constants, mkdirSync, rmSync, statSync, unlinkSync } from "fs"
import { Shell } from "@/shell/shell"
import { Instance } from "@/project/instance"
import { OpenScience } from "@/openscience"
import { SessionFilesystem } from "@/session/filesystem"
import { Sandbox } from "@/sandbox/sandbox"
import { KernelQueue } from "@/science/kernel/queue"
import { KernelProcessIdentity } from "@/science/kernel/process"
import { KernelRuntime } from "@/science/kernel/registry"
import { KernelEnvironmentName, normalizeKernelEnvironmentName } from "@/science/kernel/interpreter"
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
 * General, non-domain-gated persistent Python runtime.
 *
 * Generalizes the biology-gated kernel in `tool/biology/notebook.ts` to the
 * shared `Kernel` / `KernelManager` contract in `science/kernel/types.ts`:
 * one long-lived `python3` process per sessionID whose namespace, imports, and
 * state persist across `execute` calls, returning structured text and image
 * outputs, including `image/png` captured from any matplotlib figures the
 * execution leaves open.
 *
 * Host requirement: `python3` (or `python`) on PATH. matplotlib is optional —
 * figures are only captured when it is importable; everything else degrades to
 * text output.
 */

// The worker runs a REPL loop over stdin. Real newlines below are real newlines
// in the emitted Python source; `\\n` sequences become escaped newlines inside
// Python string literals. Result payloads are wrapped in unambiguous markers and
// JSON-encoded (json.dumps escapes real newlines, so the end marker can never
// appear inside a payload string).
const KERNEL_SCRIPT = `
import sys, json, io, base64, traceback, re, signal

_real_out = sys.stdout
_real_err = sys.stderr

ns = {"__name__": "__main__", "__builtins__": __builtins__}

# Preserve the documented pre-imported aliases without making every fresh
# kernel pay the several-second scientific stack import cost. A referenced
# alias is loaded immediately before that execution and then persists.
def _load(pkg, alias):
    if alias in ns:
        return
    try:
        mod = __import__(pkg)
        ns[alias] = mod
        ns[pkg] = mod
    except ImportError:
        pass

_plt = None

def _load_science(code):
    global _plt
    if re.search(r"\\b(np|numpy)\\b", code):
        _load("numpy", "np")
    if re.search(r"\\b(pd|pandas)\\b", code):
        _load("pandas", "pd")
    if re.search(r"\\bscipy\\b", code):
        _load("scipy", "scipy")
    if _plt is None and re.search(r"\\b(plt|matplotlib)\\b", code):
        try:
            import matplotlib
            matplotlib.use("Agg")
            import matplotlib.pyplot as plt
            _plt = plt
            ns["plt"] = plt
            ns["matplotlib"] = matplotlib
        except Exception:
            _plt = None

_exec_count = 0
_executing = False
_interrupting = False

# A persistent interpreter must treat SIGINT as an execution-scoped cancel,
# not a process-scoped exit. A wrapper or OS process tree can deliver a second
# SIGINT after the first KeyboardInterrupt has already been caught; ignore that
# trailing signal (and any signal while waiting for input) so the warm process
# reliably returns to idle with its namespace intact.
def _handle_sigint(_signum, _frame):
    global _interrupting
    if not _executing or _interrupting:
        return
    _interrupting = True
    raise KeyboardInterrupt()

signal.signal(signal.SIGINT, _handle_sigint)

_real_out.write("__OPENSCIENCE_KERNEL_READY__" + json.dumps({"version": "Python " + sys.version.split()[0]}) + "\\n")
_real_out.flush()

while True:
    lines = []
    got_end = False
    for line in sys.stdin:
        if line.rstrip("\\n") == "__OPENSCIENCE_CODE_END__":
            got_end = True
            break
        lines.append(line)
    if not got_end:
        break  # stdin closed (parent gone) -> exit cleanly

    code = "".join(lines)
    _exec_count += 1

    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()
    sys.stdout = stdout_buf
    sys.stderr = stderr_buf

    ok = True
    result_repr = None
    result_html = None
    error = None
    images = []
    _executing = True
    _interrupting = False
    _real_out.write("__OPENSCIENCE_EXECUTION_READY__\\n")
    _real_out.flush()

    try:
        _load_science(code)
        # Try eval first so a final expression can be returned without print().
        try:
            compiled = compile(code, "<python>", "eval")
        except SyntaxError:
            compiled = None
        if compiled is not None:
            value = eval(compiled, ns)
            if value is not None:
                try:
                    result_repr = repr(value)
                except Exception:
                    result_repr = "<unreprable object>"
                html_fn = getattr(value, "_repr_html_", None)
                if callable(html_fn):
                    try:
                        html = html_fn()
                        if isinstance(html, str):
                            result_html = html
                    except Exception:
                        pass
        else:
            exec(compile(code, "<python>", "exec"), ns)
    except SystemExit:
        stderr_buf.write("SystemExit caught (kernel stays alive)\\n")
        ok = False
    except BaseException as e:
        ok = False
        tb = e.__traceback__
        while tb is not None and tb.tb_frame.f_code.co_filename == __file__:
            tb = tb.tb_next
        error = {
            "name": type(e).__name__,
            "message": str(e),
            "traceback": "".join(traceback.format_exception(type(e), e, tb)).splitlines(),
        }
    finally:
        # Capture any open matplotlib figures as PNG MIME parts, then close them.
        if _plt is not None:
            try:
                for num in _plt.get_fignums():
                    fig = _plt.figure(num)
                    buf = io.BytesIO()
                    try:
                        fig.savefig(buf, format="png", bbox_inches="tight")
                        images.append(base64.b64encode(buf.getvalue()).decode("ascii"))
                    except Exception:
                        pass
                _plt.close("all")
            except Exception:
                pass
        sys.stdout = _real_out
        sys.stderr = _real_err

    payload = {
        "ok": ok,
        "stdout": stdout_buf.getvalue(),
        "stderr": stderr_buf.getvalue(),
        "result": result_repr,
        "result_html": result_html,
        "images": images,
        "error": error,
        "execution_count": _exec_count,
    }
    r = json.dumps(payload)
    _real_out.write("__OPENSCIENCE_RESULT_START__\\n" + r + "\\n__OPENSCIENCE_RESULT_END__\\n")
    _real_out.flush()
    _executing = False
    _interrupting = False
`.trim()

const READY = "__OPENSCIENCE_KERNEL_READY__"
const EXECUTION_READY = "__OPENSCIENCE_EXECUTION_READY__\n"
const START = "__OPENSCIENCE_RESULT_START__\n"
const END = "\n__OPENSCIENCE_RESULT_END__"
interface RawPayload {
  ok: boolean
  stdout: string
  stderr: string
  result: string | null
  result_html: string | null
  images: string[]
  error: { name: string; message: string; traceback?: string[] } | null
  execution_count: number
}

async function findPython(override?: string): Promise<{ binary: string; version?: string }> {
  const candidates = override ? [override] : ["python3", "python"]
  for (const bin of candidates) {
    try {
      // Resolution is metadata-only. The managed interpreter must never
      // receive a preflight `--version` execution before KernelRuntime has
      // acquired trust, authority, sandbox and durable process ownership. The
      // governed kernel reports its version in the READY frame instead.
      const binary = path.isAbsolute(bin) ? bin : Bun.which(bin)
      if (!binary || !statSync(binary).isFile()) continue
      accessSync(binary, process.platform === "win32" ? constants.F_OK : constants.X_OK)
      return { binary }
    } catch {}
  }
  throw new Error("Python not found. Install Python 3.10+ (python3) to use the python tool.")
}

function payloadToResult(p: RawPayload): ExecuteResult {
  const outputs: KernelOutput[] = []
  if (p.stdout) outputs.push({ type: "stream", name: "stdout", data: { "text/plain": p.stdout } })
  if (p.stderr) outputs.push({ type: "stream", name: "stderr", data: { "text/plain": p.stderr } })
  for (const b64 of p.images ?? []) outputs.push({ type: "display", data: { "image/png": b64 } })
  if (p.result !== null && p.result !== undefined) {
    const data: Record<string, string> = { "text/plain": p.result }
    if (p.result_html) data["text/html"] = p.result_html
    outputs.push({ type: "result", data })
  }
  if (p.error) {
    outputs.push({
      type: "error",
      error: { name: p.error.name, message: p.error.message, traceback: p.error.traceback },
    })
  }
  return {
    ok: p.ok,
    outputs,
    stdout: p.stdout ?? "",
    stderr: p.stderr ?? "",
    executionCount: p.execution_count,
  }
}

class PythonKernel implements Kernel {
  readonly id: string
  readonly language: KernelLanguage = "python"
  proc?: ChildProcess
  scriptPath?: string
  configPath?: string
  cachePath?: string
  private stderrTail = ""
  private queue = new KernelQueue()
  private intentional = false
  private executionArmed = false
  private interruptPending = false
  private interruptSent = false
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
    if (!policy) throw new Error("Python kernel start is missing its authorized sandbox policy")
    this.intentional = false
    this.stderrTail = ""
    const scriptPath = path.join(os.tmpdir(), `openscience-pykernel-${this.id.slice(0, 8)}-${Date.now()}.py`)
    const configPath = `${scriptPath}.atlas.json`
    const cachePath = path.join(os.tmpdir(), "openscience-kernel-cache", crypto.randomUUID())
    mkdirSync(cachePath, { recursive: true })
    await Bun.write(scriptPath, KERNEL_SCRIPT)
    await Bun.write(configPath, "{}\n")
    this.scriptPath = scriptPath
    this.configPath = configPath
    this.cachePath = cachePath

    const interpreter = await findPython(opts?.binary)
    const workspace = opts?.authorizedWritable
      ? [...opts.authorizedWritable]
      : opts?.sessionID
        ? await SessionFilesystem.processWriteRoots(opts.sessionID)
        : [Instance.directory, Instance.worktree]
    const readable = opts?.authorizedReadable
      ? [...opts.authorizedReadable]
      : opts?.sessionID
        ? await SessionFilesystem.processReadRoots(opts.sessionID)
        : [Instance.directory, Instance.worktree]
    // Confine the kernel to the workspace when the execution sandbox is on: the
    // runtime runs arbitrary agent-authored code — the same threat model as the
    // bash tool — so it must not be able to escape the boundary bash respects.
    const sandboxed = Sandbox.wrapArgv({
      file: interpreter.binary,
      args: ["-u", scriptPath],
      workspace,
      readable,
      extraWritable: [scriptPath, configPath, cachePath, ...(opts?.extraWritable ?? [])],
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
        name: opts?.environmentName ?? "python",
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
        env: OpenScience.kernelEnv(process.env, {
          ...OpenScience.pythonThreadCapEnv(process.env),
          ...(opts?.env ?? {}),
          ATLAS_CLI_CONFIG_PATH: configPath,
          MPLCONFIGDIR: path.join(cachePath, "matplotlib"),
          XDG_CACHE_HOME: path.join(cachePath, "xdg"),
          PYTHONPYCACHEPREFIX: path.join(cachePath, "pycache"),
          PYTHONUNBUFFERED: "1",
        }),
        stdio: ["pipe", "pipe", "pipe"],
        // Own process group so killing the kernel reaps its children too — a scanpy
        // run forks joblib/BLAS workers that would otherwise be orphaned and keep
        // thrashing swap after an abort (#102).
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
      if (!registered) throw new Error("Python kernel exited before durable process registration")
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
        reject(new Error(`Python kernel startup timed out. stderr: ${this.stderrTail}`))
      }, 15_000)
      let buf = ""
      const onData = (d: Buffer) => {
        buf += d.toString()
        if (buf.length > 64 * 1024) {
          clearTimeout(timer)
          proc.stdout?.off("data", onData)
          void this.terminate(proc)
          reject(new Error("Python kernel startup output exceeded 65536 bytes before the ready handshake"))
          return
        }
        const start = buf.indexOf(READY)
        const end = start === -1 ? -1 : buf.indexOf("\n", start)
        if (start !== -1 && end !== -1) {
          const frame = buf.slice(start + READY.length, end)
          if (frame) {
            try {
              const ready = JSON.parse(frame) as { version?: unknown }
              if (typeof ready.version === "string" && ready.version.length <= 128) {
                this.environment!.interpreter.version = ready.version
              }
            } catch {
              clearTimeout(timer)
              proc.stdout?.off("data", onData)
              void this.terminate(proc)
              reject(new Error("Python kernel returned an invalid ready handshake"))
              return
            }
          }
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
        reject(new Error(`Python kernel exited during startup (code ${code}). stderr: ${this.stderrTail}`))
      })
    })
  }

  async execute(code: string, opts?: ExecuteOptions): Promise<ExecuteResult> {
    return this.queue.run(() => this.run(code, opts), opts?.signal)
  }

  private async run(code: string, opts?: ExecuteOptions): Promise<ExecuteResult> {
    if (!this.ready) throw new Error("Python kernel is not running")
    // onStart persists the durable running record and may yield before code is
    // submitted. Remember an interrupt received in that window; the worker's
    // EXECUTION_READY frame below dispatches it only after SIGINT is armed.
    this.executionArmed = false
    this.interruptPending = false
    this.interruptSent = false
    await opts?.onStart?.()
    if (opts?.signal?.aborted) throw new Error("Execution aborted before starting")
    const proc = this.proc!
    const timeout = Math.min(Math.max(opts?.timeout ?? 120_000, 5_000), 600_000)

    const payload = await new Promise<RawPayload>((resolve, reject) => {
      const kernel = this
      let stopping = false
      const stop = (error: Error) => {
        if (stopping) return
        stopping = true
        cleanup()
        // A timed-out or aborted interpreter may still be executing user code.
        // Keep this queue slot occupied until the process group is gone and the
        // kernel has been marked unusable; otherwise the next cell can enter the
        // same poisoned process while termination is still in flight.
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
        if (!kernel.executionArmed && buffer.includes(EXECUTION_READY)) {
          kernel.executionArmed = true
          buffer = buffer.replace(EXECUTION_READY, "")
          if (kernel.interruptPending) kernel.signalInterrupt()
        }
        const s = buffer.indexOf(START)
        const e = buffer.indexOf(END)
        if (s !== -1 && e !== -1 && e > s) {
          cleanup()
          const json = buffer.slice(s + START.length, e)
          try {
            resolve(JSON.parse(json) as RawPayload)
          } catch {
            resolve({
              ok: false,
              stdout: "",
              stderr: `Kernel response parse error: ${json.slice(0, 500)}`,
              result: null,
              result_html: null,
              images: [],
              error: null,
              execution_count: -1,
            })
          }
        }
      }
      const onExit = (code: number | null) => {
        cleanup()
        reject(new Error(`Python kernel died during execution (exit code ${code}). stderr: ${this.stderrTail}`))
      }
      function cleanup() {
        clearTimeout(timer)
        proc.stdout?.off("data", onData)
        proc.off("exit", onExit)
        opts?.signal?.removeEventListener("abort", onAbort)
        kernel.executionArmed = false
        kernel.interruptPending = false
        kernel.interruptSent = false
      }

      opts?.signal?.addEventListener("abort", onAbort, { once: true })
      proc.stdout?.on("data", onData)
      proc.once("exit", onExit)
      proc.stdin?.write(code + "\n__OPENSCIENCE_CODE_END__\n")
    })

    return payloadToResult(payload)
  }

  async interrupt() {
    if (!this.proc || !this.busy || !KernelProcessIdentity.matches(this.proc, this.process)) return false
    this.interruptPending = true
    if (!this.executionArmed) return true
    return this.signalInterrupt()
  }

  private signalInterrupt() {
    if (this.interruptSent) return true
    let sent: boolean
    if (this.environment?.sandbox.backend === "bubblewrap") {
      sent = Shell.interruptDescendants(this.proc!, { exclude: ["bwrap"] })
    } else {
      sent = Shell.interruptTree(this.proc!, { detached: process.platform !== "win32" })
    }
    if (sent) {
      this.interruptSent = true
      this.interruptPending = false
    }
    return sent
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
    if (this.cachePath) rmSync(this.cachePath, { recursive: true, force: true })
    this.scriptPath = undefined
    this.configPath = undefined
    this.cachePath = undefined
  }
}

class PythonKernelManager implements KernelManager {
  readonly language: KernelLanguage = "python"
  private kernels = new Map<string, PythonKernel>()
  private starts = new Map<string, { kernel: PythonKernel; promise: Promise<PythonKernel> }>()

  async get(sessionID: string, opts?: KernelStartOptions): Promise<PythonKernel> {
    const existing = this.kernels.get(sessionID)
    if (existing && existing.ready) return existing
    if (existing) {
      await existing.shutdown()
      this.kernels.delete(sessionID)
    }
    const pending = this.starts.get(sessionID)
    if (pending) return pending.promise
    const kernel = new PythonKernel(sessionID)
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

/** Process-wide singleton manager (mirrors the biology kernel's module-level map). */
export const pythonKernels = new PythonKernelManager()
KernelRuntime.register(pythonKernels)
KernelProcessIdentity.onExit(() => pythonKernels.shutdownAllSync())

function clip(s: string, max = 30_000): string {
  return s.length > max ? s.slice(0, max) + "\n\n... (truncated)" : s
}

const PythonFields = {
  action: z.enum(["execute", "stop"]).optional().describe("Run code (default) or stop this environment's runtime"),
  code: z.string().optional().describe("Python code to execute; required when action is execute"),
  title: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .optional()
    .describe("Short action label for this execution, for example 'Benchmarking survival classifiers'"),
  source: z
    .string()
    .trim()
    .min(1)
    .max(1024)
    .optional()
    .describe("Script path associated with this execution, when applicable"),
  environment: KernelEnvironmentName.optional().describe(
    "Optional OpenScience-managed Python environment shared across projects on this machine. " +
      "Omit it or use 'default' for the Python starter; named task environments must be created through an approved package change.",
  ),
  timeout: z.number().default(120_000).describe("Execution timeout in ms (default: 120s, max: 600s)"),
}

const PythonParameters = z
  .object(PythonFields)
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

const NotebookParameters = z
  .object({ ...PythonFields, kernel: CompatibilityKernelName })
  .strict()
  .superRefine((params, issue) => {
    if (params.action !== "stop" && !params.code) {
      issue.addIssue({ code: "custom", path: ["code"], message: "code is required when action is execute" })
    }
  })

type PythonInput = z.infer<typeof NotebookParameters>

async function executePython(params: PythonInput, ctx: Tool.Context, compatibilityNamed: boolean) {
  const name = compatibilityNamed ? (params.kernel ?? "agent") : "python"
  const environment = normalizeKernelEnvironmentName(params.environment)
  const identity = {
    projectID: Instance.project.id,
    sessionID: ctx.sessionID,
    name,
    language: "python" as const,
    environmentName: environment === "python" ? undefined : environment,
  }
  if (params.action === "stop") {
    ctx.metadata({
      title: compatibilityNamed ? `Stopped Python · ${name}` : "Stopped Python",
      metadata: { kernel: name, environment, language: "python", stopped: true },
    })
    await KernelRuntime.release(identity)
    return {
      title: compatibilityNamed ? `Stopped Python · ${name}` : "Stopped Python",
      output: `Managed Python runtime for ${environment} stopped. Its in-memory state was cleared.`,
      metadata: {
        kernel: name,
        environment,
        language: "python",
        stopped: true,
        ok: true,
        output: `Managed Python runtime for ${environment} stopped.`,
      },
    }
  }
  const title = params.title ?? "Python execution"
  const retryInput = { ...params, environment, code: params.code! }
  await ToolRetryGuard.assertKernel(ctx, {
    language: "python",
    environment,
    source: params.source,
    code: params.code!,
  })
  const mutation = KernelEnvironmentMutation.detect({
    language: "python",
    environment,
    code: params.code!,
  })
  ctx.metadata({
    title,
    metadata: {
      kernel: name,
      environment,
      language: "python",
      task: title,
      ...(mutation ? { environmentMutation: mutation } : {}),
      ...(params.source ? { source: params.source } : {}),
    },
  })

  if (mutation) {
    await ctx.ask(KernelEnvironmentMutation.permission(mutation))
    await ExecutionAuthority.require({
      projectID: Instance.project.id,
      sessionID: ctx.sessionID,
      capability: "package_install",
    })
    // A mutation never inherits the current warm process. Start a clean,
    // narrowly-writable incarnation, then replace it with an ordinary process
    // so elevated environment writes cannot leak into later analysis code.
    await KernelRuntime.release(identity)
  } else {
    // Executes arbitrary code — same permission gate as bash.
    await ctx.ask({
      permission: "bash",
      patterns: ["python"],
      always: ["python*"],
      metadata: {},
    })
  }

  const runtime = await KernelEnvironmentMutation.pythonRuntime(environment, !!mutation)
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
      runtime,
    )
  } catch (error) {
    if (mutation) await KernelRuntime.release(identity).catch(() => undefined)
    throw ToolRetryGuard.annotateKernelTimeout(ctx, retryInput, "python", environment, error)
  }

  let restarted = false
  if (mutation) {
    if (result.ok) {
      await KernelRuntime.restart(identity, await KernelEnvironmentMutation.pythonRuntime(environment))
      restarted = true
    } else {
      await KernelRuntime.release(identity)
    }
  }

  const images = result.outputs.filter((o) => o.type === "display" && o.data?.["image/png"])
  const dataUrls = images.map((o) => `data:image/png;base64,${o.data!["image/png"]}`)

  const parts: string[] = []
  if (result.stdout) parts.push(result.stdout)
  if (result.stderr) parts.push(result.ok ? `[stderr]\n${result.stderr}` : `[stderr]\n${result.stderr}`)
  const resultOut = result.outputs.find((o) => o.type === "result")
  if (resultOut?.data?.["text/plain"]) parts.push(resultOut.data["text/plain"])
  const errOut = result.outputs.find((o) => o.type === "error")
  if (errOut?.error) {
    const tb = errOut.error.traceback?.join("\n") ?? `${errOut.error.name}: ${errOut.error.message}`
    parts.push(`[ERROR]\n${tb}`)
  }
  if (images.length) parts.push(`[figure] captured ${images.length} inline image(s)`)
  if (restarted) parts.push(`[environment] ${environment} updated; Python restarted with cleared in-memory state`)
  if (!parts.length) parts.push("(no output)")
  const output = clip(parts.join("\n"))

  ctx.metadata({
    title,
    metadata: {
      output,
      ok: result.ok,
      provenanceID: result.provenanceID,
      kernel: name,
      environment,
      language: "python",
      task: title,
      restarted,
      ...(result.files?.length ? { files: result.files } : {}),
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
      output,
      kernel: name,
      environment,
      language: "python",
      task: title,
      restarted,
      ...(result.files?.length ? { files: result.files } : {}),
      ...(mutation ? { environmentMutation: mutation } : {}),
      ...(params.source ? { source: params.source } : {}),
      provenanceID: result.provenanceID,
      executionCount: result.executionCount,
      hasImages: images.length,
      ...(images.length ? { artifact: { kind: "image", data: { images: dataUrls } } } : {}),
    },
  }
}

const PythonDefinition: Awaited<ReturnType<Tool.Info<typeof PythonParameters>["init"]>> = {
  description: [
    "Run Python in one long-lived managed process per conversation and selected environment. State persists across calls; child conversations and other environments are isolated.",
    "Treat state as working memory, not reproducibility. Save code, inputs, parameters, and outputs for material results; clean-rerun when practical.",
    "`environment` defaults to the shared Python starter. Approved package changes can create named machine-wide environments reusable across projects.",
    "Set a concise `title`; set `source` for script-backed work. `action: stop` clears that environment.",
    "Prefer this over `bash python`. Submit pip changes separately with sys.executable + subprocess; approval is required and will automatically restart this environment after success.",
    "Execution starts in Session scratch, so relative outputs stay there. Approved Project paths support durable edits; other external paths remain sandboxed.",
    "np, pd, scipy, and plt load lazily; final expressions return and matplotlib figures become inline PNGs.",
  ].join("\n"),
  parameters: PythonParameters,
  execute: (params, ctx) => executePython(params, ctx, false),
}

const NotebookDefinition: Awaited<ReturnType<Tool.Info<typeof NotebookParameters>["init"]>> = {
  ...PythonDefinition,
  description: `${PythonDefinition.description}\nDeprecated compatibility alias: an existing call may still supply a runtime name.`,
  parameters: NotebookParameters,
  execute: (params, ctx) => executePython(params, ctx, true),
}

/** Canonical model-facing Python tool. */
export const PythonTool = Tool.define("python", async () => ({ ...PythonDefinition }))

/** @deprecated Compatibility alias. Keep out of the advertised tool registry. */
export const NotebookTool = Tool.define("notebook", async () => ({ ...NotebookDefinition }))

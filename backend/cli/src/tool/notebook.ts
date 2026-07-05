import z from "zod"
import { Tool } from "./tool"
import { spawn, type ChildProcess } from "child_process"
import path from "path"
import os from "os"
import { unlinkSync } from "fs"
import { Instance } from "@/project/instance"
import { OpenScience } from "@/openscience"
import type {
  Kernel,
  KernelManager,
  KernelLanguage,
  KernelStartOptions,
  ExecuteOptions,
  ExecuteResult,
  KernelOutput,
} from "@/science/kernel/types"

/**
 * General, non-domain-gated persistent Python kernel.
 *
 * Generalizes the biology-gated kernel in `tool/biology/notebook.ts` to the
 * shared `Kernel` / `KernelManager` contract in `science/kernel/types.ts`:
 * one long-lived `python3` process per sessionID whose namespace, imports, and
 * state persist across `execute` calls, returning Jupyter-style MIME-bundle
 * outputs — including `image/png` captured from any matplotlib figures the cell
 * leaves open.
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
import sys, json, io, base64, traceback

_real_out = sys.stdout
_real_err = sys.stderr

ns = {"__name__": "__main__", "__builtins__": __builtins__}

# Pre-import common scientific packages (best-effort).
for pkg, alias in [("numpy", "np"), ("pandas", "pd"), ("scipy", "scipy")]:
    try:
        mod = __import__(pkg)
        ns[alias] = mod
        ns[pkg] = mod
    except ImportError:
        pass

# Configure matplotlib for headless PNG capture (best-effort).
_plt = None
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

_real_out.write("__OPENSCIENCE_KERNEL_READY__\\n")
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

    try:
        # Try eval first for Jupyter-style auto-display of the final expression.
        try:
            compiled = compile(code, "<cell>", "eval")
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
        except SyntaxError:
            exec(compile(code, "<cell>", "exec"), ns)
    except SystemExit:
        stderr_buf.write("SystemExit caught (kernel stays alive)\\n")
        ok = False
    except BaseException as e:
        ok = False
        error = {
            "name": type(e).__name__,
            "message": str(e),
            "traceback": traceback.format_exc().splitlines(),
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
`.trim()

const READY = "__OPENSCIENCE_KERNEL_READY__"
const START = "__OPENSCIENCE_RESULT_START__\n"
const END = "\n__OPENSCIENCE_RESULT_END__"
const IDLE_MS = 30 * 60 * 1000 // reap kernels idle for 30 min

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

async function findPython(override?: string): Promise<string> {
  const candidates = override ? [override] : ["python3", "python"]
  for (const bin of candidates) {
    try {
      const proc = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "pipe" })
      await proc.exited
      if (proc.exitCode === 0) return bin
    } catch {}
  }
  throw new Error("Python not found. Install Python 3.10+ (python3) to use the notebook tool.")
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
  lastUsed = Date.now()
  private stderrTail = ""

  constructor(id: string) {
    this.id = id
  }

  get ready(): boolean {
    return !!this.proc && !this.proc.killed && this.proc.exitCode === null
  }

  async start(opts?: KernelStartOptions): Promise<void> {
    if (this.ready) return
    const scriptPath = path.join(os.tmpdir(), `openscience-pykernel-${this.id.slice(0, 8)}-${Date.now()}.py`)
    await Bun.write(scriptPath, KERNEL_SCRIPT)
    this.scriptPath = scriptPath

    const bin = await findPython(opts?.binary)
    const proc = spawn(bin, ["-u", scriptPath], {
      cwd: opts?.cwd ?? Instance.directory,
      env: { ...(await OpenScience.subprocessEnv(process.env)), ...(opts?.env ?? {}), PYTHONUNBUFFERED: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    })
    this.proc = proc

    proc.stderr?.on("data", (d: Buffer) => {
      this.stderrTail += d.toString()
      if (this.stderrTail.length > 10_000) this.stderrTail = this.stderrTail.slice(-5000)
    })

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        try {
          proc.kill()
        } catch {}
        reject(new Error(`Python kernel startup timed out. stderr: ${this.stderrTail}`))
      }, 15_000)
      let buf = ""
      const onData = (d: Buffer) => {
        buf += d.toString()
        if (buf.includes(READY)) {
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
    if (!this.ready) await this.start()
    const proc = this.proc!
    this.lastUsed = Date.now()
    const timeout = Math.min(Math.max(opts?.timeout ?? 120_000, 5_000), 600_000)

    const payload = await new Promise<RawPayload>((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup()
        try {
          proc.kill()
        } catch {}
        reject(new Error(`Cell execution timed out after ${Math.round(timeout / 1000)}s`))
      }, timeout)

      const onAbort = () => {
        cleanup()
        try {
          proc.kill()
        } catch {}
        reject(new Error("Execution aborted"))
      }

      let buffer = ""
      const onData = (d: Buffer) => {
        buffer += d.toString()
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
      }

      opts?.signal?.addEventListener("abort", onAbort, { once: true })
      proc.stdout?.on("data", onData)
      proc.once("exit", onExit)
      proc.stdin?.write(code + "\n__OPENSCIENCE_CODE_END__\n")
    })

    return payloadToResult(payload)
  }

  async shutdown(): Promise<void> {
    try {
      this.proc?.kill()
    } catch {}
    if (this.scriptPath) {
      try {
        unlinkSync(this.scriptPath)
      } catch {}
      this.scriptPath = undefined
    }
  }
}

class PythonKernelManager implements KernelManager {
  readonly language: KernelLanguage = "python"
  private kernels = new Map<string, PythonKernel>()

  private reapIdle() {
    const now = Date.now()
    for (const [id, k] of this.kernels) {
      if (now - k.lastUsed > IDLE_MS || !k.ready) {
        k.shutdown()
        this.kernels.delete(id)
      }
    }
  }

  async get(sessionID: string, opts?: KernelStartOptions): Promise<PythonKernel> {
    this.reapIdle()
    const existing = this.kernels.get(sessionID)
    if (existing && existing.ready) {
      existing.lastUsed = Date.now()
      return existing
    }
    if (existing) {
      await existing.shutdown()
      this.kernels.delete(sessionID)
    }
    const kernel = new PythonKernel(sessionID)
    await kernel.start(opts)
    this.kernels.set(sessionID, kernel)
    return kernel
  }

  async release(sessionID: string): Promise<void> {
    const k = this.kernels.get(sessionID)
    if (!k) return
    await k.shutdown()
    this.kernels.delete(sessionID)
  }

  async shutdownAll(): Promise<void> {
    for (const [id, k] of this.kernels) {
      await k.shutdown()
      this.kernels.delete(id)
    }
  }
}

/** Process-wide singleton manager (mirrors the biology kernel's module-level map). */
export const pythonKernels = new PythonKernelManager()

let exitHooked = false
function hookExit() {
  if (exitHooked) return
  exitHooked = true
  const cleanup = () => void pythonKernels.shutdownAll()
  process.on("exit", cleanup)
  process.on("SIGTERM", cleanup)
  process.on("SIGINT", cleanup)
}
hookExit()

function clip(s: string, max = 30_000): string {
  return s.length > max ? s.slice(0, max) + "\n\n... (truncated)" : s
}

export const NotebookTool = Tool.define("notebook", {
  description: [
    "Execute Python code in a persistent kernel. Variables, imports, and state persist across calls.",
    "Use instead of `bash python` for analysis — no need to re-import or re-load data between cells.",
    "numpy (np), pandas (pd), scipy, and matplotlib (plt) are pre-imported. Expression results auto-display like Jupyter.",
    "matplotlib figures are captured as inline PNG images. Not gated to any agent.",
  ].join("\n"),
  parameters: z.object({
    code: z.string().describe("Python code to execute in the persistent kernel"),
    timeout: z.number().default(120_000).describe("Execution timeout in ms (default: 120s, max: 600s)"),
  }),
  async execute(params, ctx) {
    // Executes arbitrary code — same permission gate as bash.
    await ctx.ask({
      permission: "bash",
      patterns: ["python (notebook)"],
      always: ["python*"],
      metadata: {},
    })

    const kernel = await pythonKernels.get(ctx.sessionID)
    const result = await kernel.execute(params.code, { timeout: params.timeout, signal: ctx.abort })

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
    if (!parts.length) parts.push("(no output)")
    const output = clip(parts.join("\n"))

    ctx.metadata({
      metadata: { output, ok: result.ok },
    })

    return {
      title: result.ok ? "Python cell" : "Python cell (error)",
      output,
      metadata: {
        ok: result.ok,
        output,
        executionCount: result.executionCount,
        hasImages: images.length,
        ...(images.length ? { artifact: { kind: "image", data: { images: dataUrls } } } : {}),
      },
    }
  },
})

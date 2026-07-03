import z from "zod"
import { Tool } from "../tool"
import { spawn, type ChildProcess } from "child_process"
import path from "path"
import os from "os"
import { Instance } from "@/project/instance"
import { OpenScience } from "@/openscience"

const KERNEL_SCRIPT = `
import sys, json, io, traceback, os

_out = sys.stdout
_err = sys.stderr

ns = {"__name__": "__main__", "__builtins__": __builtins__}

# Pre-import common scientific packages
for pkg, alias in [("numpy", "np"), ("pandas", "pd"), ("scipy", "scipy")]:
    try:
        mod = __import__(pkg)
        ns[alias] = mod
        ns[pkg] = mod
    except ImportError:
        pass

_out.write("__OPENSCIENCE_KERNEL_READY__\\n")
_out.flush()

while True:
    lines = []
    try:
        for line in sys.stdin:
            if line.rstrip("\\n") == "__OPENSCIENCE_CODE_END__":
                break
            lines.append(line)
    except EOFError:
        break

    if not lines:
        continue

    code = "".join(lines)
    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()
    sys.stdout = stdout_buf
    sys.stderr = stderr_buf

    ok = True
    try:
        # Try eval first for expression auto-display (like Jupyter)
        try:
            compiled = compile(code, "<cell>", "eval")
            result = eval(compiled, ns)
            if result is not None:
                print(repr(result))
        except SyntaxError:
            exec(compile(code, "<cell>", "exec"), ns)
    except SystemExit:
        stderr_buf.write("SystemExit caught (kernel stays alive)\\n")
        ok = False
    except Exception:
        traceback.print_exc()
        ok = False
    finally:
        sys.stdout = _out
        sys.stderr = _err

    r = json.dumps({"ok": ok, "stdout": stdout_buf.getvalue(), "stderr": stderr_buf.getvalue()})
    _out.write("__OPENSCIENCE_RESULT_START__\\n" + r + "\\n__OPENSCIENCE_RESULT_END__\\n")
    _out.flush()
`.trim()

interface Kernel {
  process: ChildProcess
  scriptPath: string
  lastUsed: number
}

const kernels = new Map<string, Kernel>()

// Clean up all kernels on process exit
function cleanupAll() {
  for (const [id, kernel] of kernels) {
    try {
      kernel.process.kill()
    } catch {}
    try {
      require("fs").unlinkSync(kernel.scriptPath)
    } catch {}
    kernels.delete(id)
  }
}

process.on("exit", cleanupAll)
process.on("SIGTERM", cleanupAll)
process.on("SIGINT", cleanupAll)

function cleanupIdle() {
  const now = Date.now()
  const idle = 30 * 60 * 1000 // 30 min
  for (const [id, kernel] of kernels) {
    if (now - kernel.lastUsed > idle) {
      try {
        kernel.process.kill()
      } catch {}
      try {
        require("fs").unlinkSync(kernel.scriptPath)
      } catch {}
      kernels.delete(id)
    }
  }
}

async function getKernel(sessionID: string): Promise<Kernel> {
  // Clean up idle kernels while we're here
  cleanupIdle()

  const existing = kernels.get(sessionID)
  if (existing && !existing.process.killed && existing.process.exitCode === null) {
    existing.lastUsed = Date.now()
    return existing
  }

  // Dead kernel — clean up
  if (existing) {
    try {
      require("fs").unlinkSync(existing.scriptPath)
    } catch {}
    kernels.delete(sessionID)
  }

  // Start new kernel
  const scriptPath = path.join(os.tmpdir(), `openscience-kernel-${sessionID.slice(0, 8)}-${Date.now()}.py`)
  await Bun.write(scriptPath, KERNEL_SCRIPT)

  const pythonBin = await findPython()
  const proc = spawn(pythonBin, ["-u", scriptPath], {
    cwd: Instance.directory,
    env: { ...(await OpenScience.subprocessEnv(process.env)), PYTHONUNBUFFERED: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  })

  // Collect kernel stderr (startup warnings, etc.)
  let kernelStderr = ""
  proc.stderr?.on("data", (data: Buffer) => {
    kernelStderr += data.toString()
    // Cap stderr buffer
    if (kernelStderr.length > 10_000) kernelStderr = kernelStderr.slice(-5000)
  })

  // Wait for ready signal
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      proc.kill()
      reject(new Error(`Kernel startup timed out. stderr: ${kernelStderr}`))
    }, 15_000)

    let buf = ""
    const handler = (data: Buffer) => {
      buf += data.toString()
      if (buf.includes("__OPENSCIENCE_KERNEL_READY__")) {
        clearTimeout(timeout)
        proc.stdout?.off("data", handler)
        resolve()
      }
    }
    proc.stdout?.on("data", handler)
    proc.once("error", (err) => {
      clearTimeout(timeout)
      reject(err)
    })
    proc.once("exit", (code) => {
      clearTimeout(timeout)
      reject(new Error(`Kernel exited during startup (code ${code}). stderr: ${kernelStderr}`))
    })
  })

  const kernel: Kernel = { process: proc, scriptPath, lastUsed: Date.now() }
  kernels.set(sessionID, kernel)
  return kernel
}

function executeInKernel(
  kernel: Kernel,
  code: string,
  timeout: number,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      // Kill the timed-out kernel — it will be restarted on next call
      try {
        kernel.process.kill()
      } catch {}
      reject(new Error(`Cell execution timed out after ${Math.round(timeout / 1000)}s`))
    }, timeout)

    let buffer = ""
    const handler = (data: Buffer) => {
      buffer += data.toString()
      const startMarker = "__OPENSCIENCE_RESULT_START__\n"
      const endMarker = "\n__OPENSCIENCE_RESULT_END__"
      const startIdx = buffer.indexOf(startMarker)
      const endIdx = buffer.indexOf(endMarker)

      if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
        clearTimeout(timer)
        kernel.process.stdout?.off("data", handler)
        const json = buffer.slice(startIdx + startMarker.length, endIdx)
        try {
          resolve(JSON.parse(json))
        } catch {
          resolve({ ok: false, stdout: "", stderr: `Kernel response parse error: ${json.slice(0, 500)}` })
        }
      }
    }

    const exitHandler = (code: number | null) => {
      clearTimeout(timer)
      kernel.process.stdout?.off("data", handler)
      reject(new Error(`Kernel died during execution (exit code ${code})`))
    }

    kernel.process.stdout?.on("data", handler)
    kernel.process.once("exit", exitHandler)
    kernel.process.stdin?.write(code + "\n__OPENSCIENCE_CODE_END__\n")
  })
}

async function findPython(): Promise<string> {
  for (const bin of ["python3", "python"]) {
    try {
      const proc = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "pipe" })
      await proc.exited
      if (proc.exitCode === 0) return bin
    } catch {}
  }
  throw new Error("Python not found. Install Python 3.10+ to use the notebook tool.")
}

export const NotebookTool = Tool.define("notebook", {
  description: [
    "Execute Python code in a persistent kernel. Variables, imports, and state persist across calls.",
    "Use instead of `bash python` for analysis — no need to re-import or re-load data between cells.",
    "numpy (np), pandas (pd), scipy are pre-imported. Expression results auto-display like Jupyter.",
  ].join("\n"),
  parameters: z.object({
    code: z.string().describe("Python code to execute in the persistent kernel"),
    timeout: z.number().default(120_000).describe("Execution timeout in ms (default: 120s, max: 600s)"),
  }),
  async execute(params, ctx) {
    const timeout = Math.min(Math.max(params.timeout, 5_000), 600_000)

    // Same permission as bash — this executes arbitrary code
    await ctx.ask({
      permission: "bash",
      patterns: ["python (notebook)"],
      always: ["python*"],
      metadata: {},
    })

    const kernel = await getKernel(ctx.sessionID)
    const result = await executeInKernel(kernel, params.code, timeout)

    // Stream metadata updates for the UI
    ctx.metadata({
      metadata: {
        output: result.stdout || result.stderr || "(no output)",
        ok: result.ok,
      },
    })

    const parts: string[] = []
    if (result.stdout) parts.push(result.stdout)
    if (result.stderr) {
      parts.push(result.ok ? `[stderr]\n${result.stderr}` : `[ERROR]\n${result.stderr}`)
    }
    if (!parts.length) parts.push("(no output)")

    const output = parts.join("\n")

    return {
      title: result.ok ? "Python cell" : "Python cell (error)",
      output,
      metadata: {
        ok: result.ok,
        output: output.length > 30_000 ? output.slice(0, 30_000) + "\n\n..." : output,
      },
    }
  },
})

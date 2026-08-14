import z from "zod"
import { Tool } from "../tool"
import { spawn } from "child_process"
import path from "path"
import os from "os"
import { mkdirSync, rmSync } from "fs"
import { Shell } from "@/shell/shell"
import { Instance } from "@/project/instance"
import { OpenScience } from "@/openscience"
import { Sandbox } from "@/sandbox/sandbox"
import { ExecutionAuthority } from "@/project/execution"
import { AuthoritySignal } from "@/project/authority-signal"
import { AuthorityProcessLedger } from "@/project/authority-process"
import { WindowsJobLauncher } from "@/process/windows-job-launcher"
import { BiologyKernelLifecycle } from "./kernel-lifecycle"

const KERNEL_SCRIPT = `
import sys, json, io, traceback, os, re

_out = sys.stdout
_err = sys.stderr

ns = {"__name__": "__main__", "__builtins__": __builtins__}

def _load(pkg, alias):
    if alias in ns:
        return
    try:
        mod = __import__(pkg)
        ns[alias] = mod
        ns[pkg] = mod
    except ImportError:
        pass

def _load_science(code):
    if re.search(r"\\b(np|numpy)\\b", code):
        _load("numpy", "np")
    if re.search(r"\\b(pd|pandas)\\b", code):
        _load("pandas", "pd")
    if re.search(r"\\bscipy\\b", code):
        _load("scipy", "scipy")

_out.write("__OPENSCIENCE_KERNEL_READY__\\n")
_out.flush()

while True:
    lines = []
    got_end = False
    try:
        for line in sys.stdin:
            if line.rstrip("\\n") == "__OPENSCIENCE_CODE_END__":
                got_end = True
                break
            lines.append(line)
    except EOFError:
        break

    # A dead parent closes stdin. Treat that as the lifecycle boundary instead
    # of spinning forever on repeated EOF with an empty input buffer.
    if not got_end:
        break

    code = "".join(lines)
    stdout_buf = io.StringIO()
    stderr_buf = io.StringIO()
    sys.stdout = stdout_buf
    sys.stderr = stderr_buf

    ok = True
    try:
        _load_science(code)
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

/** Exact worker source used by the lifecycle regression without duplicating
 * the interpreter protocol in the test. */
export function biologyKernelScriptForTests() {
  return KERNEL_SCRIPT
}

type Kernel = BiologyKernelLifecycle.Kernel
const kernels = BiologyKernelLifecycle.kernels
const executionQueues = new Map<string, Promise<void>>()

async function serialize<T>(sessionID: string, action: () => Promise<T>): Promise<T> {
  const previous = executionQueues.get(sessionID) ?? Promise.resolve()
  let release!: () => void
  const current = new Promise<void>((resolve) => {
    release = resolve
  })
  const tail = previous.catch(() => undefined).then(() => current)
  executionQueues.set(sessionID, tail)
  await previous.catch(() => undefined)
  try {
    return await action()
  } finally {
    release()
    if (executionQueues.get(sessionID) === tail) executionQueues.delete(sessionID)
  }
}

const removeKernel = BiologyKernelLifecycle.remove

export function shutdownBiologyKernels() {
  BiologyKernelLifecycle.cleanupAll()
}

export async function releaseBiologySession(projectID: string, sessionID: string) {
  await BiologyKernelLifecycle.releaseSession(projectID, sessionID)
}

export async function releaseBiologyProject(projectID: string) {
  await BiologyKernelLifecycle.releaseProject(projectID)
}

async function cleanupIdle() {
  const now = Date.now()
  const idle = 30 * 60 * 1000 // 30 min
  for (const [id, kernel] of kernels) {
    if (now - kernel.lastUsed > idle) {
      await AuthorityProcessLedger.revoke({ id: kernel.authorityID, kind: "biology" })
      removeKernel(id, kernel)
    }
  }
}

async function getKernel(sessionID: string): Promise<Kernel> {
  const authority = await ExecutionAuthority.require({
    projectID: Instance.project.id,
    sessionID,
    capability: "kernel",
  })
  // Clean up idle kernels while we're here
  await cleanupIdle()

  const existing = kernels.get(sessionID)
  if (
    existing &&
    existing.generation === authority.generation &&
    !existing.process.killed &&
    existing.process.exitCode === null
  ) {
    existing.lastUsed = Date.now()
    return existing
  }

  // Dead kernel — clean up
  if (existing) {
    await AuthorityProcessLedger.revoke({ id: existing.authorityID, kind: "biology" })
    removeKernel(sessionID, existing)
  }

  // Start new kernel
  const scriptPath = path.join(os.tmpdir(), `openscience-kernel-${sessionID.slice(0, 8)}-${Date.now()}.py`)
  const configPath = `${scriptPath}.atlas.json`
  const cachePath = path.join(os.tmpdir(), "openscience-kernel-cache", crypto.randomUUID())
  mkdirSync(cachePath, { recursive: true })
  await Bun.write(scriptPath, KERNEL_SCRIPT)
  await Bun.write(configPath, "{}\n")

  const pythonBin = await findPython()
  const launched = await AuthoritySignal.exclusive(async () => {
    const current = await ExecutionAuthority.require({
      projectID: Instance.project.id,
      sessionID,
      capability: "kernel",
    })
    // Confine the kernel to the workspace when execution sandboxing is on: it
    // runs arbitrary agent-authored code and shares Bash's threat model.
    const sandboxed = Sandbox.wrapArgv({
      file: pythonBin,
      args: ["-u", scriptPath],
      workspace: current.writable,
      readable: current.readable,
      extraWritable: [scriptPath, configPath, cachePath],
      unreadable: OpenScience.kernelSensitivePaths(),
      options: current.sandbox,
    })
    const launch = WindowsJobLauncher.wrap({ file: sandboxed.file, args: sandboxed.args })
    const proc = (() => {
      try {
        return spawn(launch.file, launch.args, {
          cwd: current.workspace,
          env: {
            ...OpenScience.kernelEnv(process.env),
            ...OpenScience.pythonThreadCapEnv(process.env),
            ATLAS_CLI_CONFIG_PATH: configPath,
            MPLCONFIGDIR: path.join(cachePath, "matplotlib"),
            XDG_CACHE_HOME: path.join(cachePath, "xdg"),
            PYTHONPYCACHEPREFIX: path.join(cachePath, "pycache"),
            PYTHONUNBUFFERED: "1",
          },
          stdio: ["pipe", "pipe", "pipe"],
          // Own process group so killing the kernel reaps its joblib/BLAS children (#102).
          detached: process.platform !== "win32",
        })
      } catch (error) {
        Sandbox.cleanup(sandboxed)
        throw error
      }
    })()
    const authorityID = `biology-${crypto.randomUUID()}`
    let exited = false
    const complete = () => {
      exited = true
      Sandbox.cleanup(sandboxed)
      void AuthorityProcessLedger.complete(authorityID).catch(() => undefined)
    }
    proc.once("exit", complete)
    proc.once("error", complete)
    if (!proc.pid) {
      await Shell.killTree(proc, { detached: process.platform !== "win32" })
      Sandbox.cleanup(sandboxed)
      throw new Error("Biology kernel started without a process id")
    }
    const registered = await AuthorityProcessLedger.register({
      id: authorityID,
      kind: "biology",
      pid: proc.pid,
      projectID: Instance.project.id,
      sessionID,
      authorityGeneration: current.generation,
      windowsRelease: launch.release,
    }).catch(async (error) => {
      await AuthorityProcessLedger.revoke({ id: authorityID, kind: "biology" }).catch(() => undefined)
      await Shell.killTree(proc, {
        exited: () => proc.exitCode !== null,
        detached: process.platform !== "win32",
      })
      Sandbox.cleanup(sandboxed)
      throw error
    })
    if (!registered || exited) {
      await AuthorityProcessLedger.revoke({ id: authorityID, kind: "biology" })
      Sandbox.cleanup(sandboxed)
      throw new Error("Biology kernel exited before durable authority registration")
    }
    const kernel: Kernel = {
      process: proc,
      projectID: Instance.project.id,
      scriptPath,
      configPath,
      cachePath,
      lastUsed: Date.now(),
      generation: current.generation,
      authorityID,
    }
    kernels.set(sessionID, kernel)
    return kernel
  }).catch((error) => {
    rmSync(scriptPath, { force: true })
    rmSync(configPath, { force: true })
    rmSync(cachePath, { recursive: true, force: true })
    throw error
  })
  const proc = launched.process

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
      void AuthorityProcessLedger.revoke({ id: launched.authorityID, kind: "biology" }).then(
        () => reject(new Error(`Kernel startup timed out. stderr: ${kernelStderr}`)),
        reject,
      )
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

  return launched
}

function executeInKernel(
  kernel: Kernel,
  code: string,
  timeout: number,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      kernel.process.stdout?.off("data", handler)
      kernel.process.off("exit", exitHandler)
      // Durable group revocation is identity-checked and includes joblib/BLAS
      // workers; reject only after teardown is acknowledged.
      void AuthorityProcessLedger.revoke({ id: kernel.authorityID, kind: "biology" }).then(
        () => reject(new Error(`Cell execution timed out after ${Math.round(timeout / 1000)}s`)),
        reject,
      )
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
        kernel.process.off("exit", exitHandler)
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

    return serialize(ctx.sessionID, async () => {
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
    })
  },
})

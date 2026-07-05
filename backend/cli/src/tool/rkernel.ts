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
 * Persistent R kernel, following the same pattern as the Python kernel in
 * `tool/notebook.ts` and the biology kernel it generalizes.
 *
 * One long-lived `Rscript` process per sessionID evaluates cells into the global
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
run_cell <- function(code) {
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
cat("__OPENSCIENCE_KERNEL_READY__\\n")
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
  tryCatch(run_cell(code), error = function(e) {
    cat("__OPENSCIENCE_R_RESULT_START__\\nOK:0\\nIMG:\\n__OPENSCIENCE_R_OUT__\\n\\n__OPENSCIENCE_R_MSG__\\nError: ", conditionMessage(e), "\\n__OPENSCIENCE_R_END__\\n", sep = "")
    flush(stdout())
  })
}
`.trim()

const READY = "__OPENSCIENCE_KERNEL_READY__"
const START = "__OPENSCIENCE_R_RESULT_START__\n"
const END = "\n__OPENSCIENCE_R_END__"
const IDLE_MS = 30 * 60 * 1000

async function findRscript(override?: string): Promise<string | null> {
  const candidates = override ? [override] : ["Rscript"]
  for (const bin of candidates) {
    try {
      const proc = Bun.spawn([bin, "--version"], { stdout: "pipe", stderr: "pipe" })
      await proc.exited
      if (proc.exitCode === 0) return bin
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
    const bin = await findRscript(opts?.binary)
    if (!bin) {
      throw new Error(
        "Rscript not found. Install R (https://www.r-project.org) so `Rscript` is on PATH to use the R kernel.",
      )
    }

    const scriptPath = path.join(os.tmpdir(), `openscience-rkernel-${this.id.slice(0, 8)}-${Date.now()}.R`)
    await Bun.write(scriptPath, KERNEL_SCRIPT)
    this.scriptPath = scriptPath

    const proc = spawn(bin, ["--vanilla", scriptPath], {
      cwd: opts?.cwd ?? Instance.directory,
      env: { ...(await OpenScience.subprocessEnv(process.env)), ...(opts?.env ?? {}) },
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
        reject(new Error(`R kernel startup timed out. stderr: ${this.stderrTail}`))
      }, 20_000)
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
        reject(new Error(`R kernel exited during startup (code ${code}). stderr: ${this.stderrTail}`))
      })
    })
  }

  async execute(code: string, opts?: ExecuteOptions): Promise<ExecuteResult> {
    if (!this.ready) await this.start()
    const proc = this.proc!
    this.lastUsed = Date.now()
    const timeout = Math.min(Math.max(opts?.timeout ?? 120_000, 5_000), 600_000)

    const raw = await new Promise<RawResult>((resolve, reject) => {
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

class RKernelManager implements KernelManager {
  readonly language: KernelLanguage = "r"
  private kernels = new Map<string, RKernel>()

  private reapIdle() {
    const now = Date.now()
    for (const [id, k] of this.kernels) {
      if (now - k.lastUsed > IDLE_MS || !k.ready) {
        k.shutdown()
        this.kernels.delete(id)
      }
    }
  }

  async get(sessionID: string, opts?: KernelStartOptions): Promise<RKernel> {
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
    const kernel = new RKernel(sessionID)
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

/** Process-wide singleton manager. */
export const rKernels = new RKernelManager()

let exitHooked = false
function hookExit() {
  if (exitHooked) return
  exitHooked = true
  const cleanup = () => void rKernels.shutdownAll()
  process.on("exit", cleanup)
  process.on("SIGTERM", cleanup)
  process.on("SIGINT", cleanup)
}
hookExit()

function clip(s: string, max = 30_000): string {
  return s.length > max ? s.slice(0, max) + "\n\n... (truncated)" : s
}

export const RKernelTool = Tool.define("rkernel", {
  description: [
    "Execute R code in a persistent kernel. Objects, attached packages, and state persist across calls.",
    "Use instead of `bash Rscript` for analysis — no need to re-source data or reload packages between cells.",
    "Print output is captured; base-graphics and ggplot2 plots are captured as inline PNG images where the platform supports it.",
    "Requires Rscript on PATH; if R is not installed the tool reports a clear install hint.",
  ].join("\n"),
  parameters: z.object({
    code: z.string().describe("R code to execute in the persistent kernel"),
    timeout: z.number().default(120_000).describe("Execution timeout in ms (default: 120s, max: 600s)"),
  }),
  async execute(params, ctx) {
    // Executes arbitrary code — same permission gate as bash.
    await ctx.ask({
      permission: "bash",
      patterns: ["R (rkernel)"],
      always: ["Rscript*"],
      metadata: {},
    })

    // Degrade gracefully when R is not installed.
    const bin = await findRscript()
    if (!bin) {
      const msg =
        "Rscript not found. Install R from https://www.r-project.org (or `brew install r`) so `Rscript` is on PATH."
      ctx.metadata({ metadata: { output: msg, ok: false } })
      return { title: "R kernel unavailable", output: msg, metadata: { ok: false, available: false, output: msg } }
    }

    const kernel = await rKernels.get(ctx.sessionID)
    const result = await kernel.execute(params.code, { timeout: params.timeout, signal: ctx.abort })

    const images = result.outputs.filter((o) => o.type === "display" && o.data?.["image/png"])
    const dataUrls = images.map((o) => `data:image/png;base64,${o.data!["image/png"]}`)

    const parts: string[] = []
    if (result.stdout) parts.push(result.stdout)
    if (result.stderr) parts.push(`${result.ok ? "[messages]" : "[ERROR]"}\n${result.stderr}`)
    if (images.length) parts.push(`[figure] captured ${images.length} inline image(s)`)
    if (!parts.length) parts.push("(no output)")
    const output = clip(parts.join("\n"))

    ctx.metadata({ metadata: { output, ok: result.ok } })

    return {
      title: result.ok ? "R cell" : "R cell (error)",
      output,
      metadata: {
        ok: result.ok,
        available: true,
        output,
        hasImages: images.length,
        ...(images.length ? { artifact: { kind: "image", data: { images: dataUrls } } } : {}),
      },
    }
  },
})

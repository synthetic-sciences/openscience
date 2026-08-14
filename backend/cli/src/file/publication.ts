import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { spawn, type ChildProcess } from "node:child_process"
import { marked, Renderer } from "marked"
import z from "zod"
import { Config } from "../config/config"
import { OpenScience } from "../openscience"
import { AuthoritySignal } from "../project/authority-signal"
import { Instance } from "../project/instance"
import { ProjectTrust } from "../project/trust"
import { Sandbox } from "../sandbox/sandbox"
import { CommandRuntime } from "../science/command/registry"
import { Shell } from "../shell/shell"
import { Filesystem } from "../util/filesystem"
import { escapeHtml } from "../util/html"
import { PublicationReview } from "./review"
import { SafeFileIO } from "./safe-io"

export namespace PublicationFile {
  export const Format = z.enum(["html", "pdf", "docx", "latex", "pptx"])
  export type Format = z.infer<typeof Format>

  export const Input = z
    .object({
      path: z.string().trim().min(1).max(4_000),
      format: Format,
      readiness: z.enum(["draft", "reviewed"]).default("draft"),
      review_id: z.string().startsWith("review_").optional(),
    })
    .superRefine((input, context) => {
      if (input.readiness !== "reviewed" || input.review_id) return
      context.addIssue({
        code: "custom",
        path: ["review_id"],
        message: "Exporting preflight-checked bytes requires a finalized publication preflight report",
      })
    })
  export type Input = z.input<typeof Input>

  export const Capabilities = z.object({
    pandoc: z.boolean(),
    pdf_engine: z.string().optional(),
    formats: z.record(Format, z.boolean()),
  })
  export type Capabilities = z.infer<typeof Capabilities>

  export const Result = z.object({
    path: z.string(),
    format: Format,
    size: z.number().int().nonnegative(),
    created_at: z.string(),
    engine: z.string(),
    readiness: z.enum(["draft", "reviewed"]),
    review_id: z.string().optional(),
  })
  export type Result = z.infer<typeof Result>

  const extensions: Record<Format, string> = {
    html: "html",
    pdf: "pdf",
    docx: "docx",
    latex: "tex",
    pptx: "pptx",
  }

  const exportTimeoutMs = 120_000
  const diagnosticLimit = 64 * 1024

  export async function capabilities(): Promise<Capabilities> {
    const options = { PATH: process.env.PATH }
    const pandoc = Boolean(Bun.which("pandoc", options))
    const pdf =
      Bun.which("xelatex", options) ?? Bun.which("pdflatex", options) ?? Bun.which("typst", options) ?? undefined
    return Capabilities.parse({
      pandoc,
      pdf_engine: pdf ? path.basename(pdf) : undefined,
      formats: {
        html: true,
        pdf: pandoc && Boolean(pdf),
        docx: pandoc,
        latex: pandoc,
        pptx: pandoc,
      },
    })
  }

  export async function render(root: string, input: Input): Promise<Result> {
    const parsed = Input.parse(input)
    const source = resolve(root, parsed.path)
    if (![".md", ".markdown"].includes(path.extname(source).toLowerCase())) {
      throw new Error("Publication export currently requires a Markdown report")
    }
    if (!(await Filesystem.containsCanonical(root, source))) {
      throw new Error("Publication path escapes the project directory")
    }
    if (!(await Bun.file(source).exists())) throw new Error(`Report not found: ${parsed.path}`)
    const snapshot = await Bun.file(source).arrayBuffer()
    const markdown = new TextDecoder().decode(snapshot)
    const artifactHash = await hash(snapshot)
    const review =
      parsed.readiness === "reviewed"
        ? await PublicationReview.assertReady(parsed.path, parsed.review_id!, artifactHash)
        : undefined
    const support = await capabilities()
    if (!support.formats[parsed.format]) {
      throw new Error(
        parsed.format === "pdf"
          ? "PDF export requires Pandoc and a local TeX or Typst engine"
          : `${parsed.format.toUpperCase()} export requires Pandoc`,
      )
    }
    // Tool-backed publication runs project-controlled Markdown, TeX and local
    // resource bytes through host executables. Do not create even the export
    // directory until the user has explicitly trusted that project.
    if (parsed.format !== "html") {
      const canonicalRoot = await Filesystem.canonical(root)
      if (canonicalRoot !== Instance.directory) {
        throw new Error("Publication export project does not match the active project")
      }
      await ProjectTrust.require(Instance.project, "publication_export")
    }

    const folder = path.join(root, "exports")
    const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 17)
    const nonce = crypto.randomUUID().slice(0, 8)
    const stem =
      path
        .basename(source, path.extname(source))
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "report"
    const relative = path.join(
      "exports",
      `${stem}-${stamp.slice(0, 8)}-${stamp.slice(8)}-${nonce}.${extensions[parsed.format]}`,
    )
    const target = path.join(root, relative)
    if (parsed.format === "html") {
      const renderer = new Renderer()
      renderer.html = ({ text }) => escapeHtml(text)
      renderer.link = ({ href, title, tokens }) => {
        const content = renderer.parser.parseInline(tokens)
        const target = safe(href, false)
        if (!target) return content
        const hint = title ? ` title="${escapeHtml(title)}"` : ""
        return `<a href="${escapeHtml(target)}"${hint}>${content}</a>`
      }
      renderer.image = ({ href, title, text }) => {
        const target = safe(href, true)
        if (!target) return escapeHtml(text)
        const hint = title ? ` title="${escapeHtml(title)}"` : ""
        return `<img src="${escapeHtml(target)}" alt="${escapeHtml(text)}"${hint}>`
      }
      const body = await marked.parse(markdown, { gfm: true, renderer })
      const base = `${path.relative(folder, path.dirname(source)).split(path.sep).join("/") || "."}/`
      const title = path.basename(source, path.extname(source))
      const document = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data: https: http:; style-src 'unsafe-inline'; font-src 'self' data:">
  <base href="${escapeHtml(base)}">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; line-height: 1.65; }
    body { max-width: 860px; margin: 0 auto; padding: 48px 28px 80px; color: #20211f; background: #fbfbf8; }
    h1, h2, h3 { line-height: 1.2; letter-spacing: -0.02em; }
    h1 { font-size: 2.25rem; margin-bottom: 1.5rem; }
    h2 { margin-top: 2.5rem; border-bottom: 1px solid #d8d8d0; padding-bottom: .35rem; }
    a { color: #315f8c; }
    img { display: block; max-width: 100%; height: auto; margin: 1.5rem auto; }
    table { width: 100%; border-collapse: collapse; margin: 1.5rem 0; }
    th, td { border: 1px solid #d8d8d0; padding: .55rem .7rem; text-align: left; }
    pre, code { font-family: ui-monospace, SFMono-Regular, monospace; background: #efefe9; border-radius: 4px; }
    pre { overflow: auto; padding: 1rem; }
    code { padding: .12rem .28rem; }
    pre code { padding: 0; }
    blockquote { margin-left: 0; padding-left: 1rem; border-left: 3px solid #a8aaa2; color: #555750; }
    @media print { body { max-width: none; padding: 0; background: #fff; } a { color: inherit; } }
    @media (prefers-color-scheme: dark) {
      body { color: #e6e6df; background: #191a18; }
      h2, th, td { border-color: #41433e; }
      pre, code { background: #292b27; }
      a { color: #8bb8e3; }
    }
  </style>
</head>
<body>
${body}
</body>
      </html>
`
      await SafeFileIO.write(target, document)
      return Result.parse({
        path: relative.split(path.sep).join("/"),
        format: parsed.format,
        size: Buffer.byteLength(document),
        created_at: new Date().toISOString(),
        engine: "OpenScience Markdown",
        readiness: parsed.readiness,
        ...(review ? { review_id: review.id } : {}),
      })
    }
    // Keep both the immutable input snapshot and untrusted converter output in
    // a private, one-run directory. The sandbox sees the project read-only and
    // can write only here; host-side SafeFileIO performs the final no-follow,
    // no-overwrite install into exports after the child exits successfully.
    const job = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-publication-"))
    const snapshotFile = path.join(job, "source.md")
    const generatedFile = path.join(job, `result.${extensions[parsed.format]}`)
    let lifecycle:
      | {
          child: ChildProcess
          sandbox: ReturnType<typeof Sandbox.wrapArgv>
          closed: boolean
        }
      | undefined
    let releaseRequested = false
    let releasePromise: Promise<void> | undefined
    const release = () =>
      (releasePromise ??= Promise.resolve().then(async () => {
        if (lifecycle) Sandbox.cleanup(lifecycle.sandbox)
        await fs.rm(job, { recursive: true, force: true })
      }))
    const requestRelease = async () => {
      releaseRequested = true
      if (!lifecycle || lifecycle.closed || stopped(lifecycle.child)) await release()
    }

    try {
      await fs.chmod(job, 0o700)
      await fs.writeFile(snapshotFile, Buffer.from(snapshot), { flag: "wx", mode: 0o600 })
      const launched = await AuthoritySignal.exclusive(async () => {
        // This final check shares the same interprocess lease as trust
        // revocation. Once spawn wins, the child is durably registered before
        // revocation can be acknowledged; if revocation wins, no child starts.
        await ProjectTrust.require(Instance.project, "publication_export")
        const toolPath = process.env.PATH
        const pandoc = Bun.which("pandoc", { PATH: toolPath })
        const pdfEngine =
          parsed.format === "pdf"
            ? (Bun.which("xelatex", { PATH: toolPath }) ??
              Bun.which("pdflatex", { PATH: toolPath }) ??
              Bun.which("typst", { PATH: toolPath }))
            : undefined
        if (!pandoc) throw new Error(`${parsed.format.toUpperCase()} export requires Pandoc`)
        if (parsed.format === "pdf" && !pdfEngine) {
          throw new Error("PDF export requires Pandoc and a local TeX or Typst engine")
        }

        const args = [
          snapshotFile,
          "--standalone",
          `--resource-path=${path.dirname(source)}${path.delimiter}${root}`,
          "--output",
          generatedFile,
          ...(pdfEngine ? [`--pdf-engine=${pdfEngine}`] : []),
        ]
        const options = await Config.trustedSandbox()
        const sandbox = Sandbox.wrapArgv({
          file: pandoc,
          args,
          // Publication converters only need to read the manuscript and its
          // resources. They never receive write authority to the project.
          workspace: [],
          readable: [root],
          extraWritable: [job],
          unreadable: OpenScience.kernelSensitivePaths(),
          options,
        })
        const wrapped = await CommandRuntime.wrap({
          file: sandbox.file,
          args: sandbox.args,
        })
        const detached = process.platform !== "win32"
        let child: ChildProcess
        try {
          child = spawn(wrapped.file, wrapped.args, {
            cwd: root,
            env: {
              ...OpenScience.kernelEnv(process.env),
              HOME: job,
              XDG_CACHE_HOME: path.join(job, "cache"),
              XDG_CONFIG_HOME: path.join(job, "config"),
              XDG_DATA_HOME: path.join(job, "data"),
            },
            stdio: ["ignore", "pipe", "pipe"],
            detached,
          })
        } catch (error) {
          Sandbox.cleanup(sandbox)
          throw error
        }

        const output = completion(child)
        const stop = () => Shell.killTree(child, { exited: () => stopped(child), detached })
        const registered = await CommandRuntime.start(
          {
            projectID: Instance.project.id,
            sessionID: "publication",
            messageID: "publication",
            description: `Export ${path.basename(source)} as ${parsed.format.toUpperCase()}`,
            command: `pandoc ${parsed.format} export`,
          },
          child,
          stop,
          { windowsRelease: wrapped.release },
        ).catch(async (error) => {
          void output.catch(() => undefined)
          if (!stopped(child)) await stop()
          Sandbox.cleanup(sandbox)
          throw error
        })
        const safeStop = async () => {
          await CommandRuntime.stop(registered.id, registered.projectID, registered.sessionID)
        }
        return { child, output, registered, sandbox, stop: safeStop, pdfEngine }
      })
      lifecycle = {
        child: launched.child,
        sandbox: launched.sandbox,
        closed: stopped(launched.child),
      }
      const closed = () => {
        if (!lifecycle) return
        lifecycle.closed = true
        if (releaseRequested) void release()
      }
      launched.child.once("close", closed)
      launched.child.once("error", closed)
      if (stopped(launched.child)) lifecycle.closed = true

      const timeout = timeoutAfter(launched.child, launched.stop)
      let result: Awaited<ReturnType<typeof completion>>
      try {
        result = await Promise.race([launched.output, timeout.promise])
      } finally {
        timeout.cancel()
      }
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || result.stdout.trim() || `Pandoc exited with code ${result.code}`)
      }

      // Serialize the final artifact acceptance with trust mutation as well.
      // A converter result cannot be acknowledged after the project has been
      // revoked while it was running.
      const size = await AuthoritySignal.exclusive(async () => {
        await ProjectTrust.require(Instance.project, "publication_export")
        const generated = await SafeFileIO.read(generatedFile)
        await SafeFileIO.write(target, generated.bytes)
        return generated.bytes.length
      })
      return Result.parse({
        path: relative.split(path.sep).join("/"),
        format: parsed.format,
        size,
        created_at: new Date().toISOString(),
        engine: parsed.format === "pdf" ? `pandoc + ${path.basename(launched.pdfEngine!)}` : "pandoc",
        readiness: parsed.readiness,
        ...(review ? { review_id: review.id } : {}),
      })
    } finally {
      // A child that somehow survives forced termination stays registered and
      // retains its sandbox/job directory for later durable reaping. Releasing
      // those paths while it is still alive would turn a timeout into an
      // authority escape. Normal exits clean synchronously here.
      await requestRelease()
    }
  }

  function stopped(child: ChildProcess) {
    return child.exitCode !== null || child.signalCode !== null
  }

  function completion(child: ChildProcess) {
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < diagnosticLimit) stdout += String(chunk).slice(0, diagnosticLimit - stdout.length)
    })
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < diagnosticLimit) stderr += String(chunk).slice(0, diagnosticLimit - stderr.length)
    })
    return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      child.once("error", reject)
      child.once("close", (code) => resolve({ code: code ?? 1, stdout, stderr }))
    })
  }

  function timeoutAfter(child: ChildProcess, stop: () => Promise<void>) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const promise = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        void stop()
          .then(() => waitForStop(child))
          .then(
            () => reject(new Error(`Pandoc timed out after ${Math.round(exportTimeoutMs / 1_000)} seconds`)),
            (error) => reject(new AggregateError([error], "Pandoc timed out and could not be stopped")),
          )
      }, exportTimeoutMs)
      timer.unref()
    })
    return {
      promise,
      cancel() {
        if (timer) clearTimeout(timer)
      },
    }
  }

  async function waitForStop(child: ChildProcess) {
    if (stopped(child)) return
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer)
        child.off("close", finish)
        child.off("error", fail)
        resolve()
      }
      const fail = (error: Error) => {
        clearTimeout(timer)
        child.off("close", finish)
        child.off("error", fail)
        reject(error)
      }
      const timer = setTimeout(() => {
        child.off("close", finish)
        child.off("error", fail)
        reject(new Error("Pandoc remained alive after forced termination"))
      }, 2_000)
      timer.unref()
      child.once("close", finish)
      child.once("error", fail)
      if (stopped(child)) finish()
    })
  }

  function resolve(root: string, file: string): string {
    const target = path.resolve(root, file)
    const relative = path.relative(root, target)
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("Publication path escapes the project directory")
    }
    return target
  }

  function safe(value: string, image: boolean): string | undefined {
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase()
    if (!scheme) return value
    if (scheme === "http" || scheme === "https") return value
    if (!image && scheme === "mailto") return value
    if (image && scheme === "data" && /^data:image\//i.test(value)) return value
    return undefined
  }

  async function hash(value: ArrayBuffer) {
    const digest = await crypto.subtle.digest("SHA-256", value)
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
  }
}

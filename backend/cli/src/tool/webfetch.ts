import z from "zod"
import { Tool } from "./tool"
import TurndownService from "turndown"
import DESCRIPTION from "./webfetch.txt"
import { Network } from "@/settings/network"
import { SessionFilesystem } from "@/session/filesystem"
import { Filesystem } from "@/util/filesystem"
import { SafeFileIO } from "@/file/safe-io"
import crypto from "node:crypto"
import { constants as FS } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { ToolRetryGuard } from "@/session/tool-retry-guard"

export const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5 MiB
const DEFAULT_TIMEOUT = 30 * 1000 // 30 seconds
const MAX_TIMEOUT = 120 * 1000 // 2 minutes
const DEFAULT_DOWNLOAD_TIMEOUT = 10 * 60 * 1000 // 10 minutes
const MAX_DOWNLOAD_TIMEOUT = 30 * 60 * 1000 // 30 minutes
export const DEFAULT_DOWNLOAD_MAX_BYTES = 256 * 1024 * 1024 // 256 MiB
export const MAX_DOWNLOAD_MAX_BYTES = 2 * 1024 * 1024 * 1024 // 2 GiB
const DOWNLOAD_DISK_RESERVE_BYTES = 512 * 1024 * 1024 // preserve 512 MiB for the host

const parameters = z
  .object({
    url: z.string().describe("The URL to fetch content from"),
    format: z
      .enum(["text", "markdown", "html"])
      .default("markdown")
      .describe("The format to return the content in (text, markdown, or html). Defaults to markdown."),
    timeout: z
      .number()
      .positive()
      .describe("Optional timeout in seconds (max 120 for text, 1800 when output_path is set)")
      .optional(),
    output_path: z
      .string()
      .optional()
      .describe(
        "Optional new filename at the root of this session's workspace. Streams the response to that file instead of returning its body. " +
          "Use this for archives, compressed datasets, binary files, or text responses larger than 5 MiB.",
      ),
    max_bytes: z
      .number()
      .int()
      .positive()
      .max(MAX_DOWNLOAD_MAX_BYTES)
      .optional()
      .describe(
        `Maximum allowed download size in bytes when output_path is set (default ${DEFAULT_DOWNLOAD_MAX_BYTES}; ` +
          `hard maximum ${MAX_DOWNLOAD_MAX_BYTES}). Rejected before transfer when Content-Length exceeds it and during ` +
          "streaming when the server omits Content-Length.",
      ),
    declared_size_bytes: z
      .number()
      .int()
      .positive()
      .max(MAX_DOWNLOAD_MAX_BYTES)
      .optional()
      .describe(
        "Exact download size in bytes from evidence, used only after a prior max_bytes failure or for a one-shot known-size download. " +
          "It must match the server Content-Length cached by WebFetch or a labelled size in declared_size_evidence_call_id.",
      ),
    declared_size_evidence_call_id: z
      .string()
      .trim()
      .min(1)
      .max(256)
      .optional()
      .describe(
        "Prior completed WebFetch call ID whose metadata response labels the exact declared_size_bytes. Not needed when the prior failure recorded server Content-Length.",
      ),
  })
  .superRefine((params, issue) => {
    if (params.declared_size_bytes !== undefined && !params.output_path) {
      issue.addIssue({
        code: "custom",
        path: ["declared_size_bytes"],
        message: "declared_size_bytes is only valid when output_path is set",
      })
    }
    if (params.declared_size_evidence_call_id !== undefined && params.declared_size_bytes === undefined) {
      issue.addIssue({
        code: "custom",
        path: ["declared_size_evidence_call_id"],
        message: "declared_size_evidence_call_id requires declared_size_bytes",
      })
    }
  })

export const WebFetchTool = Tool.define("webfetch", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    // Validate URL
    if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
      throw new Error("URL must start with http:// or https://")
    }
    if (params.max_bytes !== undefined && !params.output_path) {
      throw new Error("max_bytes is only valid when output_path is set")
    }
    await ToolRetryGuard.assertWebFetch(ctx, params)
    const complete = <T extends { output: string; metadata: Record<string, unknown> }>(result: T) => {
      ToolRetryGuard.recordWebFetchSuccess(ctx, params, result)
      return result
    }
    // A domain outside the enforced allow-list asks instead of failing.
    // Answering "always" adds the domain to the persisted allow-list (visible
    // in Network settings); conversation/project scopes approve quietly on
    // later requests without widening the stored list.
    const approvedHosts = new Set<string>()
    const authorize = async (input: { host: string; url: string }) => {
      if (approvedHosts.has(input.host)) return
      await ctx.ask({
        permission: "network",
        patterns: [input.host],
        always: [input.host],
        metadata: {
          url: input.url,
          network: { host: input.host },
        },
      })
      approvedHosts.add(input.host)
    }
    const host = await Network.blocked(params.url)
    if (host) {
      await authorize({ host, url: params.url })
    }

    // Scope an "always" style grant to this site, never the whole tool.
    const site = (() => {
      try {
        return new URL(params.url).origin + "/*"
      } catch {
        return params.url
      }
    })()
    await ctx.ask({
      permission: "webfetch",
      patterns: [params.url],
      always: [site],
      metadata: {
        url: params.url,
        format: params.format,
        timeout: params.timeout,
        output_path: params.output_path,
        max_bytes: params.max_bytes,
        declared_size_bytes: params.declared_size_bytes,
        declared_size_evidence_call_id: params.declared_size_evidence_call_id,
      },
    })

    const download = params.output_path ? await resolveDownloadTarget(ctx.sessionID, params.output_path) : undefined
    const defaultTimeout = download ? DEFAULT_DOWNLOAD_TIMEOUT : DEFAULT_TIMEOUT
    const maxTimeout = download ? MAX_DOWNLOAD_TIMEOUT : MAX_TIMEOUT
    const timeout = Math.min((params.timeout ?? defaultTimeout / 1000) * 1000, maxTimeout)
    const maxDownloadBytes = params.max_bytes ?? DEFAULT_DOWNLOAD_MAX_BYTES

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeout)

    // Build Accept header based on requested format with q parameters for fallbacks
    let acceptHeader = "*/*"
    switch (params.format) {
      case "markdown":
        acceptHeader = "text/markdown;q=1.0, text/x-markdown;q=0.9, text/plain;q=0.8, text/html;q=0.7, */*;q=0.1"
        break
      case "text":
        acceptHeader = "text/plain;q=1.0, text/markdown;q=0.9, text/html;q=0.8, */*;q=0.1"
        break
      case "html":
        acceptHeader = "text/html;q=1.0, application/xhtml+xml;q=0.9, text/plain;q=0.8, text/markdown;q=0.7, */*;q=0.1"
        break
      default:
        acceptHeader =
          "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8"
    }

    const signal = AbortSignal.any([controller.signal, ctx.abort])
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36",
      Accept: acceptHeader,
      "Accept-Language": "en-US,en;q=0.9",
    }

    try {
      const initial = await Network.fetch(
        params.url,
        { signal, headers },
        download
          ? { authorize, streamResponse: true, maxResponseBytes: maxDownloadBytes }
          : { authorize, maxResponseBytes: MAX_RESPONSE_SIZE },
      )

      // Retry with honest UA if blocked by Cloudflare bot detection (TLS fingerprint mismatch)
      let response = initial
      if (initial.status === 403 && initial.headers.get("cf-mitigated") === "challenge") {
        await initial.body?.cancel().catch(() => {})
        response = await Network.fetch(
          params.url,
          { signal, headers: { ...headers, "User-Agent": "openscience" } },
          download
            ? { authorize, streamResponse: true, maxResponseBytes: maxDownloadBytes }
            : { authorize, maxResponseBytes: MAX_RESPONSE_SIZE },
        )
      }

      if (!response.ok) {
        await response.body?.cancel().catch(() => {})
        if (response.status === 404) {
          throw new Error(
            "Request failed with status code: 404. This endpoint or identifier does not exist. " +
              "Do not retry the same URL; verify it with the service's listing or metadata endpoint.",
          )
        }
        if (response.status === 405) {
          throw new Error(
            "Request failed with status code: 405. Web fetch sends GET, but this endpoint does not accept GET. " +
              "Do not retry the same URL with Web fetch; verify the documented HTTP method and use a targeted built-in connector " +
              "or a documented GET endpoint. Shell network access may be unavailable in the sandbox.",
          )
        }
        throw new Error(`Request failed with status code: ${response.status}`)
      }

      const responseDeclaredBytes = parseContentLength(response.headers.get("content-length"))
      const responseMetadata =
        responseDeclaredBytes === undefined
          ? {}
          : {
              response: {
                url: Network.finalURL(response) || params.url,
                contentLength: responseDeclaredBytes,
              },
            }
      if (
        download &&
        params.declared_size_bytes !== undefined &&
        responseDeclaredBytes !== undefined &&
        responseDeclaredBytes !== params.declared_size_bytes
      ) {
        await response.body?.cancel().catch(() => {})
        throw new Error(
          `Server Content-Length (${responseDeclaredBytes} bytes) does not match declared_size_bytes ` +
            `(${params.declared_size_bytes} bytes). No destination file was created; refresh the size evidence before retrying.`,
        )
      }

      if (download) {
        const result = await streamDownload(response, download, maxDownloadBytes)
        return complete({
          title: `Downloaded ${result.filename}`,
          output: [
            "Downloaded through the authorized network broker into this session's workspace.",
            `Path: ${result.path}`,
            `Filename: ${result.filename}`,
            ...(result.sourceFilename && result.sourceFilename !== result.filename
              ? [`Source filename: ${result.sourceFilename}`]
              : []),
            `Bytes: ${result.bytes}`,
            `SHA-256: ${result.sha256}`,
            `Content type: ${result.contentType || "unknown"}`,
          ].join("\n"),
          metadata: {
            download: { url: Network.finalURL(response) || params.url, ...result },
          } as Record<string, unknown>,
        })
      }

      const contentType = response.headers.get("content-type") || ""
      const mime = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? ""
      if (!isTextualMime(mime)) {
        await response.body?.cancel().catch(() => {})
        throw unsupportedFileError({
          contentType,
          contentDisposition: response.headers.get("content-disposition") ?? undefined,
          declaredBytes: parseContentLength(response.headers.get("content-length")),
        })
      }

      const contentLength = response.headers.get("content-length")
      const declaredBytes = parseContentLength(contentLength)
      if (declaredBytes !== undefined && declaredBytes > MAX_RESPONSE_SIZE) {
        await response.body?.cancel().catch(() => {})
        throw responseTooLargeError({
          limitBytes: MAX_RESPONSE_SIZE,
          declaredBytes,
          contentType,
          contentDisposition: response.headers.get("content-disposition") ?? undefined,
        })
      }

      const body = await collectBoundedBody(response, MAX_RESPONSE_SIZE)
      const content = new TextDecoder().decode(body)

      const title = `${params.url} (${contentType})`

      // Handle content based on requested format and actual content type
      switch (params.format) {
        case "markdown":
          if (contentType.includes("text/html")) {
            const markdown = convertHTMLToMarkdown(content)
            return complete({
              output: markdown,
              title,
              metadata: responseMetadata,
            })
          }
          return complete({
            output: content,
            title,
            metadata: responseMetadata,
          })

        case "text":
          if (contentType.includes("text/html")) {
            const text = await extractTextFromHTML(content)
            return complete({
              output: text,
              title,
              metadata: responseMetadata,
            })
          }
          return complete({
            output: content,
            title,
            metadata: responseMetadata,
          })

        case "html":
          return complete({
            output: content,
            title,
            metadata: responseMetadata,
          })

        default:
          return complete({
            output: content,
            title,
            metadata: responseMetadata,
          })
      }
    } catch (error) {
      if (error instanceof Network.ResponseTooLargeError) {
        if (download) {
          const failure = new Error(
            `Download exceeds max_bytes (${formatBytes(error.declaredBytes ?? error.receivedBytes)} > ` +
              `${formatBytes(error.limitBytes)}). No destination file was created. Choose a smaller source or explicitly ` +
              "set max_bytes once from the declared size within the supported limit; do not retry with incremental caps.",
          )
          throw ToolRetryGuard.annotateWebFetch(ctx, params, failure, {
            attemptedMaxBytes: error.limitBytes,
            declaredSizeBytes: error.declaredBytes,
          })
        }
        throw ToolRetryGuard.annotateWebFetch(ctx, params, responseTooLargeError(error))
      }
      if (controller.signal.aborted && !ctx.abort.aborted) {
        throw new Error(
          `Request timed out after ${timeout / 1000} seconds. Do not retry indefinitely; ` +
            "use a smaller paginated request, or set output_path for a brokered workspace download with a longer timeout.",
        )
      }
      throw ToolRetryGuard.annotateWebFetch(ctx, params, error)
    } finally {
      clearTimeout(timeoutId)
    }
  },
})

function parseContentLength(value: string | null) {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

function isTextualMime(mime: string) {
  return (
    !mime ||
    mime.startsWith("text/") ||
    mime === "application/json" ||
    mime.endsWith("+json") ||
    mime === "application/xml" ||
    mime.endsWith("+xml") ||
    mime === "application/xhtml+xml" ||
    mime === "application/javascript" ||
    mime === "application/x-javascript"
  )
}

function formatBytes(bytes: number | undefined) {
  if (bytes === undefined) return undefined
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${bytes} bytes`
}

function downloadGuidance() {
  return (
    "Do not repeat the same text-mode request. For a data file, call Web fetch again with output_path set to a simple " +
    "workspace-root filename without directories; it will stream through the authorized network broker without entering model context. " +
    "For a large JSON API response, request a smaller page and follow its pagination metadata."
  )
}

function responseTooLargeError(input: {
  limitBytes: number
  declaredBytes?: number
  receivedBytes?: number
  contentType?: string
  contentDisposition?: string
}) {
  const observed = input.declaredBytes ?? input.receivedBytes
  const details = [formatBytes(observed), input.contentType || undefined, input.contentDisposition || undefined].filter(
    Boolean,
  )
  return new Error(
    `Response is too large for Web fetch${details.length ? ` (${details.join(", ")})` : ""}; ` +
      `the text-response limit is ${formatBytes(input.limitBytes)}. ${downloadGuidance()}`,
  )
}

function unsupportedFileError(input: { contentType: string; contentDisposition?: string; declaredBytes?: number }) {
  const details = [input.contentType, formatBytes(input.declaredBytes), input.contentDisposition].filter(Boolean)
  return new Error(
    `Web fetch is text-only; the response is a file${details.length ? ` (${details.join(", ")})` : ""}. ` +
      downloadGuidance(),
  )
}

async function collectBoundedBody(response: Response, limitBytes: number) {
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      received += next.value.byteLength
      if (received > limitBytes) {
        await reader.cancel().catch(() => {})
        throw responseTooLargeError({
          limitBytes,
          receivedBytes: received,
          contentType: response.headers.get("content-type") ?? undefined,
          contentDisposition: response.headers.get("content-disposition") ?? undefined,
        })
      }
      chunks.push(next.value)
    }
  } finally {
    reader.releaseLock()
  }
  const output = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    output.set(chunk, offset)
    offset += chunk.byteLength
  }
  return output
}

type DownloadTarget = {
  root: string
  path: string
  relative: string
}

async function resolveDownloadTarget(sessionID: string, requested: string): Promise<DownloadTarget> {
  if (!requested || requested !== requested.trim() || requested.includes("\0")) {
    throw new Error("output_path must be a non-empty workspace-root filename without surrounding whitespace")
  }
  if (path.isAbsolute(requested)) {
    throw new Error("output_path must be a workspace-root filename, not an absolute path")
  }
  if (requested !== path.basename(requested)) {
    throw new Error("output_path must be a filename at the root of this session's workspace, without directories")
  }

  const workspace = await SessionFilesystem.workspace(sessionID)
  const root = await Filesystem.canonical(workspace)
  if (!root) throw new Error("The session workspace is unavailable")
  const candidate = path.resolve(root, requested)
  const target = await Filesystem.canonical(candidate)
  if (!target || target === root || !Filesystem.contains(root, target)) {
    throw new Error("output_path must stay inside this session's workspace and name a file")
  }
  const relative = path.relative(root, target)
  if (!relative || path.isAbsolute(relative) || relative.startsWith("..")) {
    throw new Error("output_path must stay inside this session's workspace and name a file")
  }
  // Direct tool unit tests use synthetic session ids. Every production tool
  // call carries a real ses_* id and must also satisfy the durable write grant.
  if (sessionID.startsWith("ses_")) {
    const authorized = await SessionFilesystem.authorize({ sessionID, path: target, access: "write" })
    if (authorized.path !== target) throw new Error("Download destination changed during authorization")
  }
  await SafeFileIO.absent(target)
  return { root, path: target, relative }
}

async function assertDownloadTarget(target: DownloadTarget) {
  const [root, filepath] = await Promise.all([Filesystem.canonical(target.root), Filesystem.canonical(target.path)])
  if (root !== target.root || filepath !== target.path || !Filesystem.contains(root, filepath) || filepath === root) {
    throw new Error("Download destination became ambiguous or escaped the session workspace")
  }
}

function sourceFilename(response: Response) {
  const disposition = response.headers.get("content-disposition") ?? ""
  const encoded = /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(disposition)?.[1]
  if (encoded) {
    try {
      return path.basename(decodeURIComponent(encoded.trim().replace(/^"|"$/g, "")))
    } catch {}
  }
  const ordinary = /filename\s*=\s*(?:"([^"]+)"|([^;]+))/i.exec(disposition)
  const value = ordinary?.[1] ?? ordinary?.[2]?.trim()
  return value ? path.basename(value) : undefined
}

async function writeChunk(handle: fs.FileHandle, chunk: Uint8Array) {
  let offset = 0
  while (offset < chunk.byteLength) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset)
    if (!bytesWritten) throw new Error("Download stalled while writing to the session workspace")
    offset += bytesWritten
  }
}

function beginsWith(bytes: Uint8Array, signature: number[]) {
  return signature.every((value, index) => bytes[index] === value)
}

function looksLikeHTML(bytes: Uint8Array) {
  const prefix = new TextDecoder().decode(bytes.subarray(0, 512)).trimStart().toLowerCase()
  return (
    prefix.startsWith("<!doctype html") ||
    prefix.startsWith("<html") ||
    prefix.startsWith("<head") ||
    prefix.startsWith("<body") ||
    /^<\?xml[^>]*>\s*<(?:html|xhtml)(?:\s|>)/.test(prefix)
  )
}

function validateDownloadedFormat(target: DownloadTarget, response: Response, prefix: Uint8Array) {
  const extension = path.extname(target.path).toLowerCase()
  const contentType = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim().toLowerCase()
  const html = looksLikeHTML(prefix) || contentType === "text/html" || contentType === "application/xhtml+xml"
  const htmlTarget = [".html", ".htm", ".xhtml"].includes(extension)
  if (html && !htmlTarget) {
    throw new Error(
      `Downloaded response is HTML, not the requested ${extension || "data"} file. ` +
        "This is usually a login, consent, access-denied, or publisher interstitial. No destination file was created; " +
        "resolve the canonical download URL or required access instead of parsing the file.",
    )
  }
  if (!prefix.byteLength) return
  const valid = (() => {
    if (extension === ".pdf") return beginsWith(prefix, [0x25, 0x50, 0x44, 0x46, 0x2d])
    if (extension === ".xlsx" || extension === ".zip") {
      return (
        beginsWith(prefix, [0x50, 0x4b, 0x03, 0x04]) ||
        beginsWith(prefix, [0x50, 0x4b, 0x05, 0x06]) ||
        beginsWith(prefix, [0x50, 0x4b, 0x07, 0x08])
      )
    }
    if (extension === ".gz" || extension === ".tgz") return beginsWith(prefix, [0x1f, 0x8b])
    if (extension === ".xls") return beginsWith(prefix, [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
    return true
  })()
  if (!valid) {
    throw new Error(
      `Downloaded bytes do not match the requested ${extension} file signature. No destination file was created; ` +
        "verify the canonical data URL and access requirements before retrying.",
    )
  }
}

async function assertDownloadCapacity(response: Response, target: DownloadTarget, maxBytes: number) {
  const disk = await fs.statfs(target.root)
  const available = disk.bavail * disk.bsize
  const declared = parseContentLength(response.headers.get("content-length"))
  const required = declared ?? maxBytes
  const usable = Math.max(0, available - DOWNLOAD_DISK_RESERVE_BYTES)
  if (required <= usable) return
  throw new Error(
    `Insufficient workspace disk for download: ${formatBytes(required)} may be written, but only ` +
      `${formatBytes(usable)} is available after the ${formatBytes(DOWNLOAD_DISK_RESERVE_BYTES)} safety reserve. ` +
      "Choose a smaller source, lower max_bytes, or free disk space.",
  )
}

async function streamDownload(response: Response, target: DownloadTarget, maxBytes: number) {
  await assertDownloadTarget(target)
  await SafeFileIO.absent(target.path)
  try {
    await assertDownloadCapacity(response, target, maxBytes)
  } catch (error) {
    await response.body?.cancel().catch(() => {})
    throw error
  }

  // Stage outside the writable session root. Combined with the direct-child
  // output_path contract, a concurrent runtime cannot swap an intermediate
  // directory to redirect either the temporary write or final hard-link.
  const staged = path.join(path.dirname(target.root), `.openscience-download-${crypto.randomUUID()}.tmp`)
  const handle = await fs.open(staged, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o644)
  const hash = crypto.createHash("sha256")
  let bytes = 0
  const prefix = new Uint8Array(512)
  let prefixBytes = 0
  try {
    if (response.body) {
      const reader = response.body.getReader()
      try {
        while (true) {
          const next = await reader.read()
          if (next.done) break
          if (bytes + next.value.byteLength > maxBytes) {
            await reader.cancel().catch(() => {})
            throw new Error(
              `Download exceeds max_bytes (${formatBytes(maxBytes)}). Partial data was discarded; ` +
                "use a metadata/listing endpoint to obtain the exact byte size for one evidence-backed retry, " +
                "choose a smaller or paginated source, or use a different canonical download URL. " +
                "Do not retry this URL with incrementally larger caps.",
            )
          }
          await writeChunk(handle, next.value)
          if (prefixBytes < prefix.byteLength) {
            const length = Math.min(next.value.byteLength, prefix.byteLength - prefixBytes)
            prefix.set(next.value.subarray(0, length), prefixBytes)
            prefixBytes += length
          }
          hash.update(next.value)
          bytes += next.value.byteLength
        }
      } catch (error) {
        await reader.cancel().catch(() => {})
        throw error
      } finally {
        reader.releaseLock()
      }
    }
    const declared = parseContentLength(response.headers.get("content-length"))
    if (declared !== undefined && declared !== bytes) {
      throw new Error(`Incomplete download: received ${bytes} of ${declared} declared bytes`)
    }
    validateDownloadedFormat(target, response, prefix.subarray(0, prefixBytes))
    await handle.sync()
    await handle.close()
    await assertDownloadTarget(target)
    await SafeFileIO.absent(target.path)
    try {
      await fs.link(staged, target.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Refusing to overwrite an existing workspace file: ${target.relative}`)
      }
      throw error
    }
    return {
      path: target.relative,
      filename: path.basename(target.path),
      sourceFilename: sourceFilename(response),
      bytes,
      sha256: hash.digest("hex"),
      contentType: response.headers.get("content-type") ?? "",
    }
  } finally {
    await handle.close().catch(() => {})
    await fs.rm(staged, { force: true })
  }
}

async function extractTextFromHTML(html: string) {
  let text = ""
  let skipContent = false

  const rewriter = new HTMLRewriter()
    .on("script, style, noscript, iframe, object, embed", {
      element() {
        skipContent = true
      },
      text() {
        // Skip text content inside these elements
      },
    })
    .on("*", {
      element(element) {
        // Reset skip flag when entering other elements
        if (!["script", "style", "noscript", "iframe", "object", "embed"].includes(element.tagName)) {
          skipContent = false
        }
      },
      text(input) {
        if (!skipContent) {
          text += input.text
        }
      },
    })
    .transform(new Response(html))

  await rewriter.text()
  return text.trim()
}

function convertHTMLToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: "atx",
    hr: "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
    emDelimiter: "*",
  })
  turndownService.remove(["script", "style", "meta", "link"])
  return turndownService.turndown(html)
}

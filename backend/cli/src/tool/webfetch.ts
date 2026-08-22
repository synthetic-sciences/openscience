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
import os from "node:os"
import path from "node:path"
import { ToolRetryGuard } from "@/session/tool-retry-guard"
import { AuthoritySignal } from "@/project/authority-signal"

export const MAX_RESPONSE_SIZE = 5 * 1024 * 1024 // 5 MiB
const DEFAULT_TIMEOUT = 30 * 1000 // 30 seconds
const MAX_TIMEOUT = 120 * 1000 // 2 minutes
const DEFAULT_DOWNLOAD_TIMEOUT = 10 * 60 * 1000 // 10 minutes
const MAX_DOWNLOAD_TIMEOUT = 30 * 60 * 1000 // 30 minutes
export const DOWNLOAD_DISK_RESERVE_BYTES = 512 * 1024 * 1024 // preserve 512 MiB for the host

function generatedDownloadName(url: unknown, format: unknown) {
  const suffix = format === "html" ? "html" : format === "markdown" ? "md" : "txt"
  return `download-${crypto
    .createHash("sha256")
    .update(String(url ?? "download"))
    .digest("hex")
    .slice(0, 12)}.${suffix}`
}

/**
 * Models naturally express destinations as absolute temp paths or nested
 * workspace paths. The broker never honors those directories: it reduces the
 * request to one safe root filename before validation or permission checks.
 */
export function normalizeDownloadOutputPath(args: unknown) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args
  const result = { ...(args as Record<string, unknown>) }
  const requested = result.output_path
  if (typeof requested !== "string" || !requested || requested !== requested.trim()) return result

  const portable = requested.replaceAll("\\", "/")
  const absolute = path.posix.isAbsolute(portable) || path.win32.isAbsolute(requested)
  const normalizedTemp = path.resolve(requested)
  const commonTempDirectory = ["/tmp", "/var/tmp", os.tmpdir()].some(
    (candidate) => normalizedTemp === path.resolve(candidate),
  )
  const basename = path.posix.basename(portable.replace(/\/+$/, ""))
  const useGenerated = !basename || basename === "." || basename === "/" || (absolute && commonTempDirectory)
  if (absolute || portable.includes("/")) {
    result.output_path = useGenerated ? generatedDownloadName(result.url, result.format) : basename
  }
  return result
}

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
      .min(1)
      .refine((value) => value === value.trim(), "output_path must not be blank or have surrounding whitespace")
      .optional()
      .describe(
        "Optional destination. Absolute and folder paths are reduced to a new filename at the root of this session's workspace, " +
          "so mutable intermediate directories can never redirect a brokered write. For papers/foo.pdf, the broker downloads " +
          'to output_path:"foo.pdf"; only after ' +
          "success run sandboxed Bash: mkdir -p -- 'papers' && test ! -e 'papers/foo.pdf' && mv -- 'foo.pdf' 'papers/foo.pdf'. " +
          "Use download mode for archives, " +
          "compressed datasets, binary files, or text responses larger than 5 MiB.",
      ),
  })
  .strict()

export const WebFetchTool = Tool.define("webfetch", {
  description: DESCRIPTION,
  parameters,
  // Parse defaults and strip retired max_bytes / declared-size fields from
  // older callers. Download authority now comes only from live disk capacity.
  normalizeInput(args) {
    const normalized = normalizeDownloadOutputPath(args)
    if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) return normalized
    const result = { ...(normalized as Record<string, unknown>) }
    delete result.max_bytes
    delete result.declared_size_bytes
    delete result.declared_size_evidence_call_id
    return result
  },
  async execute(params, ctx) {
    // Validate URL
    if (!params.url.startsWith("http://") && !params.url.startsWith("https://")) {
      throw new Error("URL must start with http:// or https://")
    }
    // Resolve the complete local write contract before asking for network or
    // tool permission. Invalid destinations must never create approval noise.
    using download =
      params.output_path !== undefined ? await resolveDownloadTarget(ctx.sessionID, params.output_path) : undefined
    await ToolRetryGuard.assertWebFetch(ctx, params)
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
      },
    })

    const downloadCapacity = download
      ? await safeDownloadCapacity(download).catch((error) => {
          if (error instanceof DownloadCapacityError) {
            throw ToolRetryGuard.annotateWebFetch(ctx, params, error, {
              safeCapacityBytes: error.safeCapacityBytes,
              declaredSizeBytes: error.responseBytes,
            })
          }
          throw error
        })
      : undefined
    const defaultTimeout = download ? DEFAULT_DOWNLOAD_TIMEOUT : DEFAULT_TIMEOUT
    const maxTimeout = download ? MAX_DOWNLOAD_TIMEOUT : MAX_TIMEOUT
    const timeout = Math.min((params.timeout ?? defaultTimeout / 1000) * 1000, maxTimeout)
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
          ? { authorize, streamResponse: true, maxResponseBytes: downloadCapacity! }
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
            ? { authorize, streamResponse: true, maxResponseBytes: downloadCapacity! }
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
      if (download) {
        const result = await streamDownload(response, download, downloadCapacity!)
        return {
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
        }
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
            return {
              output: markdown,
              title,
              metadata: responseMetadata,
            }
          }
          return {
            output: content,
            title,
            metadata: responseMetadata,
          }

        case "text":
          if (contentType.includes("text/html")) {
            const text = await extractTextFromHTML(content)
            return {
              output: text,
              title,
              metadata: responseMetadata,
            }
          }
          return {
            output: content,
            title,
            metadata: responseMetadata,
          }

        case "html":
          return {
            output: content,
            title,
            metadata: responseMetadata,
          }

        default:
          return {
            output: content,
            title,
            metadata: responseMetadata,
          }
      }
    } catch (error) {
      if (error instanceof Network.ResponseTooLargeError) {
        if (download) {
          const failure = downloadCapacityError(error.limitBytes, error.declaredBytes ?? error.receivedBytes)
          throw ToolRetryGuard.annotateWebFetch(ctx, params, failure, {
            safeCapacityBytes: error.limitBytes,
            declaredSizeBytes: error.declaredBytes,
          })
        }
        throw ToolRetryGuard.annotateWebFetch(ctx, params, responseTooLargeError(error))
      }
      if (error instanceof DownloadCapacityError) {
        throw ToolRetryGuard.annotateWebFetch(ctx, params, error, {
          safeCapacityBytes: error.safeCapacityBytes,
          declaredSizeBytes: error.responseBytes,
        })
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
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GiB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${bytes} bytes`
}

function downloadGuidance() {
  return (
    "Do not repeat the same text-mode request. For a data file, call Web fetch again with a root-only filename such as " +
    'output_path:"foo.pdf"; it will stream through the authorized network broker without entering model context. ' +
    "For a folder destination such as papers/foo.pdf, only after that download succeeds run sandboxed Bash: " +
    "mkdir -p -- 'papers' && test ! -e 'papers/foo.pdf' && mv -- 'foo.pdf' 'papers/foo.pdf'. " +
    "For a large JSON API response, request a smaller page " +
    "and follow its pagination metadata. WebFetch derives download capacity from live free disk; never add download-cap or claimed-size override fields."
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
  authorization?: SessionFilesystem.Authorization
  [Symbol.dispose](): void
}

function exactBytes(bytes: number) {
  return `${formatBytes(bytes)} (${bytes} bytes)`
}

class DownloadCapacityError extends Error {
  constructor(
    readonly safeCapacityBytes: number,
    readonly responseBytes?: number,
    readonly storageCode?: "ENOSPC" | "EDQUOT",
  ) {
    const observedText = responseBytes === undefined ? "" : `; response size ${exactBytes(responseBytes)}`
    const heading = storageCode
      ? `Download could not continue because workspace storage returned ${storageCode}. ` +
        `The current disk-derived workspace capacity is ${exactBytes(safeCapacityBytes)}${observedText}. `
      : `Download exceeds the current safe workspace capacity of ${exactBytes(safeCapacityBytes)}${observedText}. `
    super(
      heading +
        `This capacity is computed from live free disk minus the ${exactBytes(DOWNLOAD_DISK_RESERVE_BYTES)} host reserve. ` +
        "No destination file was created. Use a smaller or paginated source, free disk space, a provider-native dataset " +
        "client, or a dedicated approved transfer path. Do not retry the unchanged URL without changing that strategy.",
    )
    this.name = "DownloadCapacityError"
  }
}

function downloadCapacityError(safeCapacityBytes: number, responseBytes?: number, storageCode?: "ENOSPC" | "EDQUOT") {
  return new DownloadCapacityError(safeCapacityBytes, responseBytes, storageCode)
}

function storageCapacityCode(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code
  return code === "ENOSPC" || code === "EDQUOT" ? code : undefined
}

async function availableDownloadBytes(target: DownloadTarget) {
  const disk = await fs.statfs(target.root)
  const available = disk.bavail * disk.bsize
  if (!Number.isSafeInteger(available) || available < 0) {
    throw new Error("Workspace disk capacity could not be represented safely; the download was not started")
  }
  return Math.max(0, available - DOWNLOAD_DISK_RESERVE_BYTES)
}

async function safeDownloadCapacity(target: DownloadTarget) {
  const capacity = await availableDownloadBytes(target)
  if (capacity > 0) return capacity
  throw downloadCapacityError(capacity)
}

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`
}

function folderDestinationGuidance(requested: string) {
  // WebFetch documents slash-separated workspace paths even on platforms
  // whose native separator differs. Only offer a copy-ready move for a
  // canonical relative spelling; traversal and ambiguous spellings fail with
  // the generic root-only error below.
  const parts = requested.split("/")
  if (parts.length < 2 || parts.some((part) => !part || part === "." || part === "..")) return
  const filename = parts.at(-1)!
  const folder = parts.slice(0, -1).join("/")
  const destination = parts.join("/")
  return (
    "output_path is root-only by design: brokered downloads must not traverse mutable intermediate directories. " +
    `Retry with output_path:${JSON.stringify(filename)}. Only after that download succeeds, run sandboxed Bash from the workspace: ` +
    `mkdir -p -- ${shellQuote(folder)} && test ! -e ${shellQuote(destination)} && mv -- ${shellQuote(filename)} ${shellQuote(destination)}`
  )
}

async function resolveDownloadTarget(sessionID: string, requested: string): Promise<DownloadTarget> {
  if (!requested || requested !== requested.trim() || requested.includes("\0")) {
    throw new Error("output_path must be a non-empty workspace-root filename without surrounding whitespace")
  }
  if (path.isAbsolute(requested)) {
    throw new Error("output_path must be a workspace-root filename, not an absolute path")
  }
  if (requested !== path.basename(requested)) {
    const guidance = folderDestinationGuidance(requested)
    if (guidance) throw new Error(guidance)
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
  if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    throw new Error("output_path must stay inside this session's workspace and name a file")
  }
  // Direct tool unit tests use synthetic session ids. Every production tool
  // call carries a real ses_* id and must also satisfy the durable write grant.
  const authorization = await (async () => {
    if (!sessionID.startsWith("ses_")) return
    const authorized = await SessionFilesystem.authorize({ sessionID, path: target, access: "write" })
    if (authorized.path !== target) throw new Error("Download destination changed during authorization")
    return SessionFilesystem.bindAuthorization({ sessionID, access: "write", authorized })
  })()
  const dispose = () => {
    if (authorization) SessionFilesystem.releaseAuthorization(authorization)
  }
  return SafeFileIO.absent(target).then(
    () => ({ root, path: target, relative, authorization, [Symbol.dispose]: dispose }),
    (error) => {
      dispose()
      throw error
    },
  )
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

async function refreshDownloadCapacity(response: Response, target: DownloadTarget, initialCapacity: number) {
  const currentCapacity = await safeDownloadCapacity(target)
  const capacity = Math.min(initialCapacity, currentCapacity)
  const declared = parseContentLength(response.headers.get("content-length"))
  if (declared !== undefined && declared > capacity) throw downloadCapacityError(capacity, declared)
  return capacity
}

async function refreshStreamingCapacity(target: DownloadTarget, initialCapacity: number, bytesWritten: number) {
  const available = await availableDownloadBytes(target)
  // statfs already reflects bytes written to the staged file. Add those bytes
  // back only to express a total-transfer ceiling, and never grow beyond the
  // initial snapshot. Rechecking before every write preserves the host reserve
  // if another process consumes disk while an unknown/chunked body is flowing.
  const remainingInitialBudget = Math.max(0, initialCapacity - bytesWritten)
  return bytesWritten + Math.min(remainingInitialBudget, available)
}

async function streamDownload(response: Response, target: DownloadTarget, initialCapacity: number) {
  let capacity: number
  try {
    await assertDownloadTarget(target)
    await SafeFileIO.absent(target.path)
    capacity = await refreshDownloadCapacity(response, target, initialCapacity)
  } catch (error) {
    await response.body?.cancel().catch(() => {})
    throw error
  }

  // Stage outside the writable session root. Combined with the direct-child
  // output_path contract, a concurrent runtime cannot swap an intermediate
  // directory to redirect either the temporary write or final hard-link.
  const staged = path.join(path.dirname(target.root), `.openscience-download-${crypto.randomUUID()}.tmp`)
  let handle: fs.FileHandle
  try {
    handle = await fs.open(staged, FS.O_WRONLY | FS.O_CREAT | FS.O_EXCL | FS.O_NOFOLLOW, 0o644)
  } catch (error) {
    await response.body?.cancel().catch(() => {})
    await fs.rm(staged, { force: true }).catch(() => {})
    const storageCode = storageCapacityCode(error)
    if (!storageCode) throw error
    const liveCapacity = await refreshStreamingCapacity(target, initialCapacity, 0).catch(() => capacity)
    throw downloadCapacityError(liveCapacity, undefined, storageCode)
  }
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
          capacity = await refreshStreamingCapacity(target, initialCapacity, bytes)
          if (bytes + next.value.byteLength > capacity) {
            await reader.cancel().catch(() => {})
            throw downloadCapacityError(capacity, bytes + next.value.byteLength)
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
    const install = async () => {
      if (target.authorization) {
        const current = await SessionFilesystem.revalidateAuthorization(target.authorization, {
          path: target.path,
          access: "write",
        })
        if (current.path !== target.path) throw new Error("Download destination changed during final authorization")
      }
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
    }
    if (target.authorization) await AuthoritySignal.exclusive(install)
    else await install()
    return {
      path: target.relative,
      filename: path.basename(target.path),
      sourceFilename: sourceFilename(response),
      bytes,
      sha256: hash.digest("hex"),
      contentType: response.headers.get("content-type") ?? "",
    }
  } catch (error) {
    const storageCode = storageCapacityCode(error)
    if (!storageCode) throw error
    const liveCapacity = await refreshStreamingCapacity(target, initialCapacity, bytes).catch(() => capacity)
    throw downloadCapacityError(liveCapacity, bytes || undefined, storageCode)
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

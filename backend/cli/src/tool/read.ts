import z from "zod"
import * as fs from "fs"
import * as path from "path"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { FileTime } from "../file/time"
import DESCRIPTION from "./read.txt"
import { Instance } from "../project/instance"
import { Identifier } from "../id/id"
import { assertExternalDirectory, isAuthorizedPath, sessionToolDirectory } from "./external-directory"
import { InstructionPrompt } from "../session/instruction"
import { readImageDimensions } from "../util/image"
import { SafeFileIO } from "@/file/safe-io"

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_BYTES = 50 * 1024
// Bound base64 attachments before encoding so one file cannot exhaust the
// local process or provider request budget.
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024
// Anthropic rejects images with any dimension > 2000px in multi-image turns.
const MAX_IMAGE_DIMENSION = 2000

function usesAnthropicImageLimit(ctx: Tool.Context) {
  const model = ctx.extra?.model as { providerID?: unknown; id?: unknown; modelID?: unknown } | undefined
  const provider = String(model?.providerID ?? "").toLowerCase()
  const id = String(model?.id ?? model?.modelID ?? "").toLowerCase()
  return provider === "anthropic" || id.includes("anthropic/") || id.includes("claude")
}

async function missing(filepath: string): Promise<never> {
  const dir = path.dirname(filepath)
  const base = path.basename(filepath).toLowerCase()
  const suggestions: string[] = []
  const entries = await fs.promises.opendir(dir).catch(() => undefined)
  if (entries) {
    const visited = { count: 0 }
    for await (const entry of entries) {
      if (visited.count++ >= 10_000 || suggestions.length >= 3) break
      const name = entry.name.toLowerCase()
      if (!name.includes(base) && !base.includes(name)) continue
      suggestions.push(path.join(dir, entry.name))
    }
  }
  if (suggestions.length) {
    throw new Error(`File not found: ${filepath}\n\nDid you mean one of these?\n${suggestions.join("\n")}`)
  }
  throw new Error(`File not found: ${filepath}`)
}

async function textWindow(filepath: string, offset: number, limit: number) {
  if (isBinaryFile(filepath, new Uint8Array())) throw new Error(`Cannot read binary file: ${filepath}`)
  const source = await SafeFileIO.open(filepath)
  const reader = source.stream().getReader()
  const decoder = new TextDecoder()
  const state = {
    binaryChecked: false,
    bytes: 0,
    hasMore: false,
    line: "",
    lineNumber: 0,
    lineWide: false,
    raw: [] as string[],
    stopped: false,
    truncatedByBytes: false,
  }
  const append = (value: string) => {
    const remaining = MAX_LINE_LENGTH - state.line.length
    if (remaining > 0) state.line += value.slice(0, remaining)
    if (value.length > remaining) state.lineWide = true
  }
  const finishLine = () => {
    const current = state.lineNumber++
    if (current < offset) {
      state.line = ""
      state.lineWide = false
      return false
    }
    if (state.raw.length >= limit) {
      state.hasMore = true
      return true
    }
    const plain = state.line.endsWith("\r") ? state.line.slice(0, -1) : state.line
    const line = state.lineWide ? `${plain}...` : plain
    const size = Buffer.byteLength(line, "utf8") + (state.raw.length ? 1 : 0)
    if (state.bytes + size > MAX_BYTES) {
      state.truncatedByBytes = true
      state.hasMore = true
      return true
    }
    state.raw.push(line)
    state.bytes += size
    state.line = ""
    state.lineWide = false
    return false
  }
  const consume = (value: string) => {
    const cursor = { value: 0 }
    while (cursor.value < value.length) {
      const newline = value.indexOf("\n", cursor.value)
      const end = newline === -1 ? value.length : newline
      append(value.slice(cursor.value, end))
      if (newline === -1) return false
      if (finishLine()) return true
      cursor.value = newline + 1
    }
    return false
  }
  try {
    while (!state.stopped) {
      const chunk = await reader.read()
      if (chunk.done) {
        state.stopped = consume(decoder.decode()) || finishLine()
        break
      }
      if (!state.binaryChecked) {
        state.binaryChecked = true
        if (isBinaryFile(filepath, chunk.value.subarray(0, 4_096))) {
          throw new Error(`Cannot read binary file: ${filepath}`)
        }
      }
      state.stopped = consume(decoder.decode(chunk.value, { stream: true }))
    }
    if (state.hasMore) await reader.cancel()
    return {
      raw: state.raw,
      hasMoreLines: state.hasMore,
      totalLines: state.lineNumber,
      truncatedByBytes: state.truncatedByBytes,
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    throw error
  } finally {
    reader.releaseLock()
  }
}

export const ReadTool = Tool.define("read", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("The path to the file to read"),
    offset: z.coerce
      .number()
      .int()
      .nonnegative()
      .describe("The line number to start reading from (0-based)")
      .optional(),
    limit: z.coerce
      .number()
      .int()
      .nonnegative()
      .max(10_000)
      .describe("The number of lines to read (defaults to 2000)")
      .optional(),
  }),
  async execute(params, ctx) {
    const directory = await sessionToolDirectory(ctx)
    const requested = path.isAbsolute(params.filePath) ? params.filePath : path.resolve(directory, params.filePath)
    const retained = isAuthorizedPath(ctx.extra?.["fileAuthorization"]) ? ctx.extra?.["fileAuthorization"] : undefined
    if (retained && retained.path !== requested) {
      throw new Error("Retained file authorization does not match the requested path")
    }
    using owned = retained
      ? undefined
      : await assertExternalDirectory(ctx, requested, {
          bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
          access: "read",
        })
    const authorized = retained ?? owned
    let filepath = authorized?.path ?? requested

    if (!retained && !authorized?.managedToolOutput) {
      await ctx.ask({
        permission: "read",
        patterns: [filepath],
        always: ["*"],
        metadata: {},
      })
    }

    filepath = (await authorized?.revalidate()) ?? filepath
    const title = path.relative(Instance.worktree, filepath)

    const file = Bun.file(filepath)
    // Exclude SVG (XML-based) and vnd.fastbidsheet (.fbs extension, commonly FlatBuffers schema files)
    const isImage =
      file.type.startsWith("image/") && file.type !== "image/svg+xml" && file.type !== "image/vnd.fastbidsheet"
    const isPdf = file.type === "application/pdf"
    if (isImage || isPdf) {
      const kind = isImage ? "Image" : "PDF"
      const snapshot = await SafeFileIO.optional(filepath, { maxBytes: MAX_ATTACHMENT_BYTES }).catch(
        (error: unknown) => {
          if (error instanceof SafeFileIO.LimitError) {
            throw new Error(
              `${kind} too large to attach (${error.size} bytes > ${MAX_ATTACHMENT_BYTES}). ` +
                `The harness caps base64 attachments at 32 MiB. ` +
                (isPdf
                  ? "Use the liteparse skill to extract text via the `lit` CLI instead " +
                    "(install with `npm i -g @llamaindex/liteparse` if missing)."
                  : "Crop or downscale the image."),
            )
          }
          throw error
        },
      )
      if (!snapshot) return missing(filepath)
      const instructions = await InstructionPrompt.resolve(ctx.messages, filepath, ctx.messageID)
      const mime = file.type
      const fileBytes = snapshot.bytes
      if (isImage) {
        const dims = readImageDimensions(fileBytes)
        if (usesAnthropicImageLimit(ctx) && dims && Math.max(dims.width, dims.height) > MAX_IMAGE_DIMENSION) {
          throw new Error(
            `Image too large to attach (${dims.width}x${dims.height}). ` +
              `Anthropic's API rejects any image dimension > ${MAX_IMAGE_DIMENSION}px in multi-image requests, ` +
              `which would poison the entire session. Downscale first, e.g.:\n` +
              `  magick "${filepath}" -resize ${MAX_IMAGE_DIMENSION - 200}x${MAX_IMAGE_DIMENSION - 200}\\> "${filepath}"`,
          )
        }
      }
      const msg = `${kind} read successfully`
      return {
        title,
        output: msg,
        metadata: {
          preview: msg,
          truncated: false,
          ...(instructions.length > 0 && { loaded: instructions.map((i) => i.filepath) }),
        },
        attachments: [
          {
            id: Identifier.ascending("part"),
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            type: "file",
            mime,
            url: `data:${mime};base64,${Buffer.from(fileBytes).toString("base64")}`,
          },
        ],
      }
    }

    const limit = params.limit ?? DEFAULT_READ_LIMIT
    const offset = params.offset || 0
    const window = await textWindow(filepath, offset, limit).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return missing(filepath)
      throw error
    })
    const instructions = await InstructionPrompt.resolve(ctx.messages, filepath, ctx.messageID)
    const raw = window.raw

    const content = raw.map((line, index) => {
      return `${(index + offset + 1).toString().padStart(5, "0")}| ${line}`
    })
    const preview = raw.slice(0, 20).join("\n")

    let output = "<file>\n"
    output += content.join("\n")

    const totalLines = window.totalLines
    const lastReadLine = offset + raw.length
    const hasMoreLines = window.hasMoreLines
    const truncated = hasMoreLines || window.truncatedByBytes

    if (window.truncatedByBytes) {
      output += `\n\n(Output truncated at ${MAX_BYTES} bytes. Use 'offset' parameter to read beyond line ${lastReadLine})`
    } else if (hasMoreLines) {
      output += `\n\n(File has more lines. Use 'offset' parameter to read beyond line ${lastReadLine})`
    } else {
      output += `\n\n(End of file - total ${totalLines} lines)`
    }
    output += "\n</file>"

    // just warms the lsp client
    if (!ctx.extra?.["skipLSP"]) LSP.touchFile(filepath, false)
    FileTime.read(ctx.sessionID, filepath)

    if (instructions.length > 0) {
      output += `\n\n<system-reminder>\n${instructions.map((i) => i.content).join("\n\n")}\n</system-reminder>`
    }

    return {
      title,
      output,
      metadata: {
        preview,
        truncated,
        ...(instructions.length > 0 && { loaded: instructions.map((i) => i.filepath) }),
      },
    }
  },
})

function isBinaryFile(filepath: string, buffer: Uint8Array): boolean {
  const ext = path.extname(filepath).toLowerCase()
  // binary check for common non-text extensions
  switch (ext) {
    case ".zip":
    case ".tar":
    case ".gz":
    case ".exe":
    case ".dll":
    case ".so":
    case ".class":
    case ".jar":
    case ".war":
    case ".7z":
    case ".doc":
    case ".docx":
    case ".xls":
    case ".xlsx":
    case ".ppt":
    case ".pptx":
    case ".odt":
    case ".ods":
    case ".odp":
    case ".bin":
    case ".dat":
    case ".obj":
    case ".o":
    case ".a":
    case ".lib":
    case ".wasm":
    case ".pyc":
    case ".pyo":
      return true
    default:
      break
  }

  const fileSize = buffer.byteLength
  if (fileSize === 0) return false

  const bufferSize = Math.min(4096, fileSize)
  const bytes = buffer.subarray(0, bufferSize)

  let nonPrintableCount = 0
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return true
    if (bytes[i] < 9 || (bytes[i] > 13 && bytes[i] < 32)) {
      nonPrintableCount++
    }
  }
  // If >30% non-printable characters, consider it binary
  return nonPrintableCount / bytes.length > 0.3
}

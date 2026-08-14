import z from "zod"
import * as fs from "fs"
import * as path from "path"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { FileTime } from "../file/time"
import DESCRIPTION from "./read.txt"
import { Instance } from "../project/instance"
import { Identifier } from "../id/id"
import { assertExternalDirectory, sessionToolDirectory } from "./external-directory"
import { InstructionPrompt } from "../session/instruction"
import { readImageDimensions } from "../util/image"
import { SafeFileIO } from "@/file/safe-io"

const DEFAULT_READ_LIMIT = 2000
const MAX_LINE_LENGTH = 2000
const MAX_BYTES = 50 * 1024
// Anthropic's API caps base64-embedded PDFs/images at ~32 MB. Reject bigger
// files up front instead of OOMing while encoding.
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024
// Anthropic rejects images with any dimension > 2000px when a request contains
// multiple images. Reject at attach time so a single oversized figure cannot
// poison the entire session's history (which would fail every follow-up turn).
const MAX_IMAGE_DIMENSION = 2000

export const ReadTool = Tool.define("read", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("The path to the file to read"),
    offset: z.coerce.number().describe("The line number to start reading from (0-based)").optional(),
    limit: z.coerce.number().describe("The number of lines to read (defaults to 2000)").optional(),
  }),
  async execute(params, ctx) {
    const directory = await sessionToolDirectory(ctx)
    const requested = path.isAbsolute(params.filePath) ? params.filePath : path.resolve(directory, params.filePath)
    const authorized = await assertExternalDirectory(ctx, requested, {
      bypass: Boolean(ctx.extra?.["bypassCwdCheck"]),
      access: "read",
    })
    const filepath = authorized?.path ?? requested
    const title = path.relative(Instance.worktree, filepath)

    if (!authorized?.managedToolOutput) {
      await ctx.ask({
        permission: "read",
        patterns: [filepath],
        always: ["*"],
        metadata: {},
      })
    }

    const snapshot = await SafeFileIO.optional(filepath)
    if (!snapshot) {
      const dir = path.dirname(filepath)
      const base = path.basename(filepath)

      const dirEntries = fs.readdirSync(dir)
      const suggestions = dirEntries
        .filter(
          (entry) =>
            entry.toLowerCase().includes(base.toLowerCase()) || base.toLowerCase().includes(entry.toLowerCase()),
        )
        .map((entry) => path.join(dir, entry))
        .slice(0, 3)

      if (suggestions.length > 0) {
        throw new Error(`File not found: ${filepath}\n\nDid you mean one of these?\n${suggestions.join("\n")}`)
      }

      throw new Error(`File not found: ${filepath}`)
    }
    const file = Bun.file(filepath)

    const instructions = await InstructionPrompt.resolve(ctx.messages, filepath, ctx.messageID)

    // Exclude SVG (XML-based) and vnd.fastbidsheet (.fbs extension, commonly FlatBuffers schema files)
    const isImage =
      file.type.startsWith("image/") && file.type !== "image/svg+xml" && file.type !== "image/vnd.fastbidsheet"
    const isPdf = file.type === "application/pdf"
    if (isImage || isPdf) {
      const kind = isImage ? "Image" : "PDF"
      if (snapshot.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        throw new Error(
          `${kind} too large to attach (${snapshot.bytes.byteLength} bytes > ${MAX_ATTACHMENT_BYTES}). ` +
            `Anthropic's API caps base64 attachments at ~32 MB. ` +
            (isPdf
              ? "Use the liteparse skill to extract text via the `lit` CLI instead " +
                "(install with `npm i -g @llamaindex/liteparse` if missing)."
              : "Crop or downscale the image."),
        )
      }
      const mime = file.type
      const fileBytes = snapshot.bytes
      if (isImage) {
        const dims = readImageDimensions(fileBytes)
        if (dims && Math.max(dims.width, dims.height) > MAX_IMAGE_DIMENSION) {
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

    const isBinary = isBinaryFile(filepath, snapshot.bytes)
    if (isBinary) throw new Error(`Cannot read binary file: ${filepath}`)

    const limit = params.limit ?? DEFAULT_READ_LIMIT
    const offset = params.offset || 0
    const lines = snapshot.bytes.toString("utf8").split("\n")

    const raw: string[] = []
    let bytes = 0
    let truncatedByBytes = false
    for (let i = offset; i < Math.min(lines.length, offset + limit); i++) {
      const line = lines[i].length > MAX_LINE_LENGTH ? lines[i].substring(0, MAX_LINE_LENGTH) + "..." : lines[i]
      const size = Buffer.byteLength(line, "utf-8") + (raw.length > 0 ? 1 : 0)
      if (bytes + size > MAX_BYTES) {
        truncatedByBytes = true
        break
      }
      raw.push(line)
      bytes += size
    }

    const content = raw.map((line, index) => {
      return `${(index + offset + 1).toString().padStart(5, "0")}| ${line}`
    })
    const preview = raw.slice(0, 20).join("\n")

    let output = "<file>\n"
    output += content.join("\n")

    const totalLines = lines.length
    const lastReadLine = offset + raw.length
    const hasMoreLines = totalLines > lastReadLine
    const truncated = hasMoreLines || truncatedByBytes

    if (truncatedByBytes) {
      output += `\n\n(Output truncated at ${MAX_BYTES} bytes. Use 'offset' parameter to read beyond line ${lastReadLine})`
    } else if (hasMoreLines) {
      output += `\n\n(File has more lines. Use 'offset' parameter to read beyond line ${lastReadLine})`
    } else {
      output += `\n\n(End of file - total ${totalLines} lines)`
    }
    output += "\n</file>"

    // just warms the lsp client
    LSP.touchFile(filepath, false)
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

import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { SafeFileIO } from "../file/safe-io"
import { AuthoritySignal } from "../project/authority-signal"
import { assertExternalDirectory } from "../tool/external-directory"
import type { Tool } from "../tool/tool"
import { correctImageMime } from "../util/image"
import { SessionFilesystem } from "./filesystem"
import type { MessageV2 } from "./message-v2"

/** Explicit uploads are copied, not converted into inherited filesystem permissions. */
export namespace SubtaskAttachments {
  export const LIMIT = 32 * 1024 * 1024

  function unsupported() {
    return new Error(
      "Delegated commands accept uploaded files and regular local files only. Upload the file contents to delegate them; directories, MCP resources, and remote URLs cannot be transferred to a child session.",
    )
  }

  function limit(size: number) {
    if (size > LIMIT)
      throw new Error("Delegated attachments exceed the 32 MiB byte limit. Split or reduce the uploaded files.")
  }

  /** Decode bytes without a fetch, including percent-encoded non-UTF-8 data. */
  export function decode(url: string) {
    if (!url.startsWith("data:")) throw unsupported()
    const comma = url.indexOf(",")
    if (comma < 0) throw new Error("Invalid delegated attachment data URL")
    const payload = url.slice(comma + 1)
    if (url.slice(0, comma).split(";").includes("base64")) {
      limit(Buffer.byteLength(payload, "base64"))
      const padding = payload.endsWith("==") ? 2 : payload.endsWith("=") ? 1 : 0
      if (payload.length % 4 !== 0 || /[^A-Za-z0-9+/]/.test(payload.slice(0, payload.length - padding))) {
        throw new Error("Invalid delegated attachment base64 payload")
      }
      return Buffer.from(payload, "base64")
    }
    // Percent encoding uses at most three source bytes per decoded byte.
    if (Buffer.byteLength(payload) > LIMIT * 3) limit(LIMIT + 1)
    const source = Buffer.from(payload)
    const bytes = Buffer.allocUnsafe(Math.min(source.length, LIMIT))
    let count = 0
    for (let index = 0; index < source.length; index++) {
      limit(count + 1)
      if (source[index] !== 37) {
        bytes[count++] = source[index]!
        continue
      }
      const hex = source.subarray(index + 1, index + 3).toString("ascii")
      if (!/^[0-9a-f]{2}$/i.test(hex)) throw new Error("Invalid delegated attachment percent encoding")
      bytes[count++] = Number.parseInt(hex, 16)
      index += 2
    }
    return bytes.subarray(0, count)
  }

  export async function snapshot(
    attachments: MessageV2.SubtaskAttachment[],
    ctx: Tool.Context,
    afterAuthorization?: (path: string) => Promise<void> | void,
  ) {
    const result: MessageV2.SubtaskAttachment[] = []
    let size = 0
    for (const part of attachments) {
      ctx.abort.throwIfAborted()
      if (part.source?.type === "resource" || part.mime === "application/x-directory") throw unsupported()
      const url = new URL(part.url)
      const bytes = await (async () => {
        if (url.protocol === "data:") return decode(part.url)
        if (url.protocol !== "file:") throw unsupported()
        const requested = fileURLToPath(url)
        using authorized = await assertExternalDirectory(ctx, requested, { access: "read" })
        if (!authorized?.managedToolOutput) {
          await ctx.ask({ permission: "read", patterns: [authorized?.path ?? requested], always: ["*"], metadata: {} })
        }
        await afterAuthorization?.(requested)
        return await AuthoritySignal.exclusive(async () => {
          ctx.abort.throwIfAborted()
          const current = await authorized!.revalidate()
          ctx.abort.throwIfAborted()
          return SafeFileIO.read(current, { maxBytes: LIMIT })
            .then((snapshot) => snapshot.bytes)
            .catch((error: unknown) => {
              if (error instanceof SafeFileIO.LimitError) limit(error.size)
              if (error instanceof Error && error.message.startsWith("Only regular files can be accessed:"))
                throw unsupported()
              throw error
            })
        })
      })()
      size += bytes.byteLength
      limit(size)
      const mime = correctImageMime(part.mime, bytes)
      result.push({
        type: "file",
        filename: part.filename,
        mime,
        url: `data:${mime};base64,${bytes.toString("base64")}`,
      })
    }
    ctx.abort.throwIfAborted()
    return result
  }

  export async function materialize(
    attachments: MessageV2.SubtaskAttachment[],
    sessionID: string,
    signal: AbortSignal,
  ) {
    const result: MessageV2.SubtaskAttachment[] = []
    let size = 0
    for (const [index, part] of attachments.entries()) {
      const bytes = decode(part.url)
      size += bytes.byteLength
      limit(size)
      const name = { value: "", bytes: 0 }
      const basename = path.basename(part.filename ?? "attachment").replace(/[\x00-\x1f\x7f]/g, "_")
      // Keep the extension while reserving bytes for the durable prefix on
      // filesystems whose filename limit counts UTF-8 bytes, not characters.
      for (const character of Array.from(basename).reverse()) {
        const bytes = Buffer.byteLength(character)
        if (name.bytes + bytes > 160) break
        name.value = character + name.value
        name.bytes += bytes
      }
      const filename = name.value || "attachment"
      const digest = new Bun.CryptoHasher("sha256").update(bytes).digest("hex")
      const target = await AuthoritySignal.exclusive(async () => {
        signal.throwIfAborted()
        const workspace = await SessionFilesystem.workspace(sessionID)
        const destination = path.join(workspace, `.task-attachment-${index}-${digest.slice(0, 16)}-${filename}`)
        const previous = await SafeFileIO.optional(destination, { maxBytes: LIMIT })
        signal.throwIfAborted()
        if (previous) {
          if (!previous.bytes.equals(bytes))
            throw new Error("A delegated attachment changed before its child prompt was persisted")
        } else {
          await SafeFileIO.write(destination, bytes)
        }
        return destination
      })
      result.push({ type: "file", mime: part.mime, filename: part.filename, url: pathToFileURL(target).href })
    }
    signal.throwIfAborted()
    return result
  }
}

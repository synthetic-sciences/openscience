import type { ModelMessage, Tool } from "ai"
import { asSchema } from "@ai-sdk/provider-utils"
import { Token } from "@/util/token"
import { MessageV2 } from "./message-v2"

/** Share context preflight's text/media units instead of pricing transport bytes. */
export namespace SubagentInput {
  function object(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === "object" && !Array.isArray(value)
  }

  function attachment(mime: unknown, data: unknown): number | undefined {
    if (typeof mime !== "string") return
    if (mime.startsWith("image/")) return MessageV2.IMAGE_TOKENS
    if (mime !== "application/pdf") return
    const encoded =
      typeof data === "string" ? data : data instanceof Uint8Array ? Buffer.from(data).toString("base64") : undefined
    if (!encoded) return MessageV2.PDF_PAGE_TOKENS
    return MessageV2.documentTokens(
      mime,
      encoded.startsWith("data:") ? encoded : `data:application/pdf;base64,${encoded}`,
    )
  }

  function media(value: Record<string, unknown>): number | undefined {
    if (
      typeof value.type === "string" &&
      ["image", "image_url", "input_image", "image-data", "image-url"].includes(value.type)
    )
      return MessageV2.IMAGE_TOKENS
    if (value.type === "file" || value.type === "media") {
      const estimate = attachment(value.mediaType ?? value.mimeType, value.data)
      if (estimate !== undefined) return estimate
    }
    if (value.type === "document" && object(value.source)) return attachment(value.source.media_type, value.source.data)
    if (value.type === "input_file" || (value.type === "file" && object(value.file))) {
      const data = value.file_data ?? (object(value.file) ? value.file.file_data : undefined)
      if (typeof data === "string" && data.startsWith("data:application/pdf"))
        return attachment("application/pdf", data)
    }
    if (object(value.inlineData)) return attachment(value.inlineData.mimeType, value.inlineData.data)
    if (object(value.fileData)) return attachment(value.fileData.mimeType, undefined)
    if (object(value.image) && object(value.image.source)) return MessageV2.IMAGE_TOKENS
    if (object(value.document) && value.document.format === "pdf" && object(value.document.source))
      return attachment("application/pdf", value.document.source.bytes)
  }

  function count(value: unknown, encoded = true): number {
    if (typeof value === "string") return Token.estimate(value)
    if (Array.isArray(value)) return value.reduce((sum, item) => sum + count(item, encoded), 0)
    if (!object(value)) return 0
    const estimate = encoded ? media(value) : undefined
    if (estimate !== undefined) return estimate
    const call =
      ["tool-call", "tool_use", "function_call", "json", "error-json"].includes(String(value.type)) ||
      "functionCall" in value ||
      "functionResponse" in value ||
      "toolUse" in value
    return Object.entries(value).reduce(
      (sum, [key, item]) =>
        sum +
        Token.estimate(key) +
        count(item, encoded && !call && !["tools", "parameters", "input_schema", "json"].includes(key)),
      0,
    )
  }

  export function estimate(value: unknown, overhead = 256) {
    // A margin covers wrappers and tokenizer variation; final usage remains authoritative.
    return Math.ceil(count(value) * 1.25) + overhead
  }

  export async function prompt(input: { system: string[]; messages: ModelMessage[]; tools: Record<string, Tool> }) {
    const tools = await Promise.all(
      Object.entries(input.tools).map(async ([name, tool]) => ({
        name,
        description: tool.description ?? "",
        parameters: await asSchema(tool.inputSchema).jsonSchema,
      })),
    )
    return estimate({ system: input.system, messages: input.messages, tools }, 1024)
  }
}

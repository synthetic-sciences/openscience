import path from "node:path"
import z from "zod"
import { Tool } from "./tool"
import { Provider } from "@/provider/provider"
import { OpenScience } from "@/openscience"
import { Instance } from "@/project/instance"
import { SafeFileIO } from "@/file/safe-io"
import { assertExternalDirectory, sessionToolDirectory } from "./external-directory"
import { AuthoritySignal } from "@/project/authority-signal"
import { Identifier } from "@/id/id"
import { Bus } from "@/bus"
import { File } from "@/file"
import { FileWatcher } from "@/file/watcher"
import { Network } from "@/settings/network"

const MAX_IMAGE_BYTES = 30 * 1024 * 1024
const MAX_IMAGE_RESPONSE_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 1024 * 1024
const MAX_IMAGE_ERROR_BYTES = 1024 * 1024
const MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024
const DEFAULT_MODEL = "google/gemini-3-pro-image"

type OpenRouterImage = {
  data?: Array<{
    b64_json?: string
    media_type?: string
  }>
  choices?: Array<{
    message?: {
      images?: unknown[]
      content?: unknown
    }
  }>
  error?:
    | {
        message?: string
      }
    | string
  message?: string
}

function imageURL(value: unknown): string | undefined {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object") return
  const item = value as Record<string, unknown>
  if (typeof item.url === "string") return item.url
  if (typeof item.image_url === "string") return item.image_url
  if (item.image_url && typeof item.image_url === "object") {
    const nested = item.image_url as Record<string, unknown>
    if (typeof nested.url === "string") return nested.url
  }
}

function remoteImageURL(value: unknown): string | undefined {
  if (typeof value === "string") {
    const direct = /https:\/\/[^\s"'<>\\]+/i.exec(value)?.[0]?.replace(/[),.;]+$/, "")
    if (direct) return direct
    return
  }
  if (!value || typeof value !== "object") return
  const item = value as Record<string, unknown>
  if (typeof item.imageUrl === "string" && item.imageUrl.startsWith("https://")) return item.imageUrl
  if (typeof item.url === "string" && item.url.startsWith("https://")) return item.url
  if (typeof item.image_url === "string" && item.image_url.startsWith("https://")) return item.image_url
  for (const nested of Object.values(item)) {
    const found = Array.isArray(nested)
      ? nested.map(remoteImageURL).find((url): url is string => !!url)
      : remoteImageURL(nested)
    if (found) return found
  }
}

function decodeImage(value: string) {
  const whitespace = { value: 0 }
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32) whitespace.value++
  }
  const length = value.length - whitespace.value
  const ceiling = Math.ceil(MAX_IMAGE_BYTES / 3) * 4
  if (length > ceiling) throw new Error("The generated image exceeds the 30 MB safety limit.")
  const encoded = whitespace.value ? value.replace(/\s/g, "") : value
  if (encoded.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error("The image model returned an unsupported image payload.")
  }
  const padding = encoded.endsWith("==") ? 2 : encoded.endsWith("=") ? 1 : 0
  const size = Math.floor((encoded.length * 3) / 4) - padding
  if (size > MAX_IMAGE_BYTES) throw new Error("The generated image exceeds the 30 MB safety limit.")
  const bytes = Buffer.from(encoded, "base64")
  if (bytes.byteLength === 0) throw new Error("The image model returned an empty image.")
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("The generated image exceeds the 30 MB safety limit.")
  return bytes
}

export function extractGeneratedImage(value: OpenRouterImage) {
  const generated = value.data?.find((item) => typeof item.b64_json === "string" && item.b64_json.length > 0)
  if (generated?.b64_json) {
    const mime = generated.media_type ?? "image/png"
    if (!/^image\/(?:png|jpeg|webp|gif)$/.test(mime)) {
      throw new Error(`The image model returned an unsupported image format (${mime}).`)
    }
    const bytes = decodeImage(generated.b64_json)
    return { mime, bytes }
  }

  const message = value.choices?.[0]?.message
  const images = Array.isArray(message?.images) ? message.images : []
  const content = Array.isArray(message?.content) ? message.content : []
  const url = [...images, ...content].map(imageURL).find((item) => item?.startsWith("data:image/"))
  if (!url)
    throw new Error(
      "The image model completed without returning image bytes. Retry once or choose another image model.",
    )
  const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=\s]+)$/.exec(url)
  if (!match) throw new Error("The image model returned an unsupported image payload.")
  const bytes = decodeImage(match[2])
  return { mime: match[1], bytes }
}

export function extractGeneratedImageURL(value: OpenRouterImage) {
  return remoteImageURL(value)
}

export async function readBoundedImageResponse(response: Response, maxBytes: number) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError(`Invalid image response limit: ${maxBytes}`)
  const header = response.headers.get("content-length")
  const declared = header === null ? undefined : Number(header)
  if (declared !== undefined && Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined)
    throw new Error(`The image response exceeds the ${maxBytes}-byte safety limit.`)
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const initial =
    declared !== undefined && Number.isSafeInteger(declared) && declared >= 0
      ? Math.min(declared, maxBytes)
      : Math.min(64 * 1024, maxBytes)
  const bytes = { value: Buffer.allocUnsafe(initial) }
  const total = { value: 0 }
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      if (total.value + result.value.byteLength > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new Error(`The image response exceeds the ${maxBytes}-byte safety limit.`)
      }
      const required = total.value + result.value.byteLength
      if (required > bytes.value.byteLength) {
        const capacity = Math.min(maxBytes, Math.max(required, bytes.value.byteLength * 2, 64 * 1024))
        const expanded = Buffer.allocUnsafe(capacity)
        bytes.value.copy(expanded, 0, 0, total.value)
        bytes.value = expanded
      }
      bytes.value.set(result.value, total.value)
      total.value += result.value.byteLength
    }
    return bytes.value.subarray(0, total.value)
  } finally {
    reader.releaseLock()
  }
}

async function materializeImage(
  value: OpenRouterImage,
  signal: AbortSignal,
  authorize: NonNullable<Network.FetchPolicy["authorize"]>,
) {
  try {
    return extractGeneratedImage(value)
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("without returning image bytes")) throw error
  }
  const url = extractGeneratedImageURL(value)
  if (!url) {
    throw new Error("The image model completed without returning image bytes or a downloadable image URL.")
  }
  const response = await Network.fetch(
    url,
    { signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]) },
    { authorize, maxResponseBytes: MAX_IMAGE_BYTES, streamResponse: true },
  )
  if (!response.ok) throw new Error(`The generated image could not be downloaded (${response.status}).`)
  const mime = response.headers.get("content-type")?.split(";")[0]?.trim() ?? ""
  if (!/^image\/(?:png|jpeg|webp|gif)$/.test(mime)) {
    throw new Error(`The generated image URL returned an unsupported format (${mime || "unknown"}).`)
  }
  const bytes = await readBoundedImageResponse(response, MAX_IMAGE_BYTES)
  if (bytes.byteLength === 0) throw new Error("The image model returned an empty image.")
  return { mime, bytes }
}

export function generatedImageAttachments(input: {
  bytes: Buffer
  mime: string
  filepath: string
  sessionID: string
  messageID: string
}) {
  if (input.bytes.byteLength > MAX_IMAGE_ATTACHMENT_BYTES) return []
  return [
    {
      id: Identifier.ascending("part"),
      sessionID: input.sessionID,
      messageID: input.messageID,
      type: "file" as const,
      mime: input.mime,
      filename: path.basename(input.filepath),
      url: `data:${input.mime};base64,${input.bytes.toString("base64")}`,
    },
  ]
}

function requestError(status: number, body: OpenRouterImage | undefined, raw: string, managed: boolean) {
  const reported =
    typeof body?.error === "string"
      ? body.error
      : typeof body?.error?.message === "string"
        ? body.error.message
        : body?.message
  const detail = (reported?.trim() || raw.trim()).replace(/\s+/g, " ").slice(0, 500)
  if (status === 402 && managed) {
    return new Error(
      "Your Ace balance does not have enough credits for this Nano Banana request. Add credits at app.syntheticsciences.ai/billing, or connect OpenRouter in Settings → Models.",
    )
  }
  if (status === 402) {
    return new Error("Your connected OpenRouter account does not have enough credit for this image request.")
  }
  if (status === 401 || status === 403) {
    return new Error(
      managed
        ? "OpenScience could not authorize the wallet-backed image request. Reconnect your OpenScience account and retry."
        : "OpenRouter rejected the connected key. Reconnect it in Settings → Models and retry.",
    )
  }
  return new Error(`Nano Banana request failed (${status})${detail ? `: ${detail}` : "."}`)
}

export const GenerateImageTool = Tool.define("generate_image", {
  description:
    "Generate or edit an image with Nano Banana through the user's connected OpenRouter key, falling back to funded OpenScience wallet Credits when managed spend is enabled. Saves the image directly in the connected workspace.",
  parameters: z.object({
    prompt: z.string().trim().min(1).max(20_000).describe("Detailed description or editing instruction"),
    output_path: z
      .string()
      .trim()
      .min(1)
      .max(10_000)
      .default("generated-image.png")
      .describe("PNG, JPEG, or WebP destination in the connected workspace"),
    input_path: z
      .string()
      .trim()
      .min(1)
      .max(10_000)
      .optional()
      .describe("Optional existing image path for image editing"),
    model: z.string().trim().min(1).max(300).default(DEFAULT_MODEL).describe("OpenRouter image model ID"),
    aspect_ratio: z
      .enum(["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"])
      .optional()
      .describe("Requested output aspect ratio"),
  }),
  async execute(params, ctx) {
    const directory = await sessionToolDirectory(ctx)
    const requested = path.isAbsolute(params.output_path)
      ? params.output_path
      : path.join(directory, params.output_path)
    using outputAccess = await assertExternalDirectory(ctx, requested, { access: "write" })
    const output = outputAccess?.path ?? requested
    const extension = path.extname(output).toLowerCase()
    if (![".png", ".jpg", ".jpeg", ".webp"].includes(extension)) {
      throw new Error("output_path must end in .png, .jpg, .jpeg, or .webp")
    }
    const approved = await SafeFileIO.optional(output, { maxBytes: MAX_IMAGE_BYTES }).catch((error) => {
      if (error instanceof SafeFileIO.LimitError) {
        throw new Error("The existing output image exceeds the 30 MB safety limit; rename or remove it first.")
      }
      throw error
    })
    using inputAccess = params.input_path
      ? await assertExternalDirectory(
          ctx,
          path.isAbsolute(params.input_path) ? params.input_path : path.join(directory, params.input_path),
          { access: "read" },
        )
      : undefined
    const source = inputAccess?.path
    const sourceExtension = source ? path.extname(source).toLowerCase() : undefined
    if (sourceExtension && ![".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(sourceExtension)) {
      throw new Error("input_path must end in .png, .jpg, .jpeg, .webp, or .gif")
    }
    const input = source
      ? await SafeFileIO.read((await inputAccess?.revalidate()) ?? source, { maxBytes: MAX_IMAGE_BYTES }).catch(
          (error) => {
            if (error instanceof SafeFileIO.LimitError) {
              throw new Error("The input image exceeds the 30 MB safety limit.")
            }
            throw error
          },
        )
      : undefined
    const inputMime = source
      ? sourceExtension === ".webp"
        ? "image/webp"
        : sourceExtension === ".gif"
          ? "image/gif"
          : sourceExtension && [".jpg", ".jpeg"].includes(sourceExtension)
            ? "image/jpeg"
            : "image/png"
      : undefined

    const provider = await Provider.getProvider("openrouter").catch(() => undefined)
    const key = typeof provider?.options?.apiKey === "string" ? provider.options.apiKey : provider?.key
    const base =
      typeof provider?.options?.baseURL === "string" ? provider.options.baseURL.replace(/\/+$/, "") : undefined
    if (!provider || !key || !base) {
      throw new Error(
        "Nano Banana is unavailable. Connect OpenRouter in Settings → Models, or choose Credits there and sign in with a funded Ace balance.",
      )
    }

    // This tool calls fetch directly instead of going through Provider.getSDK(),
    // so enforce the same credential/host invariant here. The effective token,
    // not the spend-toggle label, determines whether this is a wallet request.
    // Otherwise a custom/stale base URL could receive the scoped thk_* token.
    const managed = OpenScience.isManagedKeyValue(key)
    const proxy = Provider.isAtlasProxyBaseURL(base)
    if (managed && !proxy) {
      throw new Error(
        "OpenScience refused to send the wallet credential outside its managed image proxy. Run openscience sync and retry.",
      )
    }
    if (!managed && proxy) {
      throw new Error(
        "OpenScience refused to send your connected OpenRouter key to the managed wallet proxy. Reconnect OpenRouter and retry.",
      )
    }
    if (managed) {
      const balance = await OpenScience.getBalance().catch(() => null)
      if (balance !== null && balance <= 0) {
        OpenScience.invalidateBalance()
        throw new Error(
          "Your Ace balance has no available credits for Nano Banana. Add credits at app.syntheticsciences.ai/billing, or connect OpenRouter in Settings → Models.",
        )
      }
    }

    await ctx.ask({
      permission: "generate_image",
      patterns: [params.model],
      always: ["*"],
      metadata: {
        model: params.model,
        output,
        input: source,
        route: managed ? "wallet" : "byok",
      },
    })
    await ctx.ask({
      permission: "edit",
      patterns: [path.relative(Instance.worktree, output)],
      always: ["*"],
      metadata: { filepath: output, generated: true },
    })

    const format = extension === ".jpg" ? "jpeg" : extension.slice(1)
    const headers = {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://syntheticsciences.ai",
      "X-Title": "OpenScience",
    }
    const request = async (endpoint: string, payload: Record<string, unknown>) => {
      const response = await fetch(`${base}/${endpoint}`, {
        method: "POST",
        signal: AbortSignal.any([ctx.abort, AbortSignal.timeout(120_000)]),
        headers,
        body: JSON.stringify(payload),
      })
      const raw = (
        await readBoundedImageResponse(response, response.ok ? MAX_IMAGE_RESPONSE_BYTES : MAX_IMAGE_ERROR_BYTES)
      ).toString("utf8")
      const body = (() => {
        try {
          return JSON.parse(raw) as OpenRouterImage
        } catch {
          return undefined
        }
      })()
      return { response, raw, body }
    }
    const direct = await request("images", {
      model: params.model,
      prompt: params.prompt,
      n: 1,
      output_format: format,
      ...(params.aspect_ratio ? { aspect_ratio: params.aspect_ratio } : {}),
      ...(input
        ? {
            input_references: [
              {
                type: "image_url",
                image_url: { url: `data:${inputMime};base64,${input.bytes.toString("base64")}` },
              },
            ],
          }
        : {}),
    })
    if (!direct.response.ok) throw requestError(direct.response.status, direct.body, direct.raw, managed)
    if (!direct.body) throw new Error("Nano Banana returned an unreadable response.")
    const approvedHosts = new Set<string>()
    const image = await materializeImage(direct.body, ctx.abort, async (input) => {
      if (approvedHosts.has(input.host)) return
      await ctx.ask({
        permission: "network",
        patterns: [input.host],
        always: [input.host],
        metadata: { url: input.url, network: { host: input.host } },
      })
      approvedHosts.add(input.host)
    })
    await AuthoritySignal.exclusive(async () => {
      const current = (await outputAccess?.revalidate()) ?? output
      if (current !== output) throw new Error("Image output authority changed before the write")
      await SafeFileIO.write(current, image.bytes, approved)
    })
    await Bus.publish(File.Event.Edited, { file: output })
    await Bus.publish(FileWatcher.Event.Updated, { file: output, event: approved ? "change" : "add" })

    const attachments = generatedImageAttachments({
      bytes: image.bytes,
      mime: image.mime,
      filepath: output,
      sessionID: ctx.sessionID,
      messageID: ctx.messageID,
    })
    return {
      title: path.relative(directory, output),
      output: `Generated ${path.basename(output)} with ${params.model} via ${managed ? "OpenScience wallet Credits" : "the connected OpenRouter key"}.`,
      metadata: {
        filepath: output,
        mime: image.mime,
        size: image.bytes.byteLength,
        model: params.model,
        route: managed ? "wallet" : "byok",
        attachment: attachments.length ? "inline" : "artifact_only",
        artifact: {
          kind: "image",
          title: path.basename(output),
          data: { path: output, mime: image.mime },
        },
      },
      attachments,
    }
  },
})

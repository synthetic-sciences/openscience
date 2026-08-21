import path from "node:path"
import z from "zod"
import { Tool } from "./tool"
import { Provider } from "@/provider/provider"
import { resolveCredentialSource, requiresWalletBalance } from "@/session/billing-gate"
import { OpenScience } from "@/openscience"
import { Instance } from "@/project/instance"
import { SafeFileIO } from "@/file/safe-io"
import { assertExternalDirectory, sessionToolDirectory } from "./external-directory"
import { Identifier } from "@/id/id"
import { Bus } from "@/bus"
import { File } from "@/file"
import { FileWatcher } from "@/file/watcher"

const MAX_IMAGE_BYTES = 30 * 1024 * 1024
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

export function extractGeneratedImage(value: OpenRouterImage) {
  const generated = value.data?.find((item) => typeof item.b64_json === "string" && item.b64_json.length > 0)
  if (generated?.b64_json) {
    const mime = generated.media_type ?? "image/png"
    if (!/^image\/(?:png|jpeg|webp|gif)$/.test(mime)) {
      throw new Error(`The image model returned an unsupported image format (${mime}).`)
    }
    const bytes = Buffer.from(generated.b64_json.replace(/\s/g, ""), "base64")
    if (bytes.byteLength === 0) throw new Error("The image model returned an empty image.")
    if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("The generated image exceeds the 30 MB safety limit.")
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
  const bytes = Buffer.from(match[2].replace(/\s/g, ""), "base64")
  if (bytes.byteLength === 0) throw new Error("The image model returned an empty image.")
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("The generated image exceeds the 30 MB safety limit.")
  return { mime: match[1], bytes }
}

export function extractGeneratedImageURL(value: OpenRouterImage) {
  return remoteImageURL(value)
}

async function materializeImage(value: OpenRouterImage, signal: AbortSignal) {
  try {
    return extractGeneratedImage(value)
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("without returning image bytes")) throw error
  }
  const url = extractGeneratedImageURL(value)
  if (!url) {
    throw new Error("The image model completed without returning image bytes or a downloadable image URL.")
  }
  const response = await fetch(url, { signal })
  if (!response.ok) throw new Error(`The generated image could not be downloaded (${response.status}).`)
  const length = Number(response.headers.get("content-length") ?? 0)
  if (Number.isFinite(length) && length > MAX_IMAGE_BYTES) {
    throw new Error("The generated image exceeds the 30 MB safety limit.")
  }
  const mime = response.headers.get("content-type")?.split(";")[0]?.trim() ?? ""
  if (!/^image\/(?:png|jpeg|webp|gif)$/.test(mime)) {
    throw new Error(`The generated image URL returned an unsupported format (${mime || "unknown"}).`)
  }
  const bytes = Buffer.from(await response.arrayBuffer())
  if (bytes.byteLength === 0) throw new Error("The image model returned an empty image.")
  if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error("The generated image exceeds the 30 MB safety limit.")
  return { mime, bytes }
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
      "Your OpenScience wallet does not have enough Credits for this Nano Banana request. Top up in Settings → Spend, or connect an OpenRouter key to use BYOK.",
    )
  }
  if (status === 402) {
    return new Error("Your connected OpenRouter account does not have enough credit for this image request.")
  }
  if (status === 401 || status === 403) {
    return new Error(
      managed
        ? "OpenScience could not authorize the wallet-backed image request. Reconnect your OpenScience account and retry."
        : "OpenRouter rejected the connected key. Reconnect it in Settings → Models & providers and retry.",
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
      .describe("PNG, JPEG, WebP, or GIF destination in the connected workspace"),
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
    const output = (await assertExternalDirectory(ctx, requested, { access: "write" }))?.path ?? requested
    const extension = path.extname(output).toLowerCase()
    if (![".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(extension)) {
      throw new Error("output_path must end in .png, .jpg, .jpeg, .webp, or .gif")
    }
    const approved = await SafeFileIO.optional(output)
    const source = params.input_path
      ? (
          await assertExternalDirectory(
            ctx,
            path.isAbsolute(params.input_path) ? params.input_path : path.join(directory, params.input_path),
            { access: "read" },
          )
        )?.path
      : undefined
    const input = source ? await SafeFileIO.read(source) : undefined
    const inputMime = source
      ? path.extname(source).toLowerCase() === ".webp"
        ? "image/webp"
        : [".jpg", ".jpeg"].includes(path.extname(source).toLowerCase())
          ? "image/jpeg"
          : "image/png"
      : undefined

    const provider = await Provider.getProvider("openrouter").catch(() => undefined)
    const key = typeof provider?.options?.apiKey === "string" ? provider.options.apiKey : provider?.key
    const base =
      typeof provider?.options?.baseURL === "string" ? provider.options.baseURL.replace(/\/+$/, "") : undefined
    if (!provider || !key || !base) {
      throw new Error(
        "Nano Banana is unavailable. Connect OpenRouter in Settings → Models & providers, or enable managed LLM spend and sign in to OpenScience so a funded wallet can be used.",
      )
    }

    const credential = await resolveCredentialSource("openrouter", params.model)
    const managed = requiresWalletBalance(credential)
    if (managed) {
      const balance = await OpenScience.getBalance().catch(() => null)
      if (balance !== null && balance <= 0) {
        OpenScience.invalidateBalance()
        throw new Error(
          "Your OpenScience wallet has no available Credits for Nano Banana. Top up in Settings → Spend, or connect an OpenRouter key to use BYOK.",
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
        signal: ctx.abort,
        headers,
        body: JSON.stringify(payload),
      })
      const raw = await response.text()
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
    const image = await materializeImage(direct.body, ctx.abort)
    await SafeFileIO.write(output, image.bytes, approved)
    await Bus.publish(File.Event.Edited, { file: output })
    await Bus.publish(FileWatcher.Event.Updated, { file: output, event: approved ? "change" : "add" })

    return {
      title: path.relative(directory, output),
      output: `Generated ${path.basename(output)} with ${params.model} via ${managed ? "OpenScience wallet Credits" : "the connected OpenRouter key"}.`,
      metadata: {
        filepath: output,
        mime: image.mime,
        size: image.bytes.byteLength,
        model: params.model,
        route: managed ? "wallet" : "byok",
        artifact: {
          kind: "image",
          title: path.basename(output),
          data: { path: output, mime: image.mime },
        },
      },
      attachments: [
        {
          id: Identifier.ascending("part"),
          sessionID: ctx.sessionID,
          messageID: ctx.messageID,
          type: "file" as const,
          mime: image.mime,
          filename: path.basename(output),
          url: `data:${image.mime};base64,${image.bytes.toString("base64")}`,
        },
      ],
    }
  },
})

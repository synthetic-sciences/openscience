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
import { Env } from "@/env"

const MAX_IMAGE_BYTES = 30 * 1024 * 1024
const MAX_IMAGE_RESPONSE_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 1024 * 1024
const MAX_IMAGE_ERROR_BYTES = 1024 * 1024
const MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024
const DEFAULT_MODEL = "google/gemini-3-pro-image"
const GEMINI_MODEL = "gemini-3-pro-image"
const GEMINI_ASPECT_RATIO = {
  "1:1": "ASPECT_RATIO_ONE_BY_ONE",
  "2:3": "ASPECT_RATIO_TWO_BY_THREE",
  "3:2": "ASPECT_RATIO_THREE_BY_TWO",
  "3:4": "ASPECT_RATIO_THREE_BY_FOUR",
  "4:3": "ASPECT_RATIO_FOUR_BY_THREE",
  "9:16": "ASPECT_RATIO_NINE_BY_SIXTEEN",
  "16:9": "ASPECT_RATIO_SIXTEEN_BY_NINE",
} as const

function normalizedInputPath(value: string | undefined) {
  if (!value) return
  const input = value.trim()
  // Some model providers compulsively fill optional file fields with a Unix
  // sink or the current directory. Neither can ever be an image, and both mean
  // "no source image" in a generation request. Treat them as omitted so a
  // brand-new image does not require a fake blank canvas.
  if (input === "." || input === "/dev/null" || (process.platform === "win32" && input.toUpperCase() === "NUL")) {
    return
  }
  return input
}

function normalizeInput(args: unknown) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return args
  const input = { ...(args as Record<string, unknown>) }
  if (typeof input.input_path === "string" && normalizedInputPath(input.input_path) === undefined) {
    delete input.input_path
  }
  return input
}

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
  candidates?: Array<{
    content?: {
      parts?: Array<{
        inlineData?: { data?: string; mimeType?: string }
        inline_data?: { data?: string; mime_type?: string }
      }>
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
  const part = value.candidates
    ?.flatMap((candidate) => candidate.content?.parts ?? [])
    .find((item) => {
      const data = item.inlineData?.data ?? item.inline_data?.data
      return typeof data === "string" && data.length > 0
    })
  const inline =
    part?.inlineData ??
    (part?.inline_data ? { data: part.inline_data.data, mimeType: part.inline_data.mime_type } : undefined)
  if (inline?.data) {
    const mime = inline.mimeType ?? "image/png"
    if (!/^image\/(?:png|jpeg|webp|gif)$/.test(mime)) {
      throw new Error(`The image model returned an unsupported image format (${mime}).`)
    }
    return { mime, bytes: decodeImage(inline.data) }
  }

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
    "Generate or edit an image with the pinned Gemini 3 Pro Image model. Uses the user's Gemini key first, then OpenRouter, then a funded workspace Wallet fallback. Saves the image directly in the connected workspace.",
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
      .describe(
        "Existing regular image file to edit. Omit this field entirely when generating a new image; never use a directory, '.', /dev/null, or a blank placeholder.",
      ),
    aspect_ratio: z
      .enum(["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16"])
      .optional()
      .describe("Requested output aspect ratio"),
  }),
  normalizeInput,
  async execute(params, ctx) {
    const directory = await sessionToolDirectory(ctx)
    const requested = path.isAbsolute(params.output_path)
      ? params.output_path
      : path.join(directory, params.output_path)
    const requestedExtension = path.extname(requested).toLowerCase()
    if (![".png", ".jpg", ".jpeg", ".webp"].includes(requestedExtension)) {
      throw new Error("output_path must end in .png, .jpg, .jpeg, or .webp")
    }
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
    const requestedInput = params.input_path
      ? path.isAbsolute(params.input_path)
        ? params.input_path
        : path.join(directory, params.input_path)
      : undefined
    const requestedInputExtension = requestedInput ? path.extname(requestedInput).toLowerCase() : undefined
    if (requestedInput && ![".png", ".jpg", ".jpeg", ".webp", ".gif"].includes(requestedInputExtension!)) {
      throw new Error(
        "input_path must be an existing .png, .jpg, .jpeg, .webp, or .gif image. Omit input_path when generating a new image.",
      )
    }
    using inputAccess = requestedInput
      ? await assertExternalDirectory(ctx, requestedInput, {
          access: "read",
        })
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
            if (error instanceof Error && error.message.startsWith("Only regular files can be accessed:")) {
              throw new Error(
                "input_path must be an existing image file. Omit input_path when generating a new image; directories and placeholder files are not valid image references.",
              )
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

    const google = await Provider.getProvider("google").catch(() => undefined)
    const openrouter = await Provider.getProvider("openrouter").catch(() => undefined)
    const googleKey = typeof google?.options?.apiKey === "string" ? google.options.apiKey : google?.key
    const openrouterKey = typeof openrouter?.options?.apiKey === "string" ? openrouter.options.apiKey : openrouter?.key
    const openrouterBase =
      typeof openrouter?.options?.baseURL === "string"
        ? openrouter.options.baseURL.replace(/\/+$/, "")
        : "https://openrouter.ai/api/v1"
    const ambient = (key: string, names: string[]) => names.some((name) => Env.get(name) === key)
    const candidates = [
      ...(googleKey && !OpenScience.isManagedKeyValue(googleKey)
        ? [
            {
              kind: "gemini" as const,
              key: googleKey,
              base:
                typeof google?.options?.baseURL === "string"
                  ? google.options.baseURL.replace(/\/+$/, "")
                  : "https://generativelanguage.googleapis.com/v1beta",
              label: "the connected Gemini key",
              rank: ambient(googleKey, ["GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY", "GEMINI_API_KEY"]) ? 1 : 2,
            },
          ]
        : []),
      ...(openrouterKey && !OpenScience.isManagedKeyValue(openrouterKey)
        ? [
            {
              kind: "openrouter" as const,
              key: openrouterKey,
              base: openrouterBase,
              label: "the connected OpenRouter key",
              rank: ambient(openrouterKey, ["OPENROUTER_API_KEY"]) ? 1 : 2,
            },
          ]
        : []),
      ...(openrouterKey && OpenScience.isManagedKeyValue(openrouterKey)
        ? [
            {
              kind: "managed" as const,
              key: openrouterKey,
              base: openrouterBase,
              label: "OpenScience wallet Credits",
              rank: ambient(openrouterKey, ["OPENROUTER_API_KEY"]) ? 1 : 2,
            },
          ]
        : []),
      ...(Env.get("OPENSCIENCE_IMAGE_API_KEY") && Env.get("OPENSCIENCE_IMAGE_BASE_URL")
        ? [
            {
              kind: "managed" as const,
              key: Env.get("OPENSCIENCE_IMAGE_API_KEY")!,
              base: Env.get("OPENSCIENCE_IMAGE_BASE_URL")!.replace(/\/+$/, ""),
              label: "OpenScience wallet Credits",
              rank: 0,
            },
          ]
        : []),
    ]
    const route = candidates.sort((a, b) => b.rank - a.rank)[0]
    if (!route) {
      throw new Error(
        "Nano Banana is unavailable. Connect Gemini or OpenRouter in Settings → Credentials, or sign in to use a funded workspace Wallet.",
      )
    }
    if (route.kind === "gemini" && extension !== ".png") {
      throw new Error("Gemini image generation returns PNG. Use an output_path ending in .png.")
    }

    const managed = route.kind === "managed"
    if (managed && (!OpenScience.isManagedKeyValue(route.key) || !Provider.isAtlasProxyBaseURL(route.base))) {
      throw new Error(
        "OpenScience refused to send the wallet credential outside its managed image proxy. Run openscience sync and retry.",
      )
    }
    if (!managed && Provider.isAtlasProxyBaseURL(route.base)) {
      throw new Error(
        "OpenScience refused to send your connected provider key to the managed wallet proxy. Reconnect the credential and retry.",
      )
    }
    const funding = managed ? await OpenScience.managedRequestSnapshot(route.key) : undefined
    if (managed) {
      const balance = await OpenScience.getBalance(funding).catch(() => null)
      if (balance !== null && balance <= 0) {
        OpenScience.invalidateBalance()
        throw new Error(
          "Your Ace balance has no available credits for Nano Banana. Add credits at app.syntheticsciences.ai/billing, or connect OpenRouter in Settings → Models.",
        )
      }
    }

    await ctx.ask({
      permission: "generate_image",
      patterns: [DEFAULT_MODEL],
      always: ["*"],
      metadata: {
        model: DEFAULT_MODEL,
        output,
        input: source,
        route: route.kind,
      },
    })
    await ctx.ask({
      permission: "edit",
      patterns: [path.relative(Instance.worktree, output)],
      always: ["*"],
      metadata: { filepath: output, generated: true },
    })

    const format = extension === ".jpg" ? "jpeg" : extension.slice(1)
    const headers =
      route.kind === "gemini"
        ? { "x-goog-api-key": route.key, "Content-Type": "application/json" }
        : {
            Authorization: `Bearer ${route.key}`,
            "Content-Type": "application/json",
            "HTTP-Referer": "https://syntheticsciences.ai",
            "X-Title": "OpenScience",
            ...(funding ? OpenScience.fundingHeaders(funding) : {}),
          }
    const request = async (url: string, payload: Record<string, unknown>) => {
      const text = JSON.stringify(payload)
      const idempotency = managed
        ? Provider.managedIdempotencyKey({
            endpoint: url,
            body: text,
            sessionID: ctx.sessionID,
            messageID: ctx.messageID,
            operation: "generate-image",
          })
        : undefined
      const requestHeaders = new Headers()
      for (const [name, value] of Object.entries(headers)) {
        if (value) requestHeaders.set(name, value)
      }
      if (idempotency) requestHeaders.set("Idempotency-Key", idempotency)
      const response = await fetch(url, {
        method: "POST",
        signal: AbortSignal.any([ctx.abort, AbortSignal.timeout(120_000)]),
        headers: requestHeaders,
        body: text,
      })
      if (funding) await OpenScience.validateFundingResponse(response, funding)
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
    const direct =
      route.kind === "gemini"
        ? await request(`${route.base}/models/${GEMINI_MODEL}:generateContent`, {
            contents: [
              {
                role: "user",
                parts: [
                  { text: params.prompt },
                  ...(input ? [{ inlineData: { mimeType: inputMime, data: input.bytes.toString("base64") } }] : []),
                ],
              },
            ],
            generationConfig: {
              responseModalities: ["IMAGE"],
              ...(params.aspect_ratio
                ? { responseFormat: { image: { aspectRatio: GEMINI_ASPECT_RATIO[params.aspect_ratio] } } }
                : {}),
            },
          })
        : await request(`${route.base}/images`, {
            model: DEFAULT_MODEL,
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
    if (managed) OpenScience.invalidateBalance()

    const attachments = generatedImageAttachments({
      bytes: image.bytes,
      mime: image.mime,
      filepath: output,
      sessionID: ctx.sessionID,
      messageID: ctx.messageID,
    })
    return {
      title: path.relative(directory, output),
      output: `Generated ${path.basename(output)} with ${DEFAULT_MODEL} via ${route.label}.`,
      metadata: {
        filepath: output,
        mime: image.mime,
        size: image.bytes.byteLength,
        model: DEFAULT_MODEL,
        route: route.kind,
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

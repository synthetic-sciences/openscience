import path from "node:path"
import z from "zod"
import { Tool } from "./tool"
import { Instance } from "@/project/instance"
import { SafeFileIO } from "@/file/safe-io"
import { assertExternalDirectory, sessionToolDirectory } from "./external-directory"
import { AuthoritySignal } from "@/project/authority-signal"
import { Identifier } from "@/id/id"
import { Bus } from "@/bus"
import { File } from "@/file"
import { FileWatcher } from "@/file/watcher"
import { Network } from "@/settings/network"
import { ImageRoute } from "./image-route"
import { OpenScience } from "@/openscience"

/** What one image render can cost on Ace at the largest size, in cents: the
 * floor below which a render is refused before it is requested. */
const RENDER_FLOOR_CENTS = 50
const MAX_IMAGE_BYTES = 30 * 1024 * 1024
const MAX_IMAGE_RESPONSE_BYTES = Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 1024 * 1024
const MAX_IMAGE_ERROR_BYTES = 1024 * 1024
const MAX_IMAGE_ATTACHMENT_BYTES = 8 * 1024 * 1024
const IMAGE_EXTENSIONS = [".png", ".jpg", ".jpeg", ".webp", ".gif"]
/** Nano Banana Pro accepts up to 14 reference images per request. */
const MAX_REFERENCES = 14

/** GPT Image 2 takes any size whose edges are multiples of 16 within a 3:1
 * ratio and 655,360–8,294,400 pixels; these are the requested aspect ratios
 * at the working (1K) and print (2K) scales, and the true 4K frame where the
 * pixel ceiling allows one. */
const OPENAI_SIZES: Record<string, { "1K": string; "2K": string; "4K": string }> = {
  "1:1": { "1K": "1024x1024", "2K": "2048x2048", "4K": "2048x2048" },
  "3:2": { "1K": "1536x1024", "2K": "3072x2048", "4K": "3072x2048" },
  "2:3": { "1K": "1024x1536", "2K": "2048x3072", "4K": "2048x3072" },
  "4:3": { "1K": "1408x1056", "2K": "2816x2112", "4K": "2816x2112" },
  "3:4": { "1K": "1056x1408", "2K": "2112x2816", "4K": "2112x2816" },
  "16:9": { "1K": "1536x864", "2K": "3072x1728", "4K": "3840x2160" },
  "9:16": { "1K": "864x1536", "2K": "1728x3072", "4K": "2160x3840" },
  "21:9": { "1K": "1792x768", "2K": "3584x1536", "4K": "3584x1536" },
}

function mimeOf(extension: string | undefined) {
  if (extension === ".webp") return "image/webp"
  if (extension === ".gif") return "image/gif"
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg"
  return "image/png"
}

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
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    throw new Error(`The generated image could not be downloaded (${response.status}).`)
  }
  const mime = response.headers.get("content-type")?.split(";")[0]?.trim() ?? ""
  if (!/^image\/(?:png|jpeg|webp|gif)$/.test(mime)) {
    await response.body?.cancel().catch(() => {})
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

/**
 * The framing every scientific diagram is rendered under. Adapted from
 * K-Dense Inc.'s scientific-schematics skill (MIT), whose renders read as
 * paper figures because the model is told the publication standards on every
 * call rather than left to infer them from the description.
 */
export const SCHEMATIC_GUIDELINES = `Create a publication-quality scientific diagram with these requirements.

VISUAL QUALITY:
- Clean white background (no textures, gradients, shadows or 3D effects)
- High contrast for readability and printing
- Sharp, clear lines and text; flat shapes with consistent line weight
- Adequate spacing between elements to prevent crowding

TYPOGRAPHY:
- One clear sans-serif font (Arial or Helvetica style) throughout
- Every label large enough to read at the printed column width; consistent sizes
- All text horizontal, spelled exactly as given, with no overlapping text
- Sentence case; units in parentheses where applicable

SCIENTIFIC STANDARDS:
- Show exactly the components and connections described, with the labels given verbatim
- Do not invent components, numbers, tables, citations or filler labels
- Use standard scientific notation and symbols; scale bars, legends or axes only where the description asks

ACCESSIBILITY:
- Colorblind-safe palette (Okabe-Ito) with one accent colour for the emphasised element and grey for context
- Redundant encoding (shape and colour, not colour alone); must still read in grayscale

LAYOUT:
- One reading direction as described (left-to-right or top-to-bottom), clear visual hierarchy
- Balanced composition with purposeful whitespace; no decorative icons, illustrations or clutter
- Arrows connect exactly the elements named, in the direction named, none duplicated

DO NOT ADD FIGURE NUMBERS OR CAPTIONS:
- No "Figure 1", "Fig. 1", title banner or caption text inside the image; the document adds those
- The image contains only the diagram itself`

/** The framing for a conceptual illustration or graphical abstract: a
 * scientific illustration, not a diagram with boxes and arrows, and not
 * marketing art. */
export const ILLUSTRATION_GUIDELINES = `Create a scientific illustration for a research publication with these requirements.

- Clean white or very light background, flat or lightly shaded rendering, no photographic clutter
- Restrained palette (two or three colours plus greys), high contrast, works in grayscale
- Compose for the stated aspect ratio with purposeful whitespace; leave room for a caption if asked
- Any text spelled exactly as given; otherwise no text, labels, watermarks, logos or figure numbers
- Depict only what the description states; do not imply data, results or mechanisms it does not mention`

export const PURPOSES = ["schematic", "illustration", "edit"] as const
export type Purpose = (typeof PURPOSES)[number]

/** The prompt actually sent: the purpose's framing, then the request. An edit
 * carries the request alone so the instruction stays about the change. */
export function framedPrompt(prompt: string, purpose: Purpose | undefined) {
  if (purpose === "schematic") return `${SCHEMATIC_GUIDELINES}\n\nDIAGRAM REQUEST:\n${prompt}`
  if (purpose === "illustration") return `${ILLUSTRATION_GUIDELINES}\n\nREQUEST:\n${prompt}`
  return prompt
}

/** Statuses an upstream image service returns while it is briefly unable
 * to answer; one retry after a short pause usually succeeds. */
export const TRANSIENT_IMAGE_STATUSES = new Set([502, 503, 504, 529])

function requestError(route: ImageRoute.Route, status: number, body: OpenRouterImage | undefined, raw: string) {
  const reported =
    typeof body?.error === "string"
      ? body.error
      : typeof body?.error?.message === "string"
        ? body.error.message
        : body?.message
  // A gateway's HTML error page is not a message for anyone; keep its title at most.
  const html = /^\s*<(?:!doctype|html)/i.test(raw)
  const detail = (reported?.trim() || (html ? (raw.match(/<title>([^<]*)<\/title>/i)?.[1] ?? "").trim() : raw.trim()))
    .replace(/\s+/g, " ")
    .slice(0, 500)
  if (TRANSIENT_IMAGE_STATUSES.has(status)) {
    const where = route.kind === "ace" ? "Ace's image service" : route.label
    return new Error(
      `${where} did not answer (HTTP ${status}${detail ? `, ${detail}` : ""}) and one retry also failed. ` +
        `This is a transient outage on the provider side; try again in a minute, or continue with a placeholder for now.`,
    )
  }
  if (status === 402) {
    if (route.kind === "ace")
      return new Error(
        "Your Ace Wallet does not have enough balance for this image. Add funds in Customize → Billing and retry.",
      )
    return new Error(`The account behind ${route.label} has no credit left for this image request.`)
  }
  if (status === 401 || status === 403) {
    if (route.kind === "ace")
      return new Error("Ace rejected the request. Sign in again in Customize → Billing and retry.")
    return new Error(`The provider rejected ${route.label}. Reconnect it in Customize → Models and retry.`)
  }
  return new Error(`Image generation with ${route.model} failed (${status})${detail ? `: ${detail}` : "."}`)
}

export const GenerateImageTool = Tool.define("generate_image", {
  description:
    "Generate or edit an image with Nano Banana Pro (Gemini 3 Pro Image) through Ace or the user's own Gemini key, or with GPT Image 2 through the user's own OpenAI key. Saves the image directly in the connected workspace.",
  parameters: z.object({
    prompt: z.string().trim().min(1).max(20_000).describe("Detailed description or editing instruction"),
    purpose: z
      .enum(PURPOSES)
      .optional()
      .describe(
        "schematic: a method, pipeline, architecture or pathway diagram (publication framing is prepended: white background, sans-serif labels, Okabe-Ito palette, one reading direction, no figure numbers). illustration: a conceptual figure or graphical abstract. edit: change an existing image (input_path) as instructed. Omit for anything else.",
      ),
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
      .enum(["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9"])
      .optional()
      .describe("Requested output aspect ratio"),
    image_size: z
      .enum(["1K", "2K", "4K"])
      .optional()
      .describe("Output resolution. 2K for figures that will be printed; 1K (default) while iterating."),
    reference_paths: z
      .array(z.string().trim().min(1).max(10_000))
      .max(MAX_REFERENCES)
      .optional()
      .describe(
        "Existing image files whose style or components the result should follow (published figures, earlier drafts). Up to 14. Distinct from input_path, which is the image being edited.",
      ),
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
    const inputMime = source ? mimeOf(sourceExtension) : undefined
    const references: Array<{ mime: string; data: string }> = []
    for (const reference of params.reference_paths ?? []) {
      const requestedReference = path.isAbsolute(reference) ? reference : path.join(directory, reference)
      const referenceExtension = path.extname(requestedReference).toLowerCase()
      if (!IMAGE_EXTENSIONS.includes(referenceExtension)) {
        throw new Error(`reference_paths must name existing image files; ${reference} is not one.`)
      }
      using referenceAccess = await assertExternalDirectory(ctx, requestedReference, { access: "read" })
      const resolved = referenceAccess?.path ?? requestedReference
      const bytes = await SafeFileIO.read((await referenceAccess?.revalidate()) ?? resolved, {
        maxBytes: MAX_IMAGE_BYTES,
      }).catch((error) => {
        if (error instanceof SafeFileIO.LimitError)
          throw new Error(`Reference image ${reference} exceeds the 30 MB safety limit.`)
        if (error instanceof Error && error.message.startsWith("Only regular files can be accessed:")) {
          throw new Error(`reference_paths must name existing image files; ${reference} is not one.`)
        }
        throw error
      })
      references.push({ mime: mimeOf(referenceExtension), data: bytes.bytes.toString("base64") })
    }

    const route = await ImageRoute.resolve()
    if (!route) throw new Error(ImageRoute.UNAVAILABLE)
    if (route.kind === "gemini" && extension !== ".png") {
      throw new Error("Gemini image generation returns PNG. Use an output_path ending in .png.")
    }
    // Every image sent along: the one being edited first, then the style
    // references. Ace's managed envelope accepts one per request.
    const sources = [
      ...(input && inputMime ? [{ mime: inputMime, data: input.bytes.toString("base64") }] : []),
      ...references,
    ]
    if (route.kind === "ace" && sources.length > 1) {
      throw new Error(
        "Ace accepts one reference image per request: pass either input_path or a single reference_paths entry, or connect your own Gemini key for up to 14 references.",
      )
    }

    // A render on Ace is paid from the Wallet. Three schematics once ran
    // their 1K drafts and then failed at their 2K finals as the balance ran
    // out mid-workflow; the check happens before the request, and the
    // balance travels with the result so the next render can be planned.
    const wallet =
      route.kind === "ace"
        ? await OpenScience.getCredits(undefined, { lifetimeSpent: false, timeoutMs: 4_000 }).catch(() => null)
        : null
    const available = wallet?.availableCents ?? wallet?.spendableBalanceCents
    if (route.kind === "ace" && available !== undefined && available !== null && available < RENDER_FLOOR_CENTS) {
      throw new Error(
        `Your Ace Wallet has $${(available / 100).toFixed(2)} available, below the $${(RENDER_FLOOR_CENTS / 100).toFixed(2)} an image render can cost. Nothing was generated. Add funds in Customize → Ace and retry, or connect your own Gemini or OpenAI key for image generation.`,
      )
    }

    await ctx.ask({
      permission: "generate_image",
      patterns: [route.model],
      always: ["*"],
      metadata: {
        model: route.model,
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
    const authorization =
      route.kind === "gemini"
        ? { "x-goog-api-key": route.key }
        : {
            Authorization: `Bearer ${route.key}`,
            ...(route.kind === "ace"
              ? { "HTTP-Referer": "https://github.com/synthetic-sciences/OpenScience", "X-Title": "OpenScience" }
              : {}),
          }
    const request = async (url: string, payload: Record<string, unknown> | FormData) => {
      const requestHeaders = new Headers()
      for (const [name, value] of Object.entries(authorization)) {
        if (value) requestHeaders.set(name, value)
      }
      const body = payload instanceof FormData ? payload : JSON.stringify(payload)
      if (!(payload instanceof FormData)) requestHeaders.set("Content-Type", "application/json")
      const response = await fetch(url, {
        method: "POST",
        signal: AbortSignal.any([ctx.abort, AbortSignal.timeout(180_000)]),
        headers: requestHeaders,
        body,
      })
      const raw = (
        await readBoundedImageResponse(response, response.ok ? MAX_IMAGE_RESPONSE_BYTES : MAX_IMAGE_ERROR_BYTES)
      ).toString("utf8")
      const parsed = (() => {
        try {
          return JSON.parse(raw) as OpenRouterImage
        } catch {
          return undefined
        }
      })()
      return { response, raw, body: parsed }
    }
    const size = params.image_size ?? "1K"
    // An edit of a supplied image keeps the instruction bare; a new schematic
    // or illustration is framed by its purpose's publication standards.
    const purpose = params.purpose ?? (input ? "edit" : undefined)
    const prompt = framedPrompt(params.prompt, purpose)
    const attempt = async () => {
      if (route.kind === "gemini")
        return request(`${route.base}/models/${route.model}:generateContent`, {
          contents: [
            {
              role: "user",
              parts: [
                { text: prompt },
                ...sources.map((item) => ({ inlineData: { mimeType: item.mime, data: item.data } })),
              ],
            },
          ],
          generationConfig: {
            responseModalities: ["IMAGE"],
            ...(params.aspect_ratio || params.image_size
              ? {
                  imageConfig: {
                    ...(params.aspect_ratio ? { aspectRatio: params.aspect_ratio } : {}),
                    ...(params.image_size ? { imageSize: params.image_size } : {}),
                  },
                }
              : {}),
          },
        })
      if (route.kind === "openai") {
        const frame = OPENAI_SIZES[params.aspect_ratio ?? "1:1"]?.[size] ?? "1024x1024"
        const quality = size === "1K" ? "medium" : "high"
        if (!sources.length)
          return request(`${route.base}/images/generations`, {
            model: route.model,
            prompt,
            n: 1,
            size: frame,
            quality,
            output_format: format,
          })
        // Edits and reference-guided generations take the images as files.
        const form = new FormData()
        form.set("model", route.model)
        form.set("prompt", prompt)
        form.set("n", "1")
        form.set("size", frame)
        form.set("quality", quality)
        form.set("output_format", format)
        sources.forEach((item, index) => {
          form.append(
            "image[]",
            new Blob([Buffer.from(item.data, "base64")], { type: item.mime }),
            `reference-${index + 1}.${item.mime === "image/jpeg" ? "jpg" : item.mime.slice("image/".length)}`,
          )
        })
        return request(`${route.base}/images/edits`, form)
      }
      return request(`${route.base}/images`, {
        model: route.model,
        prompt,
        n: 1,
        output_format: format,
        ...(params.aspect_ratio ? { aspect_ratio: params.aspect_ratio } : {}),
        ...(params.image_size ? { resolution: params.image_size } : {}),
        ...(sources.length
          ? {
              input_references: sources.map((item) => ({
                type: "image_url",
                image_url: { url: `data:${item.mime};base64,${item.data}` },
              })),
            }
          : {}),
      })
    }
    // The image gateways sit behind proxies that occasionally answer 502/503
    // while a backend restarts; one retry after two seconds turns most of
    // those into a normal result instead of a failed figure.
    const first = await attempt()
    const direct =
      !first.response.ok && TRANSIENT_IMAGE_STATUSES.has(first.response.status) && !ctx.abort.aborted
        ? await Bun.sleep(2_000).then(attempt)
        : first
    if (!direct.response.ok) throw requestError(route, direct.response.status, direct.body, direct.raw)
    if (!direct.body) throw new Error(`${route.model} returned an unreadable response.`)
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
    // The receipt names the file where the reader will look for it: relative
    // to the project when it was written there, to the session directory
    // otherwise, never as a climb out of the session scratch.
    const shown = [Instance.worktree, directory]
      .map((root) => path.relative(root, output))
      .find((rel) => rel && !rel.startsWith(".."))
    const after =
      route.kind === "ace"
        ? await OpenScience.getCredits(undefined, { lifetimeSpent: false, timeoutMs: 4_000 }).catch(() => null)
        : null
    const left = after?.availableCents ?? after?.spendableBalanceCents
    return {
      title: shown ?? path.basename(output),
      output: `Generated ${path.basename(output)} with ${route.model} via ${route.label}.${
        left !== undefined && left !== null
          ? ` Wallet available after this render: $${(left / 100).toFixed(2)}${
              left < 3 * RENDER_FLOOR_CENTS ? " (plan remaining renders against this before starting them)" : ""
            }.`
          : ""
      }`,
      metadata: {
        filepath: output,
        mime: image.mime,
        size: image.bytes.byteLength,
        model: route.model,
        route: route.kind,
        ...(purpose ? { purpose } : {}),
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

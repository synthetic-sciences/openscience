import type { APICallError, ModelMessage } from "ai"
import { mergeDeep, unique } from "remeda"
import type { JSONSchema } from "zod/v4/core"
import type { Provider } from "./provider"
import type { ModelsDev } from "./models"
import { iife } from "@/util/iife"

type Modality = NonNullable<ModelsDev.Model["modalities"]>["input"][number]

function mimeToModality(mime: string): Modality | undefined {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
  return undefined
}

export namespace ProviderTransform {
  // Maps npm package to the key the AI SDK expects for providerOptions
  function sdkKey(npm: string): string | undefined {
    switch (npm) {
      case "@ai-sdk/github-copilot":
      case "@ai-sdk/openai":
      case "@ai-sdk/azure":
        return "openai"
      case "@ai-sdk/amazon-bedrock":
        return "bedrock"
      case "@ai-sdk/anthropic":
      case "@ai-sdk/google-vertex/anthropic":
        return "anthropic"
      case "@ai-sdk/google-vertex":
      case "@ai-sdk/google":
        return "google"
      case "@ai-sdk/gateway":
        return "gateway"
      case "@openrouter/ai-sdk-provider":
        return "openrouter"
    }
    return undefined
  }

  function normalizeMessages(
    msgs: ModelMessage[],
    model: Provider.Model,
    options: Record<string, unknown>,
  ): ModelMessage[] {
    // Anthropic rejects messages with empty content - filter out empty string messages
    // and remove empty text/reasoning parts from array content
    if (model.api.npm === "@ai-sdk/anthropic") {
      msgs = msgs
        .map((msg) => {
          if (typeof msg.content === "string") {
            if (msg.content === "") return undefined
            return msg
          }
          if (!Array.isArray(msg.content)) return msg
          const filtered = msg.content.filter((part) => {
            if (part.type === "text" || part.type === "reasoning") {
              return part.text !== ""
            }
            return true
          })
          if (filtered.length === 0) return undefined
          return { ...msg, content: filtered }
        })
        .filter((msg): msg is ModelMessage => msg !== undefined && msg.content !== "")
    }

    if (model.api.id.includes("claude")) {
      return msgs.map((msg) => {
        if ((msg.role === "assistant" || msg.role === "tool") && Array.isArray(msg.content)) {
          msg.content = msg.content.map((part) => {
            if ((part.type === "tool-call" || part.type === "tool-result") && "toolCallId" in part) {
              return {
                ...part,
                toolCallId: part.toolCallId.replace(/[^a-zA-Z0-9_-]/g, "_"),
              }
            }
            return part
          })
        }
        return msg
      })
    }
    if (model.providerID === "mistral" || model.api.id.toLowerCase().includes("mistral")) {
      const result: ModelMessage[] = []
      for (let i = 0; i < msgs.length; i++) {
        const msg = msgs[i]
        const nextMsg = msgs[i + 1]

        if ((msg.role === "assistant" || msg.role === "tool") && Array.isArray(msg.content)) {
          msg.content = msg.content.map((part) => {
            if ((part.type === "tool-call" || part.type === "tool-result") && "toolCallId" in part) {
              // Mistral requires alphanumeric tool call IDs with exactly 9 characters
              const normalizedId = part.toolCallId
                .replace(/[^a-zA-Z0-9]/g, "") // Remove non-alphanumeric characters
                .substring(0, 9) // Take first 9 characters
                .padEnd(9, "0") // Pad with zeros if less than 9 characters

              return {
                ...part,
                toolCallId: normalizedId,
              }
            }
            return part
          })
        }

        result.push(msg)

        // Fix message sequence: tool messages cannot be followed by user messages
        if (msg.role === "tool" && nextMsg?.role === "user") {
          result.push({
            role: "assistant",
            content: [
              {
                type: "text",
                text: "Done.",
              },
            ],
          })
        }
      }
      return result
    }

    if (typeof model.capabilities.interleaved === "object" && model.capabilities.interleaved.field) {
      const field = model.capabilities.interleaved.field
      return msgs.map((msg) => {
        if (msg.role === "assistant" && Array.isArray(msg.content)) {
          const reasoningParts = msg.content.filter((part: any) => part.type === "reasoning")
          const reasoningText = reasoningParts.map((part: any) => part.text).join("")

          // Filter out reasoning parts from content
          const filteredContent = msg.content.filter((part: any) => part.type !== "reasoning")

          // Include reasoning_content | reasoning_details directly on the message for all assistant messages
          if (reasoningText) {
            return {
              ...msg,
              content: filteredContent,
              providerOptions: {
                ...msg.providerOptions,
                openaiCompatible: {
                  ...(msg.providerOptions as any)?.openaiCompatible,
                  [field]: reasoningText,
                },
              },
            }
          }

          return {
            ...msg,
            content: filteredContent,
          }
        }

        return msg
      })
    }

    return msgs
  }

  function applyCaching(msgs: ModelMessage[], providerID: string): ModelMessage[] {
    const system = msgs.filter((msg) => msg.role === "system").slice(0, 2)
    const final = msgs.filter((msg) => msg.role !== "system").slice(-2)

    const providerOptions = {
      anthropic: {
        cacheControl: { type: "ephemeral" },
      },
      openrouter: {
        cacheControl: { type: "ephemeral" },
      },
      bedrock: {
        cachePoint: { type: "ephemeral" },
      },
      openaiCompatible: {
        cache_control: { type: "ephemeral" },
      },
    }

    for (const msg of unique([...system, ...final])) {
      const shouldUseContentOptions = providerID !== "anthropic" && Array.isArray(msg.content) && msg.content.length > 0

      if (shouldUseContentOptions) {
        const lastContent = msg.content[msg.content.length - 1]
        if (lastContent && typeof lastContent === "object") {
          lastContent.providerOptions = mergeDeep(lastContent.providerOptions ?? {}, providerOptions)
          continue
        }
      }

      msg.providerOptions = mergeDeep(msg.providerOptions ?? {}, providerOptions)
    }

    return msgs
  }

  // Pull raw bytes out of a file/media part's data, whatever shape it arrives
  // in (data URL, raw base64, Uint8Array/ArrayBuffer). Returns null for things
  // we can't read inline (e.g. an http URL).
  function partBytes(data: unknown): Uint8Array | null {
    if (data instanceof Uint8Array) return data
    if (data instanceof ArrayBuffer) return new Uint8Array(data)
    if (typeof data === "string") {
      if (/^https?:\/\//i.test(data)) return null
      const b64 = data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data
      try {
        return new Uint8Array(Buffer.from(b64, "base64"))
      } catch {
        return null
      }
    }
    return null
  }

  // Decode bytes as UTF-8, or null if they aren't valid text (binary).
  function asText(bytes: Uint8Array): string | null {
    if (bytes.includes(0)) return null
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
    } catch {
      return null
    }
  }

  // A file the model can't ingest as a known modality (e.g. .pem/x509, source
  // code, config, application/octet-stream). Sending it through as a file part
  // throws "AI_UnsupportedFunctionalityError: ... media type not supported" on
  // most providers — which poisons the whole send. Inline the content as text
  // when it's decodable; otherwise leave a short note so the model can proceed.
  const INLINE_LIMIT = 64_000
  function fileToText(part: any): { type: "text"; text: string } {
    const name = part.filename ? `"${part.filename}"` : "file"
    const mime = part.mediaType ?? "application/octet-stream"
    const bytes = partBytes(part.data ?? part.url)
    const text = bytes ? asText(bytes) : null
    if (text !== null) {
      const body =
        text.length > INLINE_LIMIT ? text.slice(0, INLINE_LIMIT) + `\n…[truncated; ${text.length} chars total]` : text
      return { type: "text", text: `Attached file ${name} (${mime}):\n\n${body}` }
    }
    return {
      type: "text",
      text: `[Attached file ${name} (${mime}) is binary and can't be shown inline. If its contents are needed, ask the user to paste them or read it from .context/.]`,
    }
  }

  function unsupportedParts(msgs: ModelMessage[], model: Provider.Model): ModelMessage[] {
    return msgs.map((msg) => {
      if (msg.role !== "user" || !Array.isArray(msg.content)) return msg

      const filtered = msg.content.map((part) => {
        if (part.type !== "file" && part.type !== "image") return part

        // Check for empty base64 image data
        if (part.type === "image") {
          const imageStr = part.image.toString()
          if (imageStr.startsWith("data:")) {
            const match = imageStr.match(/^data:([^;]+);base64,(.*)$/)
            if (match && (!match[2] || match[2].length === 0)) {
              return {
                type: "text" as const,
                text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
              }
            }
          }
        }

        const mime = part.type === "image" ? part.image.toString().split(";")[0].replace("data:", "") : part.mediaType
        const filename = part.type === "file" ? part.filename : undefined
        const modality = mimeToModality(mime)
        if (!modality) {
          // No modality → the provider can't take this as a file part. For
          // files, downgrade to text instead of crashing the request. (Images
          // always map to a modality, so this only catches file parts.)
          if (part.type === "file") return fileToText(part)
          return part
        }
        if (model.capabilities.input[modality]) return part

        const name = filename ? `"${filename}"` : modality
        return {
          type: "text" as const,
          text: `ERROR: Cannot read ${name} (this model does not support ${modality} input). Inform the user.`,
        }
      })

      return { ...msg, content: filtered }
    })
  }

  // Safety net: correct all image mime types from magic bytes before sending to any provider.
  // Prevents "Image does not match the provided media type" errors that poison the entire conversation.
  function correctImageMimes(msgs: ModelMessage[]): ModelMessage[] {
    return msgs.map((msg): ModelMessage => {
      if (!Array.isArray(msg.content)) return msg
      let changed = false
      const content = (msg.content as any[]).map((part: any) => {
        if (part.type !== "file" && part.type !== "image") return part
        const mime: string | undefined = part.mediaType ?? part.mimeType
        if (!mime?.startsWith("image/")) return part
        // Extract base64 from data URL or raw data
        const data: unknown = part.data ?? part.image
        if (!data) return part
        const str = typeof data === "string" ? data : data instanceof URL ? data.toString() : ""
        if (!str) return part
        const b64 = str.includes(",") ? str.slice(str.indexOf(",") + 1) : str
        if (b64.length < 16) return part
        try {
          const raw = atob(b64.slice(0, 24))
          let detected: string | undefined
          if (raw.charCodeAt(0) === 0x89 && raw.slice(1, 4) === "PNG") detected = "image/png"
          else if (raw.charCodeAt(0) === 0xff && raw.charCodeAt(1) === 0xd8) detected = "image/jpeg"
          else if (raw.length >= 12 && raw.slice(8, 12) === "WEBP") detected = "image/webp"
          else if (raw.slice(0, 3) === "GIF") detected = "image/gif"
          if (detected && detected !== mime) {
            changed = true
            const newPart = { ...part, mediaType: detected }
            // Fix data URL prefix if present
            if (typeof newPart.data === "string" && newPart.data.startsWith("data:"))
              newPart.data = `data:${detected};base64,${b64}`
            if (typeof newPart.image === "string" && newPart.image.startsWith("data:"))
              newPart.image = `data:${detected};base64,${b64}`
            if (newPart.image instanceof URL && newPart.image.toString().startsWith("data:"))
              newPart.image = new URL(`data:${detected};base64,${b64}`)
            return newPart
          }
        } catch {}
        return part
      })
      return changed ? ({ ...msg, content } as ModelMessage) : msg
    })
  }

  export function message(msgs: ModelMessage[], model: Provider.Model, options: Record<string, unknown>) {
    msgs = unsupportedParts(msgs, model)
    msgs = normalizeMessages(msgs, model, options)
    msgs = correctImageMimes(msgs)
    if (
      model.providerID === "anthropic" ||
      model.api.id.includes("anthropic") ||
      model.api.id.includes("claude") ||
      model.id.includes("anthropic") ||
      model.id.includes("claude") ||
      model.api.npm === "@ai-sdk/anthropic"
    ) {
      msgs = applyCaching(msgs, model.providerID)
    }

    // Remap providerOptions keys from stored providerID to expected SDK key
    const key = sdkKey(model.api.npm)
    if (key && key !== model.providerID && model.api.npm !== "@ai-sdk/azure") {
      const remap = (opts: Record<string, any> | undefined) => {
        if (!opts) return opts
        if (!(model.providerID in opts)) return opts
        const result = { ...opts }
        result[key] = result[model.providerID]
        delete result[model.providerID]
        return result
      }

      msgs = msgs.map((msg) => {
        if (!Array.isArray(msg.content)) return { ...msg, providerOptions: remap(msg.providerOptions) }
        return {
          ...msg,
          providerOptions: remap(msg.providerOptions),
          content: msg.content.map((part) => ({ ...part, providerOptions: remap(part.providerOptions) })),
        } as typeof msg
      })
    }

    return msgs
  }

  export function temperature(model: Provider.Model) {
    const id = model.id.toLowerCase()
    if (id.includes("qwen")) return 0.55
    if (id.includes("claude")) return undefined
    if (id.includes("gemini")) return 1.0
    if (id.includes("glm-4.6")) return 1.0
    if (id.includes("glm-4.7")) return 1.0
    if (id.includes("minimax-m2")) return 1.0
    if (id.includes("kimi-k2")) {
      // kimi-k2-thinking & kimi-k2.5 && kimi-k2p5
      if (id.includes("thinking") || id.includes("k2.") || id.includes("k2p")) {
        return 1.0
      }
      return 0.6
    }
    return undefined
  }

  export function topP(model: Provider.Model) {
    const id = model.id.toLowerCase()
    if (id.includes("qwen")) return 1
    if (id.includes("minimax-m2") || id.includes("kimi-k2.5") || id.includes("kimi-k2p5") || id.includes("gemini")) {
      return 0.95
    }
    return undefined
  }

  export function topK(model: Provider.Model) {
    const id = model.id.toLowerCase()
    if (id.includes("minimax-m2")) {
      if (id.includes("m2.1")) return 40
      return 20
    }
    if (id.includes("gemini")) return 64
    return undefined
  }

  const WIDELY_SUPPORTED_EFFORTS = ["low", "medium", "high"]
  const OPENAI_EFFORTS = ["none", "minimal", ...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
  const OPENAI_GPT55_EFFORTS = ["none", ...WIDELY_SUPPORTED_EFFORTS, "xhigh"]

  export function variants(model: Provider.Model): Record<string, Record<string, any>> {
    if (!model.capabilities.reasoning) return {}

    const id = model.id.toLowerCase()
    if (
      id.includes("deepseek") ||
      id.includes("minimax") ||
      id.includes("glm") ||
      id.includes("mistral") ||
      id.includes("kimi")
    )
      return {}

    // see: https://docs.x.ai/docs/guides/reasoning#control-how-hard-the-model-thinks
    if (id.includes("grok") && id.includes("grok-3-mini")) {
      if (model.api.npm === "@openrouter/ai-sdk-provider") {
        return {
          low: { reasoning: { effort: "low" } },
          high: { reasoning: { effort: "high" } },
        }
      }
      return {
        low: { reasoningEffort: "low" },
        high: { reasoningEffort: "high" },
      }
    }
    if (id.includes("grok")) return {}

    switch (model.api.npm) {
      case "@openrouter/ai-sdk-provider":
        if (model.id.includes("gemini-3")) {
          return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoning: { effort } }]))
        }
        if (!model.id.includes("gpt")) return {}
        return Object.fromEntries(
          (id.includes("gpt-5.5") ? OPENAI_GPT55_EFFORTS : OPENAI_EFFORTS).map((effort) => [
            effort,
            { reasoning: { effort } },
          ]),
        )

      // NOTE: the gateway rejects max_tokens when reasoningEffort is set — the
      // conflict is resolved in maxOutputTokens() (drops the cap for gateway
      // calls carrying a reasoningEffort), so the effort variants are safe here.
      case "@ai-sdk/gateway":
        return Object.fromEntries(OPENAI_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))

      case "@ai-sdk/github-copilot":
        const copilotEfforts = iife(() => {
          if (id.includes("5.1-codex-max") || id.includes("5.2")) return [...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
          return WIDELY_SUPPORTED_EFFORTS
        })
        return Object.fromEntries(
          copilotEfforts.map((effort) => [
            effort,
            {
              reasoningEffort: effort,
              reasoningSummary: "auto",
              include: ["reasoning.encrypted_content"],
            },
          ]),
        )

      case "@ai-sdk/cerebras":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/cerebras
      case "@ai-sdk/togetherai":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/togetherai
      case "@ai-sdk/xai":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/xai
      case "@ai-sdk/deepinfra":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/deepinfra
      case "@ai-sdk/openai-compatible":
        return Object.fromEntries(WIDELY_SUPPORTED_EFFORTS.map((effort) => [effort, { reasoningEffort: effort }]))

      case "@ai-sdk/azure":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/azure
        if (id === "o1-mini") return {}
        const azureEfforts = ["low", "medium", "high"]
        if (id.includes("gpt-5-") || id === "gpt-5") {
          azureEfforts.unshift("minimal")
        }
        return Object.fromEntries(
          azureEfforts.map((effort) => [
            effort,
            {
              reasoningEffort: effort,
              reasoningSummary: "auto",
              include: ["reasoning.encrypted_content"],
            },
          ]),
        )
      case "@ai-sdk/openai":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/openai
        if (id === "gpt-5-pro") return {}
        const openaiEfforts = iife(() => {
          if (id.includes("gpt-5.5")) return OPENAI_GPT55_EFFORTS
          if (id.includes("codex")) {
            if (id.includes("5.2")) return [...WIDELY_SUPPORTED_EFFORTS, "xhigh"]
            return WIDELY_SUPPORTED_EFFORTS
          }
          const arr = [...WIDELY_SUPPORTED_EFFORTS]
          if (id.includes("gpt-5-") || id === "gpt-5") {
            arr.unshift("minimal")
          }
          if (model.release_date >= "2025-11-13") {
            arr.unshift("none")
          }
          if (model.release_date >= "2025-12-04") {
            arr.push("xhigh")
          }
          return arr
        })
        return Object.fromEntries(
          openaiEfforts.map((effort) => [
            effort,
            {
              reasoningEffort: effort,
              reasoningSummary: "auto",
              include: ["reasoning.encrypted_content"],
            },
          ]),
        )

      case "@ai-sdk/anthropic":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/anthropic
      case "@ai-sdk/google-vertex/anthropic": {
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-vertex#anthropic-provider
        const cap = model.limit.output

        // Opus 4.7+ (and any future Claude that ships the new shape) rejects
        // `thinking.type.enabled`. They use `thinking.type.adaptive` plus
        // `output_config.effort`. Detect by canonical id.
        const usesAdaptiveThinking =
          /^claude-(opus|sonnet|haiku)-4-[7-9]\b/.test(id) || /^claude-(opus|sonnet|haiku)-[5-9]\b/.test(id)

        if (usesAdaptiveThinking) {
          // Opus 4.7+ uses adaptive thinking driven by `output_config.effort`.
          // The AI SDK Anthropic provider:
          //   - rejects `thinking.type: "adaptive"` (zod schema only allows
          //     "enabled" | "disabled" — see node_modules/@ai-sdk/anthropic/
          //     dist/index.mjs:578)
          //   - emits `thinking: { type: enabled, budget_tokens }` ONLY if
          //     anthropicOptions.thinking.type === "enabled"
          //   - emits `output_config: { effort }` independently when the
          //     top-level `effort` field is set (line 1911-1913)
          // Therefore for adaptive models we OMIT thinking entirely and only
          // send effort. The model defaults to adaptive thinking on the wire.
          //
          // The provider's stock `effort` zod enum stops at high; the pinned
          // patch in tooling/patches/@ai-sdk%2Fanthropic@2.0.57.patch widens it
          // to low|medium|high|xhigh|max so the full adaptive range is usable.
          // xhigh is the Opus 4.8+ deep-reasoning tier; other adaptive Claudes
          // cap at max.
          const supportsXhigh = /^claude-opus-4-[8-9]\b/.test(id) || /^claude-opus-[5-9]\b/.test(id)
          return {
            low: { effort: "low" },
            medium: { effort: "medium" },
            high: { effort: "high" },
            ...(supportsXhigh ? { xhigh: { effort: "xhigh" } } : {}),
            max: { effort: "max" },
          }
        }

        return {
          low: {
            thinking: {
              type: "enabled",
              budgetTokens: Math.min(4_000, cap - 1),
            },
          },
          medium: {
            thinking: {
              type: "enabled",
              budgetTokens: Math.min(10_000, Math.floor(cap / 4)),
            },
          },
          high: {
            thinking: {
              type: "enabled",
              budgetTokens: Math.min(16_000, Math.floor(cap / 2 - 1)),
            },
          },
          max: {
            thinking: {
              // Keep the thinking budget proportional (~3/4 of the output cap)
              // instead of `cap - 1`: on a 32k-output model, a 31,999-token
              // budget made maxOutputTokens() return just 1 text token, so the
              // visible answer was truncated to a single token. Large-cap models
              // are unaffected (still clamp at 31,999).
              type: "enabled",
              budgetTokens: Math.min(31_999, Math.floor((cap * 3) / 4)),
            },
          },
        }
      }

      case "@ai-sdk/amazon-bedrock":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/amazon-bedrock
        // For Anthropic models on Bedrock, use reasoningConfig with budgetTokens
        if (model.api.id.includes("anthropic")) {
          return {
            high: {
              reasoningConfig: {
                type: "enabled",
                budgetTokens: 16000,
              },
            },
            max: {
              reasoningConfig: {
                type: "enabled",
                budgetTokens: 31999,
              },
            },
          }
        }

        // For Amazon Nova models, use reasoningConfig with maxReasoningEffort
        return Object.fromEntries(
          WIDELY_SUPPORTED_EFFORTS.map((effort) => [
            effort,
            {
              reasoningConfig: {
                type: "enabled",
                maxReasoningEffort: effort,
              },
            },
          ]),
        )

      case "@ai-sdk/google-vertex":
      // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-vertex
      case "@ai-sdk/google":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/google-generative-ai
        if (id.includes("2.5")) {
          return {
            low: {
              thinkingConfig: {
                includeThoughts: true,
                thinkingBudget: 2048,
              },
            },
            medium: {
              thinkingConfig: {
                includeThoughts: true,
                thinkingBudget: 8192,
              },
            },
            high: {
              thinkingConfig: {
                includeThoughts: true,
                thinkingBudget: 16000,
              },
            },
            max: {
              thinkingConfig: {
                includeThoughts: true,
                thinkingBudget: 24576,
              },
            },
          }
        }
        // Gemini 3+ uses thinkingLevel. Nest under `thinkingConfig` — the
        // @ai-sdk/google provider only reads providerOptions.google.thinkingConfig.*,
        // so the previous top-level keys were dropped and the selected effort was
        // silently ignored (every call defaulted to the high thinkingLevel from
        // options()). options()/smallOptions() already nest correctly.
        return Object.fromEntries(
          WIDELY_SUPPORTED_EFFORTS.map((effort) => [
            effort,
            {
              thinkingConfig: {
                includeThoughts: true,
                thinkingLevel: effort,
              },
            },
          ]),
        )

      case "@ai-sdk/mistral":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/mistral
        return {}

      case "@ai-sdk/cohere":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/cohere
        return {}

      case "@ai-sdk/groq":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/groq
        // Groq uses reasoningEffort + reasoningFormat — NOT the Google
        // includeThoughts/thinkingLevel keys (which groq ignores/rejects).
        const groqEffort = ["none", ...WIDELY_SUPPORTED_EFFORTS]
        return Object.fromEntries(
          groqEffort.map((effort) => [
            effort,
            {
              reasoningEffort: effort,
              reasoningFormat: "parsed",
            },
          ]),
        )

      case "@ai-sdk/perplexity":
        // https://v5.ai-sdk.dev/providers/ai-sdk-providers/perplexity
        return {}
    }
    return {}
  }

  export function options(input: {
    model: Provider.Model
    sessionID: string
    providerOptions?: Record<string, any>
  }): Record<string, any> {
    const result: Record<string, any> = {}

    // openai and providers using openai package should set store to false by default.
    if (
      input.model.providerID === "openai" ||
      input.model.api.npm === "@ai-sdk/openai" ||
      input.model.api.npm === "@ai-sdk/github-copilot"
    ) {
      result["store"] = false
    }

    if (input.model.api.npm === "@openrouter/ai-sdk-provider") {
      result["usage"] = {
        include: true,
      }
      // OpenRouter streams reasoning through its unified `reasoning` /
      // `reasoning_details` fields, but ONLY when reasoning is explicitly
      // requested — without a `reasoning` object the upstream reasons silently
      // and OR drops the trace, so every reasoning part lands empty. Request it
      // by default for every reasoning-capable model (a selected effort variant
      // overrides this via mergeDeep in llm.ts). This is the single normalized
      // reasoning path that all managed wallet inference now flows through.
      if (input.model.capabilities.reasoning) {
        result["reasoning"] = { effort: input.model.api.id.includes("gemini-3") ? "high" : "medium" }
      }
    }

    if (
      input.model.providerID === "baseten" ||
      (input.model.providerID === "synsci" && ["kimi-k2-thinking", "glm-4.6"].includes(input.model.api.id))
    ) {
      result["chat_template_args"] = { enable_thinking: true }
    }

    if (["zai", "zhipuai"].includes(input.model.providerID) && input.model.api.npm === "@ai-sdk/openai-compatible") {
      result["thinking"] = {
        type: "enabled",
        clear_thinking: false,
      }
    }

    if (input.model.providerID === "openai" || input.providerOptions?.setCacheKey) {
      result["promptCacheKey"] = input.sessionID
    }

    if (input.model.api.npm === "@ai-sdk/google" || input.model.api.npm === "@ai-sdk/google-vertex") {
      result["thinkingConfig"] = {
        includeThoughts: true,
      }
      if (input.model.api.id.includes("gemini-3")) {
        result["thinkingConfig"]["thinkingLevel"] = "high"
      }
    }

    // OpenRouter-routed gpt-5 (e.g. "openai/gpt-5") is handled by the unified
    // OpenRouter reasoning branch above. The OpenAI-Responses-only keys below
    // (reasoningEffort / reasoningSummary / include: reasoning.encrypted_content)
    // are meaningless to OR's /chat/completions and were silently making managed
    // gpt-5 reasoning stream blank — exclude the OR npm here.
    if (
      input.model.api.id.includes("gpt-5") &&
      !input.model.api.id.includes("gpt-5-chat") &&
      input.model.api.npm !== "@openrouter/ai-sdk-provider"
    ) {
      if (!input.model.api.id.includes("gpt-5-pro")) {
        result["reasoningEffort"] = "medium"
      }

      if (
        input.model.api.id.includes("gpt-5.") &&
        !input.model.api.id.includes("codex") &&
        input.model.providerID !== "azure"
      ) {
        result["textVerbosity"] = "low"
      }

      // Managed OpenAI models carry providerID "openai" (post-rebrand), not
      // "synsci" — but they route through the Atlas proxy baseURL. Reasoning
      // summaries + encrypted content have to be requested on that path too,
      // otherwise gpt-5.x streams reasoning *items* (start/end fire) with zero
      // summary deltas, so every reasoning part lands empty and the UI shows a
      // blank "thinking" block. Genuine BYOK (no proxy baseURL) is left alone,
      // so an unverified org never gets an unexpected summary request.
      const managedBaseURL = input.providerOptions?.["baseURL"]
      const viaManagedProxy = typeof managedBaseURL === "string" && managedBaseURL.includes("/api/llm/proxy/")
      if (input.model.providerID.startsWith("synsci") || viaManagedProxy) {
        result["promptCacheKey"] = input.sessionID
        result["include"] = ["reasoning.encrypted_content"]
        result["reasoningSummary"] = "auto"
      }
    }

    if (input.model.providerID === "venice") {
      result["promptCacheKey"] = input.sessionID
    }

    return result
  }

  export function smallOptions(model: Provider.Model) {
    // OpenRouter first: an OR-routed gpt-5 / gemini model must use OR's unified
    // `reasoning` shape, not the OpenAI/Google keys the branches below emit. OR
    // silently ignores `reasoningEffort`, so without this a small OR call (title
    // / summary / compaction) would still reason and bill. Small = skip it.
    if (model.api.npm === "@openrouter/ai-sdk-provider" || model.providerID === "openrouter") {
      return { reasoning: { enabled: false } }
    }
    if (model.providerID === "openai" || model.api.id.includes("gpt-5")) {
      if (model.api.id.includes("5.")) {
        return { reasoningEffort: "low" }
      }
      return { reasoningEffort: "minimal" }
    }
    if (model.providerID === "google") {
      // gemini-3 uses thinkingLevel, gemini-2.5 uses thinkingBudget
      if (model.api.id.includes("gemini-3")) {
        return { thinkingConfig: { thinkingLevel: "low" } }
      }
      return { thinkingConfig: { thinkingBudget: 0 } }
    }
    return {}
  }

  export function providerOptions(model: Provider.Model, options: { [x: string]: any }) {
    const key = sdkKey(model.api.npm) ?? model.providerID
    return { [key]: options }
  }

  export function maxOutputTokens(
    npm: string,
    options: Record<string, any>,
    modelLimit: number,
    globalLimit: number,
  ): number | undefined {
    const modelCap = modelLimit || globalLimit
    const standardLimit = Math.min(modelCap, globalLimit)

    // The Vercel AI gateway rejects requests that set BOTH max_tokens and a
    // reasoningEffort. When an effort is selected, omit the output cap entirely
    // (return undefined) and let the gateway manage the budget.
    if (npm === "@ai-sdk/gateway" && options?.["reasoningEffort"]) {
      return undefined
    }

    if (npm === "@ai-sdk/anthropic" || npm === "@ai-sdk/google-vertex/anthropic") {
      const thinking = options?.["thinking"]
      const budgetTokens = typeof thinking?.["budgetTokens"] === "number" ? thinking["budgetTokens"] : 0
      const enabled = thinking?.["type"] === "enabled"
      if (enabled && budgetTokens > 0) {
        // Return text tokens so that text + thinking <= model cap, preferring 32k text when possible.
        if (budgetTokens + standardLimit <= modelCap) {
          return standardLimit
        }
        return modelCap - budgetTokens
      }
    }

    return standardLimit
  }

  export function schema(model: Provider.Model, schema: JSONSchema.BaseSchema) {
    /*
    if (["openai", "azure"].includes(providerID)) {
      if (schema.type === "object" && schema.properties) {
        for (const [key, value] of Object.entries(schema.properties)) {
          if (schema.required?.includes(key)) continue
          schema.properties[key] = {
            anyOf: [
              value as JSONSchema.JSONSchema,
              {
                type: "null",
              },
            ],
          }
        }
      }
    }
    */

    // Convert integer enums to string enums for Google/Gemini
    if (model.providerID === "google" || model.api.id.includes("gemini")) {
      const sanitizeGemini = (obj: any): any => {
        if (obj === null || typeof obj !== "object") {
          return obj
        }

        if (Array.isArray(obj)) {
          return obj.map(sanitizeGemini)
        }

        const result: any = {}
        for (const [key, value] of Object.entries(obj)) {
          if (key === "enum" && Array.isArray(value)) {
            // Convert all enum values to strings
            result[key] = value.map((v) => String(v))
            // If we have integer type with enum, change type to string
            if (result.type === "integer" || result.type === "number") {
              result.type = "string"
            }
          } else if (typeof value === "object" && value !== null) {
            result[key] = sanitizeGemini(value)
          } else {
            result[key] = value
          }
        }

        // Filter required array to only include fields that exist in properties
        if (result.type === "object" && result.properties && Array.isArray(result.required)) {
          result.required = result.required.filter((field: any) => field in result.properties)
        }

        if (result.type === "array" && result.items == null) {
          result.items = {}
        }

        return result
      }

      schema = sanitizeGemini(schema)
    }

    return schema
  }

  export function error(providerID: string, error: APICallError) {
    let message = error.message
    if (providerID.includes("github-copilot") && error.statusCode === 403) {
      return "Please reauthenticate with the copilot provider to ensure your credentials work properly with OpenScience."
    }
    if (providerID.includes("github-copilot") && message.includes("The requested model is not supported")) {
      return (
        message +
        "\n\nMake sure the model is enabled in your copilot settings: https://github.com/settings/copilot/features"
      )
    }

    return message
  }
}

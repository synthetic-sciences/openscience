import { BusEvent } from "@/bus/bus-event"
import z from "zod"
import { NamedError } from "@synsci/util/error"
import { APICallError, convertToModelMessages, LoadAPIKeyError, type ModelMessage, type UIMessage } from "ai"
import { Identifier } from "../id/id"
import { LSP } from "../lsp"
import { Snapshot } from "@/snapshot"
import { fn } from "@/util/fn"
import { Storage } from "@/storage/storage"
import { ProviderTransform } from "@/provider/transform"
import { STATUS_CODES } from "http"
import { iife } from "@/util/iife"
import { type SystemError } from "bun"
import type { Provider } from "@/provider/provider"
import { correctImageMimeFromBase64 } from "@/util/image"
import { Lock } from "@/util/lock"
import { Token } from "@/util/token"

export namespace MessageV2 {
  export const OutputLengthError = NamedError.create("MessageOutputLengthError", z.object({}))
  export const AbortedError = NamedError.create("MessageAbortedError", z.object({ message: z.string() }))
  export const AuthError = NamedError.create(
    "ProviderAuthError",
    z.object({
      providerID: z.string(),
      message: z.string(),
    }),
  )
  export const APIError = NamedError.create(
    "APIError",
    z.object({
      message: z.string(),
      statusCode: z.number().optional(),
      isRetryable: z.boolean(),
      responseHeaders: z.record(z.string(), z.string()).optional(),
      responseBody: z.string().optional(),
      metadata: z.record(z.string(), z.string()).optional(),
    }),
  )
  export type APIError = z.infer<typeof APIError.Schema>

  const PartBase = z.object({
    id: z.string(),
    sessionID: z.string(),
    messageID: z.string(),
  })

  export const SnapshotPart = PartBase.extend({
    type: z.literal("snapshot"),
    snapshot: z.string(),
  }).meta({
    ref: "SnapshotPart",
  })
  export type SnapshotPart = z.infer<typeof SnapshotPart>

  export const PatchPart = PartBase.extend({
    type: z.literal("patch"),
    hash: z.string(),
    files: z.string().array(),
  }).meta({
    ref: "PatchPart",
  })
  export type PatchPart = z.infer<typeof PatchPart>

  export const TextPart = PartBase.extend({
    type: z.literal("text"),
    text: z.string(),
    synthetic: z.boolean().optional(),
    ignored: z.boolean().optional(),
    time: z
      .object({
        start: z.number(),
        end: z.number().optional(),
      })
      .optional(),
    metadata: z.record(z.string(), z.any()).optional(),
  }).meta({
    ref: "TextPart",
  })
  export type TextPart = z.infer<typeof TextPart>

  export const ReasoningPart = PartBase.extend({
    type: z.literal("reasoning"),
    text: z.string(),
    metadata: z.record(z.string(), z.any()).optional(),
    time: z.object({
      start: z.number(),
      end: z.number().optional(),
    }),
  }).meta({
    ref: "ReasoningPart",
  })
  export type ReasoningPart = z.infer<typeof ReasoningPart>

  const FilePartSourceBase = z.object({
    text: z
      .object({
        value: z.string(),
        start: z.number().int(),
        end: z.number().int(),
      })
      .meta({
        ref: "FilePartSourceText",
      }),
  })

  export const FileSource = FilePartSourceBase.extend({
    type: z.literal("file"),
    path: z.string(),
  }).meta({
    ref: "FileSource",
  })

  export const SymbolSource = FilePartSourceBase.extend({
    type: z.literal("symbol"),
    path: z.string(),
    range: LSP.Range,
    name: z.string(),
    kind: z.number().int(),
  }).meta({
    ref: "SymbolSource",
  })

  export const ResourceSource = FilePartSourceBase.extend({
    type: z.literal("resource"),
    clientName: z.string(),
    uri: z.string(),
  }).meta({
    ref: "ResourceSource",
  })

  export const FilePartSource = z.discriminatedUnion("type", [FileSource, SymbolSource, ResourceSource]).meta({
    ref: "FilePartSource",
  })

  export const FilePart = PartBase.extend({
    type: z.literal("file"),
    mime: z.string(),
    filename: z.string().optional(),
    url: z.string(),
    source: FilePartSource.optional(),
  }).meta({
    ref: "FilePart",
  })
  export type FilePart = z.infer<typeof FilePart>

  export const AgentPart = PartBase.extend({
    type: z.literal("agent"),
    name: z.string(),
    source: z
      .object({
        value: z.string(),
        start: z.number().int(),
        end: z.number().int(),
      })
      .optional(),
  }).meta({
    ref: "AgentPart",
  })
  export type AgentPart = z.infer<typeof AgentPart>

  export const CompactionPart = PartBase.extend({
    type: z.literal("compaction"),
    auto: z.boolean(),
    focus: z.string().optional(),
    handoffFile: z.string().optional(),
    // What asked for this compaction — carried through to summary telemetry so we can
    // tell proactive (0.75 threshold) from reactive (overflow backstop) from manual.
    trigger: z.enum(["proactive", "overflow", "manual"]).optional(),
  }).meta({
    ref: "CompactionPart",
  })
  export type CompactionPart = z.infer<typeof CompactionPart>

  export const SubtaskPart = PartBase.extend({
    type: z.literal("subtask"),
    prompt: z.string(),
    description: z.string(),
    agent: z.string(),
    model: z
      .object({
        providerID: z.string(),
        modelID: z.string(),
      })
      .optional(),
    command: z.string().optional(),
  }).meta({
    ref: "SubtaskPart",
  })
  export type SubtaskPart = z.infer<typeof SubtaskPart>

  export const RetryPart = PartBase.extend({
    type: z.literal("retry"),
    attempt: z.number(),
    error: APIError.Schema,
    time: z.object({
      created: z.number(),
    }),
  }).meta({
    ref: "RetryPart",
  })
  export type RetryPart = z.infer<typeof RetryPart>

  export const StepStartPart = PartBase.extend({
    type: z.literal("step-start"),
    snapshot: z.string().optional(),
  }).meta({
    ref: "StepStartPart",
  })
  export type StepStartPart = z.infer<typeof StepStartPart>

  export const StepFinishPart = PartBase.extend({
    type: z.literal("step-finish"),
    reason: z.string(),
    snapshot: z.string().optional(),
    cost: z.number(),
    tokens: z.object({
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({
        read: z.number(),
        write: z.number(),
      }),
    }),
  }).meta({
    ref: "StepFinishPart",
  })
  export type StepFinishPart = z.infer<typeof StepFinishPart>

  export const ToolStatePending = z
    .object({
      status: z.literal("pending"),
      input: z.record(z.string(), z.any()),
      raw: z.string(),
    })
    .meta({
      ref: "ToolStatePending",
    })

  export type ToolStatePending = z.infer<typeof ToolStatePending>

  export const ToolStateRunning = z
    .object({
      status: z.literal("running"),
      input: z.record(z.string(), z.any()),
      title: z.string().optional(),
      metadata: z.record(z.string(), z.any()).optional(),
      time: z.object({
        start: z.number(),
      }),
    })
    .meta({
      ref: "ToolStateRunning",
    })
  export type ToolStateRunning = z.infer<typeof ToolStateRunning>

  export const ToolStateCompleted = z
    .object({
      status: z.literal("completed"),
      input: z.record(z.string(), z.any()),
      output: z.string(),
      title: z.string(),
      metadata: z.record(z.string(), z.any()),
      time: z.object({
        start: z.number(),
        end: z.number(),
        compacted: z.number().optional(),
      }),
      attachments: FilePart.array().optional(),
    })
    .meta({
      ref: "ToolStateCompleted",
    })
  export type ToolStateCompleted = z.infer<typeof ToolStateCompleted>

  export const ToolStateError = z
    .object({
      status: z.literal("error"),
      input: z.record(z.string(), z.any()),
      error: z.string(),
      metadata: z.record(z.string(), z.any()).optional(),
      time: z.object({
        start: z.number(),
        end: z.number(),
      }),
    })
    .meta({
      ref: "ToolStateError",
    })
  export type ToolStateError = z.infer<typeof ToolStateError>

  export const ToolState = z
    .discriminatedUnion("status", [ToolStatePending, ToolStateRunning, ToolStateCompleted, ToolStateError])
    .meta({
      ref: "ToolState",
    })

  export const ToolPart = PartBase.extend({
    type: z.literal("tool"),
    callID: z.string(),
    tool: z.string(),
    state: ToolState,
    metadata: z.record(z.string(), z.any()).optional(),
  }).meta({
    ref: "ToolPart",
  })
  export type ToolPart = z.infer<typeof ToolPart>

  const Base = z.object({
    id: z.string(),
    sessionID: z.string(),
  })

  export const User = Base.extend({
    role: z.literal("user"),
    time: z.object({
      created: z.number(),
    }),
    summary: z
      .object({
        title: z.string().optional(),
        body: z.string().optional(),
        diffs: Snapshot.FileDiff.array(),
      })
      .optional(),
    agent: z.string(),
    model: z.object({
      providerID: z.string(),
      modelID: z.string(),
    }),
    system: z.string().optional(),
    tools: z.record(z.string(), z.boolean()).optional(),
    variant: z.string().optional(),
    tier: z.enum(["fast", "pro", "ultra"]).optional(),
  }).meta({
    ref: "UserMessage",
  })
  export type User = z.infer<typeof User>

  export const Part = z
    .discriminatedUnion("type", [
      TextPart,
      SubtaskPart,
      ReasoningPart,
      FilePart,
      ToolPart,
      StepStartPart,
      StepFinishPart,
      SnapshotPart,
      PatchPart,
      AgentPart,
      RetryPart,
      CompactionPart,
    ])
    .meta({
      ref: "Part",
    })
  export type Part = z.infer<typeof Part>

  export const Assistant = Base.extend({
    role: z.literal("assistant"),
    time: z.object({
      created: z.number(),
      completed: z.number().optional(),
    }),
    error: z
      .discriminatedUnion("name", [
        AuthError.Schema,
        NamedError.Unknown.Schema,
        OutputLengthError.Schema,
        AbortedError.Schema,
        APIError.Schema,
      ])
      .optional(),
    parentID: z.string(),
    modelID: z.string(),
    providerID: z.string(),
    /**
     * @deprecated
     */
    mode: z.string(),
    agent: z.string(),
    path: z.object({
      cwd: z.string(),
      root: z.string(),
    }),
    summary: z.boolean().optional(),
    cost: z.number(),
    tokens: z.object({
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({
        read: z.number(),
        write: z.number(),
      }),
    }),
    finish: z.string().optional(),
    // P3.2: the id of the user message where the verbatim recent tail begins, for the
    // summary message. filterCompacted keeps [tailStartId..boundary] verbatim after the
    // summary instead of dropping it.
    tailStartId: z.string().optional(),
  }).meta({
    ref: "AssistantMessage",
  })
  export type Assistant = z.infer<typeof Assistant>

  export const Info = z.discriminatedUnion("role", [User, Assistant]).meta({
    ref: "Message",
  })
  export type Info = z.infer<typeof Info>

  export const Event = {
    Updated: BusEvent.define(
      "message.updated",
      z.object({
        info: Info,
      }),
    ),
    Removed: BusEvent.define(
      "message.removed",
      z.object({
        sessionID: z.string(),
        messageID: z.string(),
      }),
    ),
    PartUpdated: BusEvent.define(
      "message.part.updated",
      z.object({
        part: Part,
        delta: z.string().optional(),
      }),
    ),
    PartRemoved: BusEvent.define(
      "message.part.removed",
      z.object({
        sessionID: z.string(),
        messageID: z.string(),
        partID: z.string(),
      }),
    ),
  }

  export const WithParts = z.object({
    info: Info,
    parts: z.array(Part),
  })
  export type WithParts = z.infer<typeof WithParts>

  // Finish reasons that mean the agent is NOT done — it will call more tools, or the reason
  // is ambiguous ("unknown") and the loop treats it as "keep going". Everything else ("stop",
  // "length", …) is a completed turn. The loop uses this to decide whether to keep iterating,
  // and compaction uses it to decide whether to compact mid-task vs yield after a finished
  // answer — sharing one predicate so the two can't drift apart.
  export const CONTINUING_FINISH = ["tool-calls", "unknown"]
  export function isContinuing(finish?: string): boolean {
    return !!finish && CONTINUING_FINISH.includes(finish)
  }

  export function toModelMessages(
    input: WithParts[],
    model: Provider.Model,
    options?: { stripMedia?: boolean; keepRecentImages?: number },
  ): ModelMessage[] {
    const result: UIMessage[] = []
    const toolNames = new Set<string>()
    // P2.1: older tool outputs identical to a more recent call collapse to a back-ref.
    const superseded = supersededOutputs(input)

    // Media budgeting. `stripMedia` (used for the compaction summary) drops ALL images;
    // otherwise `keepRecentImages` keeps only the last N images in full and replaces
    // older ones with a text placeholder — so re-shipping many figures every turn can't
    // bloat the window. The image stays on disk and can be re-read on demand. Count up
    // front so "last N" is well-defined; both passes visit images in input→part order.
    const isImage = (mime: string) => mime.startsWith("image/")
    let totalImages = 0
    if (!options?.stripMedia && options?.keepRecentImages !== undefined) {
      for (const msg of input)
        for (const part of msg.parts) {
          if (part.type === "file" && isImage(part.mime)) totalImages++
          if (part.type === "tool" && part.state.status === "completed" && !part.state.time.compacted)
            for (const a of part.state.attachments ?? []) if (isImage(a.mime)) totalImages++
        }
    }
    let imagesSeen = 0
    // Returns a placeholder string when this image occurrence should be dropped, else undefined.
    const dropImage = (mime: string, url: string, filename?: string): string | undefined => {
      if (!isImage(mime)) return undefined
      if (options?.stripMedia) return `[image omitted${filename ? `: ${filename}` : ""}]`
      // Oversized guard (P2.4): a too-large image is replaced by an actionable resize
      // nudge even when it is a recent image we would otherwise keep — shipping it would
      // 400 the request. Independent of the recency budget below.
      const oversized = oversizedImageNudge(url, filename)
      if (options?.keepRecentImages === undefined) return oversized
      const drop = imagesSeen < totalImages - options.keepRecentImages
      imagesSeen++
      if (oversized) return oversized
      return drop
        ? `[older image omitted to save context${filename ? `: ${filename}` : ""} — read it again if you need it]`
        : undefined
    }

    const toModelOutput = (output: unknown) => {
      if (typeof output === "string") {
        return { type: "text", value: output }
      }

      if (typeof output === "object") {
        const outputObject = output as {
          text: string
          attachments?: Array<{ mime: string; url: string }>
        }
        const attachments = (outputObject.attachments ?? []).filter((attachment) => {
          return attachment.url.startsWith("data:") && attachment.url.includes(",")
        })

        return {
          type: "content",
          value: [
            { type: "text", text: outputObject.text },
            ...attachments.map((attachment) => {
              const base64 = iife(() => {
                const commaIndex = attachment.url.indexOf(",")
                return commaIndex === -1 ? attachment.url : attachment.url.slice(commaIndex + 1)
              })
              const mime = attachment.mime.startsWith("image/")
                ? correctImageMimeFromBase64(attachment.mime, base64)
                : attachment.mime
              return { type: "media", mediaType: mime, data: base64 }
            }),
          ],
        }
      }

      return { type: "json", value: output as never }
    }

    for (const msg of input) {
      if (msg.parts.length === 0) continue

      if (msg.info.role === "user") {
        const userMessage: UIMessage = {
          id: msg.info.id,
          role: "user",
          parts: [],
        }
        result.push(userMessage)
        for (const part of msg.parts) {
          if (part.type === "text" && !part.ignored)
            userMessage.parts.push({
              type: "text",
              text: part.text,
            })
          // text/plain and directory files are converted into text parts, ignore them
          if (part.type === "file" && part.mime !== "text/plain" && part.mime !== "application/x-directory") {
            const dropped = dropImage(part.mime, part.url, part.filename)
            if (dropped) {
              userMessage.parts.push({ type: "text", text: dropped })
            } else {
              let mime = part.mime
              if (mime.startsWith("image/") && part.url.startsWith("data:")) {
                const commaIdx = part.url.indexOf(",")
                if (commaIdx !== -1) {
                  mime = correctImageMimeFromBase64(mime, part.url.slice(commaIdx + 1))
                }
              }
              userMessage.parts.push({
                type: "file",
                url: mime !== part.mime ? `data:${mime};base64,${part.url.slice(part.url.indexOf(",") + 1)}` : part.url,
                mediaType: mime,
                filename: part.filename,
              })
            }
          }

          if (part.type === "compaction") {
            userMessage.parts.push({
              type: "text",
              text: "What did we do so far?",
            })
          }
          if (part.type === "subtask") {
            userMessage.parts.push({
              type: "text",
              text: "The following tool was executed by the user",
            })
          }
        }
      }

      if (msg.info.role === "assistant") {
        const differentModel = `${model.providerID}/${model.id}` !== `${msg.info.providerID}/${msg.info.modelID}`

        if (
          msg.info.error &&
          !(
            MessageV2.AbortedError.isInstance(msg.info.error) &&
            msg.parts.some((part) => part.type !== "step-start" && part.type !== "reasoning")
          )
        ) {
          continue
        }
        const assistantMessage: UIMessage = {
          id: msg.info.id,
          role: "assistant",
          parts: [],
        }
        for (const part of msg.parts) {
          if (part.type === "text")
            assistantMessage.parts.push({
              type: "text",
              text: part.text,
              ...(differentModel ? {} : { providerMetadata: part.metadata }),
            })
          if (part.type === "step-start")
            assistantMessage.parts.push({
              type: "step-start",
            })
          if (part.type === "tool") {
            toolNames.add(part.tool)
            if (part.state.status === "completed") {
              const isDuplicate = superseded.has(part.id)
              const rawAttachments = part.state.time.compacted || isDuplicate ? [] : (part.state.attachments ?? [])
              let droppedNote = ""
              const attachments = rawAttachments.filter((a) => {
                const dropped = dropImage(a.mime, a.url, a.filename)
                if (dropped) droppedNote += `\n${dropped}`
                return !dropped
              })
              const baseText = isDuplicate
                ? DUPLICATE_OUTPUT
                : part.state.time.compacted
                  ? toolSummary(part.tool, part.state)
                  : part.state.output
              const outputText = baseText + droppedNote
              const output =
                attachments.length > 0
                  ? {
                      text: outputText,
                      attachments,
                    }
                  : outputText

              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-available",
                toolCallId: part.callID,
                input: part.state.time.compacted ? truncateArgs(part.state.input) : part.state.input,
                output,
                ...(differentModel ? {} : { callProviderMetadata: part.metadata }),
              })
            }
            if (part.state.status === "error")
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: part.state.input,
                errorText: part.state.error,
                ...(differentModel ? {} : { callProviderMetadata: part.metadata }),
              })
            // Handle pending/running tool calls to prevent dangling tool_use blocks
            // Anthropic/Claude APIs require every tool_use to have a corresponding tool_result
            if (part.state.status === "pending" || part.state.status === "running")
              assistantMessage.parts.push({
                type: ("tool-" + part.tool) as `tool-${string}`,
                state: "output-error",
                toolCallId: part.callID,
                input: part.state.input,
                errorText: "[Tool execution was interrupted]",
                ...(differentModel ? {} : { callProviderMetadata: part.metadata }),
              })
          }
          if (part.type === "reasoning") {
            assistantMessage.parts.push({
              type: "reasoning",
              text: part.text,
              ...(differentModel ? {} : { providerMetadata: part.metadata }),
            })
          }
        }
        if (assistantMessage.parts.length > 0) {
          result.push(assistantMessage)
        }
      }
    }

    const tools = Object.fromEntries(Array.from(toolNames).map((toolName) => [toolName, { toModelOutput }]))

    return convertToModelMessages(
      result.filter((msg) => msg.parts.some((part) => part.type !== "step-start")),
      {
        //@ts-expect-error (convertToModelMessages expects a ToolSet but only actually needs tools[name]?.toModelOutput)
        tools,
      },
    )
  }

  // Flat per-image token cost. An image's model cost bears no relation to its base64
  // byte length, so a fixed estimate is what the reference tools use (claude-code /
  // opencode 2000, hermes 1500). Single source of truth — SessionCompaction re-exports
  // it as IMAGE_TOKEN_ESTIMATE (it can't import here without a cycle).
  export const IMAGE_TOKENS = 1600

  // Anthropic (and most providers) reject a single image over 5 MB with an HTTP 400.
  // P1's flat token estimate neither counts an oversized image accurately nor prevents
  // that error, so a single big figure can hard-fail the turn. P2.4 guards it WITHOUT an
  // image codec in the binary: when an image is too large to send, the harness never
  // ships the base64 — it substitutes an actionable nudge telling the agent to resize the
  // source file (which it can see in the preceding read/attach) and re-read the smaller
  // copy. The resize runs in the agent's own tool sandbox (bash/python), mirroring
  // hermes' runtime-Pillow model without baking a native dep into the compiled binary.
  export const IMAGE_MAX_BYTES = 5 * 1024 * 1024

  // v1 triggers on byte size — the dominant cause of the 400. Pixel-dimension oversize
  // (a tall thin screenshot under 5 MB but over the 8000px per-side cap) is a documented
  // follow-up; `readImageDimensions` in util/image is the primitive it would build on.
  export function oversizedImageNudge(url: string, filename?: string, maxBytes = IMAGE_MAX_BYTES): string | undefined {
    if (!url.startsWith("data:")) return undefined // only measurable for inline base64
    const comma = url.indexOf(",")
    if (comma === -1) return undefined
    const bytes = Math.floor(((url.length - comma - 1) * 3) / 4) // base64 → decoded size
    if (bytes <= maxBytes) return undefined
    const mb = (bytes / (1024 * 1024)).toFixed(1)
    const limit = Math.round(maxBytes / (1024 * 1024))
    const name = filename ? ` ${filename}` : ""
    return (
      `[Image${name} omitted — too large to send (~${mb} MB, ${limit} MB limit). ` +
      `To view it, resize the source file to ≤2000px and read the smaller copy, e.g.: ` +
      `python3 -c "from PIL import Image; im=Image.open(SRC); im.thumbnail((2000,2000)); im.save(OUT)" ` +
      `(SRC = the file named in the read/attachment just above; OUT = a new path), then read OUT. ` +
      `If it was rendered by a script, re-run it at a lower dpi/figsize.]`
    )
  }

  // Skill/artifact invocations are bucketed separately from generic tool traffic so the
  // telemetry can attribute their cost. NOTE: the skill *catalog* (the bulk of skill
  // tokens) lives in the agent/system prompt and is counted under `system`, not here.
  const SKILL_TOOLS = new Set(["skill", "artifact"])

  // Deterministic, lossless dedupe of repeated tool output. Re-reading a file or
  // re-running a command re-ships the identical body every turn; only the newest copy is
  // useful, so older identical outputs become a back-reference. Minimum size guards
  // against churning on trivially-small outputs (the back-ref itself costs a line), and
  // parts with attachments are left alone (identical text ≠ identical media).
  export const DEDUPE_MIN_CHARS = 200
  // Stubs a LATER re-read that is byte-identical to an earlier one (keep-older; see
  // supersededOutputs). Points BACKWARD to the earlier full copy and leads with an explicit
  // "unchanged" assertion, so the model reads it as "I already have this, it didn't change"
  // rather than "this read differs from my earlier one." Wording clarity is secondary to the
  // keep-older structure — but both matter (the model still parses this line).
  export const DUPLICATE_OUTPUT =
    "[Duplicate read omitted — byte-for-byte identical to an earlier read of the same tool in this conversation; the content is UNCHANGED. Refer to that earlier copy.]"

  // Returns the ids of completed tool parts whose output is byte-identical to an EARLIER
  // call's output — i.e. the later re-reads, safe to replace with a back-reference to the
  // first full copy. Keep-OLDER (not keep-newer) is deliberate: the model's first read
  // stays full and the re-read becomes the stub, so it never perceives "first read = stub,
  // later read = full body" as the content having changed (a real failure we hit live;
  // claude-code's read-time FILE_UNCHANGED_STUB keeps the older copy for the same reason).
  // Self-healing under pruning: compacted parts are skipped, so once the kept first copy is
  // pruned, the next occurrence stops being superseded and renders full again.
  export function supersededOutputs(input: WithParts[], min = DEDUPE_MIN_CHARS): Set<string> {
    const firstSeen = new Map<string, string>() // output text -> id of its EARLIEST occurrence
    const superseded = new Set<string>()
    for (const msg of input)
      for (const part of msg.parts) {
        if (part.type !== "tool" || part.state.status !== "completed") continue
        if (part.state.time.compacted) continue
        if ((part.state.attachments ?? []).length) continue
        const output = part.state.output ?? ""
        if (output.length < min) continue
        if (firstSeen.has(output)) superseded.add(part.id) // a later identical copy
        else firstSeen.set(output, part.id) // the first full copy — keep it
      }
    return superseded
  }

  // Per-string cap for the args of a reduced (pruned) tool call. Once a call is
  // compacted its result is gone, so an oversized payload arg (a 50KB `write` content, a
  // long `edit` oldString) is dead weight — truncate it while keeping the JSON valid and
  // the small identifying args (paths, flags) intact so the call still reads correctly.
  export const ARG_TRUNCATE_CHARS = 200

  export function truncateArgs(input: Record<string, any>, cap = ARG_TRUNCATE_CHARS): Record<string, any> {
    const out: Record<string, any> = {}
    for (const [k, v] of Object.entries(input ?? {}))
      out[k] = typeof v === "string" && v.length > cap ? v.slice(0, cap) + `…[+${v.length - cap} chars]` : v
    return out
  }

  // A 1-line, tool-aware stand-in for a reduced (pruned) tool output. Replaces the blunt
  // "[Old tool result content cleared]" so the model retains the gist — which tool ran,
  // against what, and how big the result was — and knows it can re-run to recover the
  // body. Keeps the token cost to a single line. Used by both toModelMessages (render)
  // and composition (accounting) so the two never disagree.
  export function toolSummary(tool: string, state: ToolStateCompleted): string {
    const descriptor = iife(() => {
      const title = state.title?.trim()
      if (title) return title
      const entries = Object.entries(state.input ?? {})
      if (!entries.length) return ""
      return entries.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ")
    })
      .replace(/\s+/g, " ")
      .slice(0, 80)
      .trim()
    const lines = state.output ? state.output.split("\n").length : 0
    return `[${tool}]${descriptor ? " " + descriptor : ""} → cleared (${lines} line${lines === 1 ? "" : "s"})`
  }

  export type Composition = {
    system: number
    text: number
    reasoning: number
    tool: number
    skills: number
    image: number
    images: number
    total: number
  }

  // Deterministic, zero-cost breakdown of what the working context is made of, bucketed
  // by content type. Mirrors `toModelMessages` accounting so the numbers match what is
  // actually shipped: images are the flat IMAGE_TOKENS estimate, and a pruned
  // (`time.compacted`) tool part counts its cleared placeholder with attachments dropped
  // — so a prune visibly shrinks the breakdown. `system` covers the prompt strings that
  // are not part of the message log. Powers P0 context-composition telemetry.
  export function composition(input: WithParts[], options?: { system?: string[] }): Composition {
    const out: Composition = { system: 0, text: 0, reasoning: 0, tool: 0, skills: 0, image: 0, images: 0, total: 0 }
    for (const s of options?.system ?? []) out.system += Token.estimate(s)
    const superseded = supersededOutputs(input)

    const addImages = (count: number) => {
      out.image += count * IMAGE_TOKENS
      out.images += count
    }

    for (const msg of input)
      for (const part of msg.parts) {
        if (part.type === "text") {
          if (part.ignored) continue
          out.text += Token.estimate(part.text)
          continue
        }
        if (part.type === "reasoning") {
          out.reasoning += Token.estimate(part.text)
          continue
        }
        if (part.type === "file") {
          if (part.mime.startsWith("image/")) {
            const nudge = oversizedImageNudge(part.url, part.filename)
            if (nudge) out.text += Token.estimate(nudge)
            else addImages(1)
          }
          continue
        }
        if (part.type === "tool") {
          const bucket = SKILL_TOOLS.has(part.tool) ? "skills" : "tool"
          const compacted = part.state.status === "completed" && !!part.state.time.compacted
          out[bucket] += Token.estimate(JSON.stringify((compacted ? truncateArgs(part.state.input) : part.state.input) ?? {}))
          if (part.state.status === "completed") {
            const body = superseded.has(part.id)
              ? DUPLICATE_OUTPUT
              : compacted
                ? toolSummary(part.tool, part.state)
                : part.state.output
            out[bucket] += Token.estimate(body)
            if (!compacted && !superseded.has(part.id))
              for (const a of part.state.attachments ?? [])
                if (a.mime.startsWith("image/")) {
                  const nudge = oversizedImageNudge(a.url, a.filename)
                  if (nudge) out[bucket] += Token.estimate(nudge)
                  else addImages(1)
                }
          }
          if (part.state.status === "error") out[bucket] += Token.estimate(part.state.error)
        }
      }

    out.total = out.system + out.text + out.reasoning + out.tool + out.skills + out.image
    return out
  }

  export const stream = fn(Identifier.schema("session"), async function* (sessionID) {
    const list = await Array.fromAsync(await Storage.list(["message", sessionID]))
    for (let i = list.length - 1; i >= 0; i--) {
      yield await get({
        sessionID,
        messageID: list[i][2],
      })
    }
  })

  // Per-session cache of the highest message ID observed. Avoids scanning the
  // session's message directory on every new-message creation. Populated lazily
  // on first access and updated under the per-session write lock below.
  const lastIDCache = new Map<string, string>()

  /** Highest-sorting message ID currently in a session, or undefined. */
  export async function lastID(sessionID: string): Promise<string | undefined> {
    const cached = lastIDCache.get(sessionID)
    if (cached) return cached
    // Storage.list returns already-sorted entries (see storage.ts), so the
    // last entry is the max. O(n) glob scan remains, but we only pay it once
    // per session per process.
    const list = await Storage.list(["message", sessionID])
    if (list.length === 0) return undefined
    const max = list[list.length - 1][2]
    lastIDCache.set(sessionID, max)
    return max
  }

  /**
   * Generate a message ID guaranteed to sort after all existing messages in
   * the session.
   *
   * Handles cross-version sessions where older messages may encode time
   * prefixes higher than the current clock. The Identifier format encodes
   * `(timestamp_ms * 0x1000 + counter)` into 48 bits, which wraps every
   * ~2.2 years and is not naturally monotonic when the clock crosses a wrap
   * boundary. We therefore reason in *prefix space* (the raw 48-bit value),
   * not timestamp space.
   *
   * Concurrency: serialized per-session under Lock.write("nextMessageID:<id>")
   * so two concurrent callers see distinct highests and the later call
   * reliably sorts after the earlier one. The in-memory cache is updated
   * inside the lock so subsequent calls observe the new max without rescanning
   * storage.
   *
   * If `proposed` is given it is returned as-is if it already sorts after
   * the session's max; otherwise it is discarded and a fresh monotonic ID
   * is issued.
   */
  export async function nextMessageID(sessionID: string, proposed?: string): Promise<string> {
    using _ = await Lock.write("nextMessageID:" + sessionID)
    const highest = await lastID(sessionID)

    const issue = (id: string): string => {
      lastIDCache.set(sessionID, id)
      return id
    }

    if (!highest) return issue(proposed ? Identifier.ascending("message", proposed) : Identifier.ascending("message"))
    if (proposed && proposed > highest) return issue(Identifier.ascending("message", proposed))

    // Try the natural clock first so IDs stay close to real time when possible.
    const natural = Identifier.ascending("message")
    if (natural > highest) return issue(natural)

    // Fall back to direct prefix bump: add 1 to the 48-bit prefix (modulo 2^48)
    // and keep a fresh random suffix so the ID doesn't collide with any prior.
    const highestPrefix = BigInt("0x" + highest.slice(4, 16))
    const bumpedPrefix = (highestPrefix + 1n) & 0xffffffffffffn
    const prefixHex = bumpedPrefix.toString(16).padStart(12, "0")
    return issue("msg_" + prefixHex + natural.slice(16))
  }

  /** Clear the cached highest-message-ID for a session (e.g. after revert/compact). */
  export function invalidateLastID(sessionID: string): void {
    lastIDCache.delete(sessionID)
  }

  export const parts = fn(Identifier.schema("message"), async (messageID) => {
    const result = [] as MessageV2.Part[]
    for (const item of await Storage.list(["part", messageID])) {
      const read = await Storage.read<MessageV2.Part>(item)
      result.push(read)
    }
    result.sort((a, b) => (a.id > b.id ? 1 : -1))
    return result
  })

  export const get = fn(
    z.object({
      sessionID: Identifier.schema("session"),
      messageID: Identifier.schema("message"),
    }),
    async (input): Promise<WithParts> => {
      return {
        info: await Storage.read<MessageV2.Info>(["message", input.sessionID, input.messageID]),
        parts: await parts(input.messageID),
      }
    },
  )

  export async function filterCompacted(stream: AsyncIterable<MessageV2.WithParts>) {
    const result = [] as MessageV2.WithParts[]
    const completed = new Set<string>() // carrier ids (parentIDs of completed summaries)
    let tailStartId: string | undefined // from the newest completed summary
    let retain: string | undefined // once set, keep reading (to collect the tail) until this id, then stop
    for await (const msg of stream) {
      // stream yields NEWEST-first
      result.push(msg)
      if (retain) {
        if (msg.info.id === retain) break
        continue
      }
      if (msg.info.role === "assistant" && msg.info.summary && msg.info.finish) {
        completed.add(msg.info.parentID)
        if (tailStartId === undefined) tailStartId = (msg.info as MessageV2.Assistant).tailStartId
      }
      if (msg.info.role === "user" && completed.has(msg.info.id) && msg.parts.some((p) => p.type === "compaction")) {
        if (!tailStartId) break
        retain = tailStartId
        if (msg.info.id === retain) break
      }
    }
    result.reverse() // now OLDEST-first
    if (!tailStartId) return result
    const carrierIdx = result.findLastIndex(
      (m) => m.info.role === "user" && completed.has(m.info.id) && m.parts.some((p) => p.type === "compaction"),
    )
    const summaryIdx =
      carrierIdx === -1
        ? -1
        : result.findIndex(
            (m, i) =>
              i > carrierIdx &&
              m.info.role === "assistant" &&
              m.info.summary === true &&
              m.info.parentID === result[carrierIdx].info.id,
          )
    const tailIdx = result.findIndex((m) => m.info.id === tailStartId)
    if (tailIdx >= 0 && tailIdx < carrierIdx && summaryIdx > carrierIdx)
      return [
        ...result.slice(carrierIdx, summaryIdx + 1), // [carrier, summary]
        ...result.slice(tailIdx, carrierIdx), // verbatim tail
        ...result.slice(summaryIdx + 1), // continuation
      ]
    return result
  }

  const isOpenAiErrorRetryable = (e: APICallError) => {
    const status = e.statusCode
    if (!status) return e.isRetryable
    // openai sometimes returns 404 for models that are actually available,
    // but model_not_found errors should not be retried
    if (status === 404) {
      try {
        const body = JSON.parse(e.responseBody ?? "")
        if (body?.error?.code === "model_not_found") return false
      } catch {}
      return true
    }
    return e.isRetryable
  }

  export function fromError(e: unknown, ctx: { providerID: string }) {
    switch (true) {
      case e instanceof DOMException && e.name === "AbortError":
        return new MessageV2.AbortedError(
          { message: e.message },
          {
            cause: e,
          },
        ).toObject()
      case MessageV2.OutputLengthError.isInstance(e):
        return e
      case LoadAPIKeyError.isInstance(e):
        return new MessageV2.AuthError(
          {
            providerID: ctx.providerID,
            message: e.message,
          },
          { cause: e },
        ).toObject()
      case (e as SystemError)?.code === "ECONNRESET":
        return new MessageV2.APIError(
          {
            message: "Connection reset by server",
            isRetryable: true,
            metadata: {
              code: (e as SystemError).code ?? "",
              syscall: (e as SystemError).syscall ?? "",
              message: (e as SystemError).message ?? "",
            },
          },
          { cause: e },
        ).toObject()
      case APICallError.isInstance(e):
        const message = iife(() => {
          let msg = e.message
          if (msg === "") {
            if (e.responseBody) return e.responseBody
            if (e.statusCode) {
              const err = STATUS_CODES[e.statusCode]
              if (err) return err
            }
            return "Unknown error"
          }
          const transformed = ProviderTransform.error(ctx.providerID, e)
          if (transformed !== msg) {
            return transformed
          }
          if (!e.responseBody || (e.statusCode && msg !== STATUS_CODES[e.statusCode])) {
            return msg
          }

          try {
            const body = JSON.parse(e.responseBody)
            // try to extract common error message fields
            const errMsg = body.message || body.error || body.error?.message
            if (errMsg && typeof errMsg === "string") {
              return `${msg}: ${errMsg}`
            }
          } catch {}

          return `${msg}: ${e.responseBody}`
        }).trim()

        const metadata = e.url ? { url: e.url } : undefined
        return new MessageV2.APIError(
          {
            message,
            statusCode: e.statusCode,
            isRetryable: ctx.providerID.startsWith("openai") ? isOpenAiErrorRetryable(e) : e.isRetryable,
            responseHeaders: e.responseHeaders,
            responseBody: e.responseBody,
            metadata,
          },
          { cause: e },
        ).toObject()
      case e instanceof Error:
        return new NamedError.Unknown({ message: e.toString() }, { cause: e }).toObject()
      default:
        return new NamedError.Unknown({ message: JSON.stringify(e) }, { cause: e })
    }
  }
}

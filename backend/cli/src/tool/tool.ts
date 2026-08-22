import z from "zod"
import type { MessageV2 } from "../session/message-v2"
import type { Agent } from "../agent/agent"
import type { PermissionNext } from "../permission/next"
import { Truncate } from "./truncation"
import { PlanMode } from "./plan-mode"
import { SearchDedupe } from "@/session/search-dedupe"

export namespace Tool {
  interface Metadata {
    [key: string]: any
  }

  export interface InitContext {
    agent?: Agent.Info
    model?: {
      providerID: string
      modelID: string
    }
  }

  export type Context<M extends Metadata = Metadata> = {
    sessionID: string
    messageID: string
    agent: string
    abort: AbortSignal
    callID?: string
    extra?: { [key: string]: any }
    messages: MessageV2.WithParts[]
    metadata(input: { title?: string; metadata?: M }): void
    ask(input: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">): Promise<void>
  }
  export interface Info<Parameters extends z.ZodType = z.ZodType, M extends Metadata = Metadata> {
    id: string
    init: (ctx?: InitContext) => Promise<{
      description: string
      parameters: Parameters
      execute(
        args: z.infer<Parameters>,
        ctx: Context,
      ): Promise<{
        title: string
        metadata: M
        output: string
        attachments?: MessageV2.FilePart[]
      }>
      normalizeInput?(args: unknown): unknown
      formatValidationError?(error: z.ZodError, args: unknown): string
    }>
  }

  export type InferParameters<T extends Info> = T extends Info<infer P> ? z.infer<P> : never
  export type InferMetadata<T extends Info> = T extends Info<any, infer M> ? M : never

  export type Contract<Parameters extends z.ZodType = z.ZodType> = {
    parameters: Parameters
    normalizeInput?(args: unknown): unknown
    formatValidationError?(error: z.ZodError, args: unknown): string
  }

  /**
   * Validate a model tool call with the same normalization and Zod contract
   * used by execute(). JSON Schema alone is only a provider hint; the AI SDK
   * cannot repair malformed calls unless its schema also has a runtime
   * validator. Keep this result in the provider boundary as well as execute()
   * so an incomplete call is repaired before any tool starts.
   */
  export function validate<Parameters extends z.ZodType>(
    id: string,
    contract: Contract<Parameters>,
    args: unknown,
  ): { success: true; value: z.infer<Parameters> } | { success: false; error: Error } {
    const normalized = contract.normalizeInput ? contract.normalizeInput(args) : args
    const result = contract.parameters.safeParse(normalized)
    if (result.success) {
      return {
        success: true,
        value: result.data,
      }
    }
    const message = contract.formatValidationError
      ? contract.formatValidationError(result.error, normalized)
      : `The ${id} tool received invalid arguments or incomplete input. No action was taken. Retry with all required fields.`
    return {
      success: false,
      error: new Error(message, { cause: result.error }),
    }
  }

  export function define<Parameters extends z.ZodType, Result extends Metadata>(
    id: string,
    init: Info<Parameters, Result>["init"] | Awaited<ReturnType<Info<Parameters, Result>["init"]>>,
  ): Info<Parameters, Result> {
    return {
      id,
      init: async (initCtx) => {
        const toolInfo = init instanceof Function ? await init(initCtx) : init
        const execute = toolInfo.execute
        toolInfo.execute = async (args, ctx) => {
          PlanMode.enforce(id, ctx.agent)
          // The parser's output is the public tool contract. Always execute
          // and dedupe with it so defaults, transforms, stripped fields, and
          // tool-specific normalization behave identically for direct and
          // delegated calls.
          const parsed = validate(id, toolInfo, args)
          if (!parsed.success) throw parsed.error
          const canonical = parsed.value
          const dedupeSignature = SearchDedupe.key(id, canonical)
          const cached = SearchDedupe.find(ctx.messages, id, canonical)
          if (cached) return SearchDedupe.reuse(cached) as unknown as Awaited<ReturnType<typeof execute>>
          const result = await execute(canonical, ctx)
          const metadata = dedupeSignature ? { ...result.metadata, dedupeSignature } : result.metadata
          // skip truncation for tools that handle it themselves
          if (result.metadata.truncated !== undefined) {
            return { ...result, metadata }
          }
          const truncated = await Truncate.output(result.output, { sessionID: ctx.sessionID }, initCtx?.agent)
          return {
            ...result,
            output: truncated.content,
            metadata: {
              ...metadata,
              truncated: truncated.truncated,
              ...(truncated.truncated && { outputPath: truncated.outputPath }),
            },
          }
        }
        return toolInfo
      },
    }
  }
}

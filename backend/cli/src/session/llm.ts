import { Installation } from "@/installation"
import { Provider } from "@/provider/provider"
import { Log } from "@/util/log"
import {
  streamText,
  wrapLanguageModel,
  type ModelMessage,
  type StreamTextResult,
  type Tool,
  type ToolSet,
  tool,
  jsonSchema,
  type ToolCallRepairFunction,
} from "ai"
import { safeParseJSON } from "@ai-sdk/provider-utils"
import { clone, mergeDeep } from "remeda"
import { ProviderTransform } from "@/provider/transform"
import { Instance } from "@/project/instance"
import type { Agent } from "@/agent/agent"
import type { MessageV2 } from "./message-v2"
import { Plugin } from "@/plugin"
import { SystemPrompt } from "./system"
import { Flag } from "@/flag/flag"
import { Auth } from "@/auth"
import { SessionHarness } from "./harness"
import { SessionTraceStore } from "./trace-store"
import { ToolVisibility } from "@/tool/visibility"
import { InvalidCall } from "@/tool/invalid-call"
import { resolveAccessRoute } from "./access-route"
import { providerErrorMetadata } from "./provider-error"
import { Toolset } from "./toolset"
import { UsageLogging } from "./usage-logging"

export namespace LLM {
  const log = Log.create({ service: "llm" })

  export const OUTPUT_TOKEN_MAX = Flag.OPENSCIENCE_EXPERIMENTAL_OUTPUT_TOKEN_MAX || 32_000

  export type StreamInput = {
    user: MessageV2.User
    sessionID: string
    model: Provider.Model
    agent: Agent.Info
    system: string[]
    abort: AbortSignal
    messages: ModelMessage[]
    small?: boolean
    tools: Record<string, Tool>
    /** Offer the tools (they are part of the cached prefix) but forbid calling
     * them, for a request that must answer in text. */
    toolChoice?: "none"
    retries?: number
    trace?: { messageID: string; attempt: number }
    route?: string
    onReasoningEffortResolved?: (effort: string | undefined) => void | Promise<void>
    /** Response headers arrived for a provider stream request; the body may
     * still be a keepalive-only prefix, so this is not first output. */
    onResponse?: () => void
  }

  export type StreamOutput = StreamTextResult<ToolSet, unknown>

  // Share the exact header selection with context preflight. An agent with a
  // prompt of its own replaces the model-family header. Codex sends the header
  // through `instructions`, separately from the assembled conversation
  // context, so the header never appears twice on that route.
  export function prompts(input: Pick<StreamInput, "agent" | "model">, codex = false) {
    const header = SystemPrompt.provider(input.model)
    if (!codex) return { system: input.agent.prompt ? [input.agent.prompt] : header, instructions: undefined }
    // A primary agent's own prompt is its header and travels in the
    // instructions slot; a worker's contract stays in context beneath the
    // family header so the header never appears twice.
    if (input.agent.prompt && input.agent.mode !== "subagent") return { system: [], instructions: input.agent.prompt }
    return { system: input.agent.prompt ? [input.agent.prompt] : [], instructions: header.join("\n") }
  }

  export async function repairToolCall(failed: Parameters<ToolCallRepairFunction<ToolSet>>[0], tools: ToolSet) {
    const source = InvalidCall.tool(failed.toolCall.toolName)
    const name = tools[failed.toolCall.toolName] ? failed.toolCall.toolName : tools[source] ? source : undefined
    if (name) {
      const parsed = await safeParseJSON({
        text: failed.toolCall.input,
        schema: tools[name].inputSchema,
      })
      if (parsed.success) {
        return {
          ...failed.toolCall,
          toolName: name,
        }
      }
    }
    const reason = name ? "invalid_input" : "unknown_tool"
    return {
      ...failed.toolCall,
      input: JSON.stringify(InvalidCall.payload(name ?? source, reason)),
      toolName: "invalid",
    }
  }

  export async function stream(input: StreamInput) {
    const tier = input.small
      ? { model: undefined, options: {}, headers: {} }
      : ProviderTransform.tier(input.model, input.user.tier)
    const routed = tier.model ? await Provider.getModel(input.model.providerID, tier.model) : input.model
    const traceRoute = input.route ?? (await resolveAccessRoute(routed.providerID, routed.id))
    // A per-stream copy: the shared "llm" logger is never tagged, so a title
    // stream and a research stream running at once cannot relabel each other.
    const l = log.child({
      providerID: input.model.providerID,
      modelID: input.model.id,
      sessionID: input.sessionID,
      small: (input.small ?? false).toString(),
      agent: input.agent.name,
      mode: input.agent.mode,
    })
    l.info("stream", {
      modelID: input.model.id,
      providerID: input.model.providerID,
    })
    const [language, provider, auth] = await Promise.all([
      Provider.getLanguage(routed),
      Provider.getProvider(input.model.providerID),
      Auth.get(input.model.providerID),
    ])
    const isCodex = isCodexSubscriptionModel(input.model, auth)
    const prompt = prompts(input, isCodex)

    const system = []
    system.push(
      [
        ...prompt.system,
        // any custom prompt passed into this call
        ...input.system,
        // any custom prompt from last user message
        ...(input.user.system ? [input.user.system] : []),
      ]
        .filter((x) => x)
        .join("\n"),
    )

    const header = system[0]
    const original = clone(system)
    await Plugin.trigger(
      "experimental.chat.system.transform",
      { sessionID: input.sessionID, model: input.model },
      { system },
    )
    if (system.length === 0) {
      system.push(...original)
    }
    // rejoin to maintain 2-part structure for caching if header unchanged
    if (system.length > 2 && system[0] === header) {
      const rest = system.slice(1)
      system.length = 0
      system.push(header, rest.join("\n"))
    }

    const chosen = input.user.variant
    const variant = !input.small && input.model.variants && chosen ? input.model.variants[chosen] : {}
    const base = input.small
      ? ProviderTransform.smallOptions(input.model)
      : ProviderTransform.options({
          model: input.model,
          sessionID: input.sessionID,
          providerOptions: provider.options,
        })
    // Keeping five deeply inferred Remeda pipe stages here can exceed
    // TypeScript's instantiation limit as provider option unions grow. The
    // runtime operation is a straightforward left-to-right deep merge.
    const options = [input.model.options, tier.options, input.agent.options, variant].reduce<Record<string, any>>(
      (result, layer) => mergeDeep(result, layer ?? {}) as Record<string, any>,
      base as Record<string, any>,
    )
    if (isCodex) {
      options.instructions = prompt.instructions
    }

    const params = await Plugin.trigger(
      "chat.params",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        temperature: input.model.capabilities.temperature
          ? (input.agent.temperature ?? ProviderTransform.temperature(input.model))
          : undefined,
        topP: input.agent.topP ?? ProviderTransform.topP(input.model),
        topK: ProviderTransform.topK(input.model),
        options,
      },
    )

    const { headers } = await Plugin.trigger(
      "chat.headers",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        provider,
        message: input.user,
      },
      {
        headers: {},
      },
    )

    await input.onReasoningEffortResolved?.(resolvedReasoningEffort(params.options))

    const maxOutputTokens = isCodex
      ? undefined
      : ProviderTransform.maxOutputTokens(
          input.model.api.npm,
          params.options,
          input.model.limit.output,
          OUTPUT_TOKEN_MAX,
        )

    const tools = await modelTools(input)

    // LiteLLM and some Anthropic proxies require the tools parameter to be present
    // when message history contains tool calls, even if no tools are being used.
    // Add a dummy tool that is never called to satisfy this validation.
    // This is enabled for:
    // 1. Providers with "litellm" in their ID or API ID (auto-detected)
    // 2. Providers with explicit "litellmProxy: true" option (opt-in for custom gateways)
    const isLiteLLMProxy =
      provider.options?.["litellmProxy"] === true ||
      input.model.providerID.toLowerCase().includes("litellm") ||
      input.model.api.id.toLowerCase().includes("litellm")

    if (isLiteLLMProxy && Object.keys(tools).length === 0 && hasToolCalls(input.messages)) {
      tools["_noop"] = tool({
        description:
          "Placeholder for LiteLLM/Anthropic proxy compatibility - required when message history contains tool calls but no active tools are needed",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => ({ output: "", title: "", metadata: {} }),
      })
    }

    const trace = input.trace
    const activeTools = Toolset.active(tools)
    // A change in the offered tools is announced by the loop as a durable
    // message in the transcript, never as a system line for one request: a
    // line that appears on the step of the change and vanishes on the next
    // rewrote the cached system prompt twice per skill load.
    const harness = trace
      ? SessionHarness.snapshot({
          agent: input.agent,
          provider: routed.providerID,
          model: routed.id,
          system,
          instructions: typeof params.options.instructions === "string" ? params.options.instructions : undefined,
          tools,
        })
          .then((snapshot) =>
            SessionTraceStore.recordHarness({
              sessionID: input.sessionID,
              messageID: trace.messageID,
              parentMessageID: input.user.id,
              attempt: trace.attempt,
              snapshot,
            }),
          )
          .catch((error) => l.warn("failed to record harness fingerprint", { error }))
      : undefined

    const providerMessages: ModelMessage[] = [
      ...(isCodex
        ? [
            {
              role: "user" as const,
              content: system.join("\n\n"),
            },
          ]
        : system.map((x): ModelMessage => ({
            role: "system",
            content: x,
          }))),
      ...input.messages,
    ]
    const logging = await UsageLogging.context().catch(() => undefined)
    const started = performance.now()
    const binding = logging
      ? {
          context: logging,
          sessionID: input.sessionID,
          messageID: input.trace?.messageID ?? input.user.id,
          route: traceRoute,
          provider: routed.providerID,
          model: routed.api.id,
          operationID: crypto.randomUUID(),
        }
      : undefined
    if (binding) UsageLogging.bind(binding)
    const partial = { text: "", reasoning: "", truncated: false }
    const capture = (kind: "model.request" | "assistant.message" | "error", payload: Record<string, unknown>) =>
      binding
        ? UsageLogging.event(binding, kind, payload).catch(() => l.warn("could not persist trace record"))
        : undefined
    const result = streamText({
      onChunk({ chunk }) {
        if (!binding || (chunk.type !== "text-delta" && chunk.type !== "reasoning-delta")) return
        const field = chunk.type === "text-delta" ? "text" : "reasoning"
        const remaining = Math.max(0, 128 * 1024 - partial[field].length)
        partial[field] += chunk.text.slice(0, remaining)
        if (chunk.text.length > remaining) partial.truncated = true
      },
      async onAbort() {
        await capture("assistant.message", { ...partial, interrupted: true })
      },
      async onStepFinish(step) {
        if (!binding) return
        await UsageLogging.record({
          ...binding,
          usage: step.usage,
          metadata: step.providerMetadata,
          duration: performance.now() - started,
          content: { parts: step.content, toolResults: step.toolResults },
          finish: step.finishReason,
        }).catch(() => l.warn("could not persist usage record"))
      },
      async onError(error) {
        l.error("stream error", providerErrorMetadata(error))
        await capture("error", { error: error.error, partial })
      },
      async experimental_repairToolCall(failed) {
        const repaired = await repairToolCall(failed, tools)
        if (repaired.toolName !== "invalid") {
          l.info("repairing tool call", {
            tool: failed.toolCall.toolName,
            repaired: repaired.toolName,
          })
          return repaired
        }
        l.warn("replacing invalid tool call", {
          tool: InvalidCall.tool(failed.toolCall.toolName),
          failure: JSON.parse(repaired.input).failure,
        })
        return repaired
      },
      temperature: params.temperature,
      topP: params.topP,
      topK: params.topK,
      providerOptions: ProviderTransform.providerOptions(input.model, params.options),
      activeTools,
      tools,
      ...(input.toolChoice ? { toolChoice: input.toolChoice } : {}),
      maxOutputTokens,
      abortSignal: input.abort,
      headers: {
        ...(routed.providerID === "openrouter" && traceRoute === "managed"
          ? {
              "x-openscience-project": Instance.project.id,
              "x-openscience-session": input.sessionID,
              "x-openscience-request": input.user.id,
              "x-openscience-client": Flag.OPENSCIENCE_CLIENT,
            }
          : input.model.providerID !== "anthropic"
            ? {
                "User-Agent": `openscience/${Installation.VERSION}`,
              }
            : undefined),
        ...input.model.headers,
        ...tier.headers,
        ...headers,
      },
      maxRetries: input.retries ?? 0,
      messages: providerMessages,
      model: wrapLanguageModel({
        model: language,
        middleware: [
          {
            async transformParams(args) {
              // Apply for both stream and generate: message normalization does
              // caching, image-mime correction, unsupported-part downgrade, and
              // the providerOptions remap. Gating on "stream" only meant any
              // non-stream call (structured output, a provider that internally
              // does doGenerate) would bypass all of it and could crash on an
              // unsupported file part.
              if (args.type === "stream" || args.type === "generate") {
                // @ts-expect-error
                args.params.prompt = ProviderTransform.message(args.params.prompt, input.model, options)
              }
              return args.params
            },
            async wrapStream(args) {
              await capture("model.request", {
                attempt: input.trace?.attempt,
                messages: args.params.prompt,
                tools: args.params.tools,
                parameters: {
                  providerOptions: args.params.providerOptions,
                  maxOutputTokens: args.params.maxOutputTokens,
                  temperature: args.params.temperature,
                  topP: args.params.topP,
                  topK: args.params.topK,
                  presencePenalty: args.params.presencePenalty,
                  frequencyPenalty: args.params.frequencyPenalty,
                  stopSequences: args.params.stopSequences,
                  toolChoice: args.params.toolChoice,
                  responseFormat: args.params.responseFormat,
                },
              })
              // doStream settles when the response headers arrive, before any
              // body chunk is read: the exact "waiting for first token" edge.
              const result = await args.doStream()
              input.onResponse?.()
              return result
            },
          },
        ],
      }),
      experimental_telemetry: {
        isEnabled: false,
        recordInputs: false,
        recordOutputs: false,
      },
    })
    await harness
    return result
  }

  export async function modelTools(input: Pick<StreamInput, "tools" | "agent" | "model" | "user">) {
    if (!input.model.capabilities.toolcall) return {}
    return resolveTools(input)
  }

  /** Read only named controls from the final provider options. Numeric token
   * budgets deliberately stay unlabeled: inferring low/high from a budget
   * would make telemetry provider- and model-dependent rather than truthful. */
  export function resolvedReasoningEffort(options: Record<string, any>): string | undefined {
    const value = (input: unknown) => (typeof input === "string" && input.length > 0 ? input : undefined)
    const object = (input: unknown) =>
      input !== null && typeof input === "object" && !Array.isArray(input)
        ? (input as Record<string, unknown>)
        : undefined
    const reasoning = object(options.reasoning)
    const reasoningConfig = object(options.reasoningConfig)
    const thinkingConfig = object(options.thinkingConfig)
    return (
      value(options.reasoningEffort) ??
      value(options.effort) ??
      value(reasoning?.effort) ??
      value(reasoningConfig?.maxReasoningEffort) ??
      value(thinkingConfig?.thinkingLevel)
    )
  }

  async function resolveTools(input: Pick<StreamInput, "tools" | "agent" | "user">) {
    for (const tool of Object.keys(input.tools)) {
      if (!ToolVisibility.enabled(tool, { permission: input.agent.permission, tools: input.user.tools }))
        delete input.tools[tool]
    }
    return input.tools
  }

  // Check if messages contain any tool-call content
  // Used to determine if a dummy tool should be added for LiteLLM proxy compatibility
  export function hasToolCalls(messages: ModelMessage[]): boolean {
    for (const msg of messages) {
      if (!Array.isArray(msg.content)) continue
      for (const part of msg.content) {
        if (part.type === "tool-call" || part.type === "tool-result") return true
      }
    }
    return false
  }

  export function isCodexSubscriptionModel(
    model: Pick<Provider.Model, "providerID">,
    auth?: Pick<Auth.Info, "type">,
  ): boolean {
    return model.providerID === "openai-codex" && auth?.type === "oauth"
  }
}

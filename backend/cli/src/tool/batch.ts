import z from "zod"
import { Tool } from "./tool"
import DESCRIPTION from "./batch.txt"
import { InvalidCall } from "./invalid-call"
import { InvalidTool } from "./invalid"

const DISALLOWED = new Set(["batch"])

const BatchParameters = z.object({
  tool_calls: z
    .array(
      z.object({
        tool: z.string().describe("The name of the tool to execute"),
        parameters: z.object({}).loose().describe("Parameters for the tool"),
      }),
    )
    .min(1, "Provide at least one tool call")
    .describe("Array of tool calls to execute in parallel"),
})

export const BatchTool = Tool.define<typeof BatchParameters, Record<string, unknown>>("batch", async (initCtx) => {
  return {
    description: DESCRIPTION,
    parameters: BatchParameters,
    formatValidationError(error) {
      const formattedErrors = error.issues
        .map((issue) => {
          const path = issue.path.length > 0 ? issue.path.join(".") : "root"
          return `  - ${path}: ${issue.message}`
        })
        .join("\n")

      return `Invalid parameters for tool 'batch':\n${formattedErrors}\n\nExpected payload format:\n  [{"tool": "tool_name", "parameters": {...}}, {...}]`
    },
    async execute(params, ctx) {
      const { Session } = await import("../session")
      const { Identifier } = await import("../id/id")

      const toolCalls = params.tool_calls.slice(0, 25)
      const discardedCalls = params.tool_calls.slice(25)

      const { ToolRegistry } = await import("./registry")
      const model = initCtx?.model ?? { modelID: "", providerID: "" }
      const availableTools = await ToolRegistry.tools(model, initCtx?.agent)
      const toolMap = new Map(availableTools.map((t) => [t.id, t]))
      const aliases = new Set(["notebook", "rkernel", "websearch"])

      const prepared = await Promise.all(
        toolCalls.map(async (call) => {
          const name = InvalidCall.tool(call.tool)
          if (DISALLOWED.has(name)) return { type: "disallowed" as const, call: { ...call, tool: name } }
          if (name === "invalid") {
            return {
              type: "invalid" as const,
              call,
              payload: InvalidCall.payload("batch", "invalid_input"),
            }
          }
          const tool =
            toolMap.get(call.tool) ??
            toolMap.get(name) ??
            (aliases.has(name) ? await ToolRegistry.resolve(name, model, initCtx?.agent) : undefined)
          if (!tool) {
            return {
              type: "invalid" as const,
              call,
              payload: InvalidCall.payload(name, "unknown_tool"),
            }
          }
          const parsed = Tool.validate(tool.id, tool, call.parameters)
          if (!parsed.success) {
            return {
              type: "invalid" as const,
              call,
              payload: InvalidCall.payload(tool.id, "invalid_input"),
            }
          }
          return {
            type: "ready" as const,
            call: { ...call, tool: tool.id },
            tool,
          }
        }),
      )

      const history = await Session.messages({ sessionID: ctx.sessionID })
      const current = history.find((message) => message.info.id === ctx.messageID)
      const { SessionProcessor } = await import("../session/processor")
      const parts =
        current?.info.role === "assistant"
          ? SessionProcessor.turnParts(history, current.info.parentID)
          : ctx.messages.flatMap((message) => message.parts)
      const invalid = await InvalidTool.init({ agent: initCtx?.agent, model })
      const recovered = [] as Array<{
        success: false
        tool: string
        error: Error
      }>

      for (const item of prepared) {
        if (item.type !== "invalid") continue
        const now = Date.now()
        const partID = Identifier.ascending("part")
        const result = await invalid.execute(item.payload, { ...ctx, callID: partID })
        const part = await Session.updatePart({
          id: partID,
          messageID: ctx.messageID,
          sessionID: ctx.sessionID,
          type: "tool",
          tool: "invalid",
          callID: partID,
          state: {
            status: "completed",
            input: item.payload,
            output: result.output,
            title: result.title,
            metadata: result.metadata,
            attachments: result.attachments,
            time: { start: now, end: Date.now() },
          },
        })
        parts.push(part)
        recovered.push({ success: false, tool: item.payload.tool, error: new Error(item.payload.error) })
        if (SessionProcessor.isMalformedLoop(parts, item.payload)) {
          throw new InvalidCall.RepeatedError(item.payload.tool)
        }
      }

      const executeCall = async (item: Exclude<(typeof prepared)[number], { type: "invalid" }>) => {
        const callStartTime = Date.now()
        const partID = Identifier.ascending("part")
        const call = item.call
        const parameters = call.parameters as Record<string, unknown>

        try {
          if (item.type === "disallowed") {
            throw new Error(
              `Tool '${call.tool}' is not allowed in batch. Disallowed tools: ${Array.from(DISALLOWED).join(", ")}`,
            )
          }
          await Session.updatePart({
            id: partID,
            messageID: ctx.messageID,
            sessionID: ctx.sessionID,
            type: "tool",
            tool: call.tool,
            callID: partID,
            state: {
              status: "running",
              input: parameters,
              time: {
                start: callStartTime,
              },
            },
          })

          const result = await item.tool.execute(parameters, { ...ctx, callID: partID })

          await Session.updatePart({
            id: partID,
            messageID: ctx.messageID,
            sessionID: ctx.sessionID,
            type: "tool",
            tool: call.tool,
            callID: partID,
            state: {
              status: "completed",
              input: parameters,
              output: result.output,
              title: result.title,
              metadata: result.metadata,
              attachments: result.attachments,
              time: {
                start: callStartTime,
                end: Date.now(),
              },
            },
          })

          return { success: true as const, tool: call.tool, result }
        } catch (error) {
          await Session.updatePart({
            id: partID,
            messageID: ctx.messageID,
            sessionID: ctx.sessionID,
            type: "tool",
            tool: call.tool,
            callID: partID,
            state: {
              status: "error",
              input: parameters,
              error: error instanceof Error ? error.message : String(error),
              time: {
                start: callStartTime,
                end: Date.now(),
              },
            },
          })

          return { success: false as const, tool: call.tool, error }
        }
      }

      const runnable = prepared.filter(
        (item): item is Exclude<typeof item, { type: "invalid" }> => item.type !== "invalid",
      )
      const results = [...recovered, ...(await Promise.all(runnable.map((item) => executeCall(item))))]

      // Add discarded calls as errors
      const now = Date.now()
      for (const call of discardedCalls) {
        const partID = Identifier.ascending("part")
        const name = InvalidCall.tool(call.tool)
        await Session.updatePart({
          id: partID,
          messageID: ctx.messageID,
          sessionID: ctx.sessionID,
          type: "tool",
          tool: name,
          callID: partID,
          state: {
            status: "error",
            input: {},
            error: "Maximum of 25 tools allowed in batch",
            time: { start: now, end: now },
          },
        })
        results.push({
          success: false as const,
          tool: name,
          error: new Error("Maximum of 25 tools allowed in batch"),
        })
      }

      const successfulCalls = results.filter((r) => r.success).length
      const failedCalls = results.length - successfulCalls

      const outputMessage =
        failedCalls > 0
          ? `Executed ${successfulCalls}/${results.length} tools successfully. ${failedCalls} failed.`
          : `All ${successfulCalls} tools executed successfully.\n\nKeep using the batch tool for optimal performance in your next response!`

      return {
        title: `Batch execution (${successfulCalls}/${results.length} successful)`,
        output: outputMessage,
        attachments: results.filter((result) => result.success).flatMap((r) => r.result.attachments ?? []),
        metadata: {
          totalCalls: results.length,
          successful: successfulCalls,
          failed: failedCalls,
          tools: params.tool_calls.map((call) => InvalidCall.tool(call.tool)),
          details: results.map((r) => ({ tool: r.tool, success: r.success })),
        },
      }
    },
  }
})

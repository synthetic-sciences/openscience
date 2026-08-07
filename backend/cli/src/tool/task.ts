import { Tool } from "./tool"
import DESCRIPTION from "./task.txt"
import z from "zod"
import { Session } from "../session"
import { Bus } from "../bus"
import { MessageV2 } from "../session/message-v2"
import { Identifier } from "../id/id"
import { Agent } from "../agent/agent"
import { SessionPrompt } from "../session/prompt"
import { iife } from "@/util/iife"
import { defer } from "@/util/defer"
import { Config } from "../config/config"
import { PermissionNext } from "@/permission/next"
import { RLMState } from "../session/rlm/state"
import { HierarchicalSemaphore } from "../util/semaphore"

const ARTIFACT_AGENTS = ["research", "biology", "ml"]
const COMPUTE_SUBAGENTS = new Set(["biology", "ml", "physics"])
export const MAX_CHILD_AGENTS = 2
const childSlots = new HierarchicalSemaphore(MAX_CHILD_AGENTS)
const configuredComputeCap = Number(process.env.OPENSCIENCE_MAX_COMPUTE_SUBAGENTS)
const MAX_COMPUTE_SUBAGENTS =
  Number.isFinite(configuredComputeCap) && configuredComputeCap >= 1 ? Math.floor(configuredComputeCap) : 2
const computeSlots = new HierarchicalSemaphore(MAX_COMPUTE_SUBAGENTS)

const parameters = z.object({
  description: z.string().describe("A short (3-5 words) description of the task"),
  prompt: z.string().describe("The task for the agent to perform"),
  subagent_type: z.string().describe("The type of specialized agent to use for this task"),
  session_id: z.string().describe("Existing Task session to continue").optional(),
  command: z.string().describe("The command that triggered this task").optional(),
})

export const TaskTool = Tool.define("task", async (ctx) => {
  const agents = await Agent.list().then((x) => x.filter((a) => a.mode !== "primary"))

  // Filter agents by permissions if agent provided
  const caller = ctx?.agent
  const accessibleAgents = caller
    ? agents.filter((a) => PermissionNext.evaluate("task", a.name, caller.permission).action !== "deny")
    : agents

  const description = DESCRIPTION.replace(
    "{agents}",
    accessibleAgents
      .map((a) => `- ${a.name}: ${a.description ?? "This subagent should only be called manually by the user."}`)
      .join("\n"),
  )
  return {
    description,
    parameters,
    async execute(params: z.infer<typeof parameters>, ctx) {
      const config = await Config.get()
      const started = Date.now()

      // Skip permission check when user explicitly invoked via @ or command subtask
      if (!ctx.extra?.bypassAgentCheck) {
        await ctx.ask({
          permission: "task",
          patterns: [params.subagent_type],
          always: ["*"],
          metadata: {
            description: params.description,
            subagent_type: params.subagent_type,
          },
        })
      }

      const agent = await Agent.get(params.subagent_type)
      if (!agent) throw new Error(`Unknown agent type: ${params.subagent_type} is not a valid agent type`)

      const hasTaskPermission = agent.permission.some((rule) => rule.permission === "task")

      const session = await iife(async () => {
        if (params.session_id) {
          const found = await Session.get(params.session_id).catch((error) => {
            if (Session.DirectoryMismatchError.isInstance(error)) throw error
          })
          if (found) return found
        }

        return await Session.create({
          parentID: ctx.sessionID,
          title: params.description + ` (@${agent.name} subagent)`,
          permission: [
            {
              permission: "todowrite",
              pattern: "*",
              action: "deny",
            },
            {
              permission: "todoread",
              pattern: "*",
              action: "deny",
            },
            ...(hasTaskPermission
              ? []
              : [
                  {
                    permission: "task" as const,
                    pattern: "*" as const,
                    action: "deny" as const,
                  },
                ]),
            ...(config.experimental?.primary_tools?.map((t) => ({
              pattern: "*",
              action: "allow" as const,
              permission: t,
            })) ?? []),
          ],
        })
      })

      // Child work is exceptional and bounded. The hierarchical lease prevents
      // nested agents from bypassing the global ceiling or deadlocking while
      // their parent waits for them.
      const releaseChildSlot = await childSlots.acquire(session.id, { parent: ctx.sessionID, signal: ctx.abort })
      using _childSlot = defer(() => releaseChildSlot())

      // A nested compute agent takes over its waiting parent's permit. Parallel
      // nested siblings serialize on that lease, so nesting cannot bypass the
      // global cap and a full pool cannot deadlock on permits held by parents.
      const releaseComputeSlot = COMPUTE_SUBAGENTS.has(agent.name)
        ? await computeSlots.acquire(session.id, { parent: ctx.sessionID, signal: ctx.abort })
        : undefined
      using _computeSlot = defer(() => releaseComputeSlot?.())

      const msg = await MessageV2.get({ sessionID: ctx.sessionID, messageID: ctx.messageID })
      if (msg.info.role !== "assistant") throw new Error("Not an assistant message")

      const model = await (async () => {
        if (agent.model) return agent.model
        const assistant = msg.info as MessageV2.Assistant
        return { modelID: assistant.modelID, providerID: assistant.providerID }
      })()

      ctx.metadata({
        title: params.description,
        metadata: {
          sessionId: session.id,
          model,
          startedAt: started,
          maxConcurrentChildren: MAX_CHILD_AGENTS,
        },
      })

      const messageID = Identifier.ascending("message")
      const parts: Record<string, { id: string; tool: string; state: { status: string; title?: string } }> = {}
      const unsub = Bus.subscribe(MessageV2.Event.PartUpdated, async (evt) => {
        if (evt.properties.part.sessionID !== session.id) return
        if (evt.properties.part.messageID === messageID) return
        if (evt.properties.part.type !== "tool") return
        const part = evt.properties.part
        parts[part.id] = {
          id: part.id,
          tool: part.tool,
          state: {
            status: part.state.status,
            title: part.state.status === "completed" ? part.state.title : undefined,
          },
        }
        ctx.metadata({
          title: params.description,
          metadata: {
            summary: Object.values(parts).sort((a, b) => a.id.localeCompare(b.id)),
            sessionId: session.id,
            model,
            startedAt: started,
            elapsedMs: Date.now() - started,
            maxConcurrentChildren: MAX_CHILD_AGENTS,
          },
        })
      })

      function cancel() {
        SessionPrompt.cancel(session.id)
      }
      ctx.abort.addEventListener("abort", cancel)
      using _ = defer(() => ctx.abort.removeEventListener("abort", cancel))
      const promptParts = await SessionPrompt.resolvePromptParts(params.prompt)

      const result = await SessionPrompt.prompt({
        messageID,
        sessionID: session.id,
        model: {
          modelID: model.modelID,
          providerID: model.providerID,
        },
        agent: agent.name,
        tools: {
          todowrite: false,
          todoread: false,
          ...(hasTaskPermission ? {} : { task: false }),
          ...Object.fromEntries((config.experimental?.primary_tools ?? []).map((t) => [t, false])),
        },
        parts: promptParts,
      }).finally(() => {
        unsub()
      })

      const messages = await Session.messages({ sessionID: session.id })
      const summary = messages
        .filter((x) => x.info.role === "assistant")
        .flatMap((msg) => msg.parts.filter((part): part is MessageV2.ToolPart => part.type === "tool"))
        .map((part) => ({
          id: part.id,
          tool: part.tool,
          state: {
            status: part.state.status,
            title: part.state.status === "completed" ? part.state.title : undefined,
          },
        }))
      const usage = messages.reduce(
        (total, message) => {
          if (message.info.role !== "assistant") return total
          total.cost += message.info.cost
          total.tokens.input += message.info.tokens.input
          total.tokens.output += message.info.tokens.output
          total.tokens.cache.read += message.info.tokens.cache.read
          total.tokens.cache.write += message.info.tokens.cache.write
          return total
        },
        {
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            cache: { read: 0, write: 0 },
          },
        },
      )
      const text = result.parts.findLast((x) => x.type === "text")?.text ?? ""

      const callingAgent = msg.info.agent
      const useStructuredOutput = callingAgent && ARTIFACT_AGENTS.includes(callingAgent)

      const output = (() => {
        if (!useStructuredOutput) {
          return text + "\n\n" + ["<task_metadata>", `session_id: ${session.id}`, "</task_metadata>"].join("\n")
        }
        const compressed = RLMState.parseExecutorOutput(text)
        return [
          "<task_result>",
          `<status>${compressed.status}</status>`,
          `<findings>${JSON.stringify(compressed.findings)}</findings>`,
          `<failures>${JSON.stringify(compressed.failures)}</failures>`,
          `<assumptions>${JSON.stringify(compressed.assumptions)}</assumptions>`,
          `<parameters>${JSON.stringify(compressed.parameters)}</parameters>`,
          `<artifact_refs>${JSON.stringify(compressed.artifactRefs)}</artifact_refs>`,
          `<suggestions>${JSON.stringify(compressed.suggestions)}</suggestions>`,
          "</task_result>",
          "",
          "<task_metadata>",
          `session_id: ${session.id}`,
          "</task_metadata>",
        ].join("\n")
      })()

      return {
        title: params.description,
        metadata: {
          summary,
          sessionId: session.id,
          model,
          durationMs: Date.now() - started,
          toolCalls: summary.length,
          failedToolCalls: summary.filter((part) => part.state.status === "error").length,
          usage,
          maxConcurrentChildren: MAX_CHILD_AGENTS,
        },
        output,
      }
    },
  }
})

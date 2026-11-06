import { Session } from "."
import { Instance } from "@/project/instance"
import { MessageV2 } from "./message-v2"
import { SessionPrompt } from "./prompt"
import { SubagentBudget } from "./subagent-budget"
import { SessionStatus } from "./status"
import { TaskTool } from "@/tool/task"
import { FileLease } from "@/util/file-lease"
import { PermissionNext } from "@/permission/next"
import { ProjectAccess } from "@/project/access"
import { Agent } from "@/agent/agent"
import { Log } from "@/util/log"

/** A user action creates a new durable Task call, never replays the old one. */
export namespace SubagentContinuation {
  const log = Log.create({ service: "subagent.continue" })
  export async function start(parentID: string, childID: string, key: string) {
    await Session.assertDirectory(parentID)
    await Session.assertDirectory(childID)
    const parent = await Session.get(parentID)
    const child = await Session.get(childID)
    if (child.parentID !== parentID) throw new Error("Continue the subagent from its direct parent session")
    const state = await SubagentBudget.read(childID)
    if (!state || state.worker.deleted) throw new Error("Subagent not found")
    const saved = state.pool.continuations[key]
    if (saved?.childID !== undefined && saved.childID !== childID) throw new Error("Continuation key conflict")
    if (saved?.completed) return { sessionID: childID, callID: saved.callID }
    // Resuming under a guessed agent would silently change the child's prompt and tools.
    const subagent = state.worker.agent
    if (!subagent) throw new Error("This subagent's agent was not recorded; start a new subagent instead")
    SessionPrompt.assertNotBusy(parentID)
    SessionPrompt.assertNotBusy(childID)
    const lease = await FileLease.acquire(SessionPrompt.loopLeasePath(parent.projectID, parentID), 500)
    try {
      SessionPrompt.assertNotBusy(parentID)
      const operation = await SubagentBudget.continuation(state.pool.rootSessionID, childID, key)
      const run = async () => {
        await using held = lease
        return held.during(() =>
          SessionPrompt.withCancellation(parentID, async () => {
            const abort = SessionPrompt.activeController(parentID)!
            SessionStatus.set(parentID, { type: "busy" })
            const messages = await Session.messages({ sessionID: parentID })
            const latest = messages.findLast(
              (m): m is MessageV2.WithParts & { info: MessageV2.User } => m.info.role === "user",
            )?.info
            const agent = await Agent.get(latest?.agent ?? "research")
            if (!agent) throw new Error("The parent agent is no longer available")
            const input = {
              description: child.title,
              prompt:
                "Continue the saved task from its partial results. Complete the remaining work and return the final report.",
              task_id: childID,
              subagent_type: subagent,
              expected_output: state.worker.expectedOutput,
              allocation:
                state.worker.unit === "usd"
                  ? { usd: SubagentBudget.usd(operation.amount) }
                  : { tokens: operation.amount },
            }
            const started = Date.now()
            await Session.updateMessage({
              id: operation.userID,
              sessionID: parentID,
              role: "user",
              agent: agent.name,
              effort: latest?.effort ?? "normal",
              model: latest?.model ?? state.worker.model,
              time: { created: started },
            })
            await Session.updatePart({
              id: `${operation.partID}u`,
              messageID: operation.userID,
              sessionID: parentID,
              type: "text",
              text: `Continue subagent: ${child.title}`,
              synthetic: true,
            })
            const assistant: MessageV2.Assistant = {
              id: operation.messageID,
              sessionID: parentID,
              role: "assistant",
              parentID: operation.userID,
              agent: agent.name,
              mode: agent.name,
              modelID: state.worker.model.modelID,
              providerID: state.worker.model.providerID,
              path: { cwd: parent.directory, root: parent.directory },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              time: { created: started },
            }
            await Session.updateMessage(assistant)
            const part: MessageV2.ToolPart = {
              id: operation.partID,
              messageID: assistant.id,
              sessionID: parentID,
              type: "tool",
              tool: "task",
              callID: operation.callID,
              state: { status: "running", input, time: { start: started } },
            }
            await Session.updatePart(part)
            const updates = { pending: Promise.resolve() }
            try {
              const result = await (
                await TaskTool.init({ agent })
              ).execute(input, {
                sessionID: parentID,
                messageID: assistant.id,
                callID: operation.callID,
                agent: agent.name,
                abort,
                messages,
                extra: {
                  bypassAgentCheck: true,
                  effort: latest?.effort,
                  delegationSettings: latest?.delegationSettings,
                },
                metadata(update) {
                  updates.pending = updates.pending.then(async () => {
                    await Session.updatePart({ ...part, state: { ...part.state, ...update } })
                  })
                },
                async ask(request) {
                  await PermissionNext.ask(
                    {
                      ...request,
                      sessionID: parentID,
                      mode: (await ProjectAccess.status(Instance.project)).mode,
                      ruleset: PermissionNext.merge(agent.permission, parent.permission ?? []),
                    },
                    abort,
                  )
                },
              })
              await updates.pending
              await Session.updatePart({
                ...part,
                state: {
                  status: "completed",
                  input,
                  title: result.title,
                  output: result.output,
                  metadata: result.metadata,
                  time: { start: started, end: Date.now() },
                },
              })
            } catch (error) {
              await updates.pending.catch(() => undefined)
              await Session.updatePart({
                ...part,
                state: {
                  status: "error",
                  input,
                  error: error instanceof Error ? error.message : String(error),
                  time: { start: started, end: Date.now() },
                },
              })
            }
            await Session.updateMessage({
              ...assistant,
              finish: "stop",
              time: { created: started, completed: Date.now() },
            })
            await SubagentBudget.finishContinuation(state.pool.rootSessionID, key)
          }),
        )
      }
      void SessionPrompt.detached(run).catch((error) => log.error("subagent continuation failed", { error, childID }))
      return { sessionID: childID, callID: operation.callID }
    } catch (error) {
      await lease[Symbol.asyncDispose]()
      throw error
    }
  }
}

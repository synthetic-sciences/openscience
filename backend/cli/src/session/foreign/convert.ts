// Writes a neutral foreign conversation into an OpenScience session as
// ordinary messages and parts. Imported turns cost $0, carry no provider
// metadata (so nothing is replayed to a provider as its own signed content),
// and are stamped `claude-code/<model>` or `codex/<model>`.
import { Identifier } from "../../id/id"
import { Instance } from "../../project/instance"
import { Storage } from "../../storage/storage"
import { Session } from ".."
import { MessageV2 } from "../message-v2"
import type { ForeignAttachment, ForeignConversation, ForeignPart, ForeignSource, ForeignTurn } from "./types"
import { isCompaction } from "./types"

export namespace ForeignConvert {
  export const NO_RESULT = "(no result recorded)"

  export type CodexCompaction = {
    item: Record<string, unknown>
    summaryText: string
    keptUserMessages: string[]
  }

  const PROVIDER: Record<ForeignSource, string> = { claude: "claude-code", codex: "codex" }

  const TOOLS: Record<ForeignSource, Record<string, string>> = {
    claude: {
      Bash: "bash",
      Read: "read",
      Edit: "edit",
      Write: "write",
      Glob: "glob",
      Grep: "grep",
      TodoWrite: "todowrite",
      Task: "task",
      Agent: "task",
    },
    codex: {
      shell: "bash",
      local_shell: "bash",
      exec_command: "bash",
      update_plan: "todowrite",
    },
  }

  export function toolName(source: ForeignSource, name: string): string {
    const mapped = TOOLS[source][name]
    if (mapped) return mapped
    const clean = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64)
    return clean || "tool"
  }

  const camel = (key: string) => key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase())

  /** Reshape a source tool's input to the OpenScience tool's parameter names, for display. */
  function toolInput(source: ForeignSource, tool: string, input: Record<string, unknown>): Record<string, unknown> {
    if (tool === "todowrite") {
      const items = Array.isArray(input.todos) ? input.todos : Array.isArray(input.plan) ? input.plan : []
      return {
        todos: items.map((item, index) => {
          const value = (item ?? {}) as Record<string, unknown>
          return {
            id: String(index + 1),
            content: String(value.content ?? value.step ?? ""),
            status: String(value.status ?? "pending"),
            priority: "medium",
          }
        }),
      }
    }
    if (source === "claude" && ["read", "edit", "write", "glob", "grep"].includes(tool)) {
      return Object.fromEntries(Object.entries(input).map(([key, value]) => [camel(key), value]))
    }
    if (source === "codex" && tool === "bash") {
      const command = input.command ?? input.cmd
      if (Array.isArray(command)) {
        const parts = command.map(String)
        const shell = parts.length === 3 && /(^|\/)(ba|z)?sh$/.test(parts[0]) && parts[1].startsWith("-")
        return { ...input, command: shell ? parts[2] : parts.join(" ") }
      }
      if (typeof command === "string") return { ...input, command }
    }
    return input
  }

  const compactionKey = (sessionID: string) => ["foreign_compaction", Instance.project.id, sessionID]

  /** Codex compactions stored for a session, oldest first. */
  export async function codexCompactions(sessionID: string): Promise<CodexCompaction[]> {
    const keys = await Storage.list(compactionKey(sessionID)).catch(() => [] as string[][])
    const records: CodexCompaction[] = []
    for (const key of keys.toSorted((a, b) => a.join("/").localeCompare(b.join("/")))) {
      const record = await Storage.read<CodexCompaction>(key).catch(() => undefined)
      if (record) records.push(record)
    }
    return records
  }

  export async function removeStored(sessionID: string): Promise<void> {
    const keys = await Storage.list(compactionKey(sessionID)).catch(() => [] as string[][])
    for (const key of keys) await Storage.remove(key).catch(() => undefined)
  }

  const dataURL = (attachment: ForeignAttachment) => `data:${attachment.mime};base64,${attachment.data}`

  export async function write(input: {
    sessionID: string
    conversation: ForeignConversation
    from?: number
    cwd: string
    root: string
    agent: string
  }): Promise<{ written: number; lastSourceID: string; lastMessageID: string }> {
    const { sessionID, conversation } = input
    const source = conversation.info.source
    const providerID = PROVIDER[source]
    const firstModel = conversation.entries.find((entry): entry is ForeignTurn => !isCompaction(entry) && !!entry.model)
    let modelID = firstModel?.model ?? "unknown"

    // An append continues from the newest user message already in the session.
    let lastUserID: string | undefined
    if (input.from) {
      const existing = await Session.messages({ sessionID })
      lastUserID = existing.findLast((message) => message.info.role === "user")?.info.id
    }

    const entries = conversation.entries.slice(input.from ?? 0)
    let lastSourceID = ""
    let lastMessageID = ""
    const zero = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

    const writeUser = async (time: number) => {
      const id = await MessageV2.nextMessageID(sessionID)
      await Session.updateMessage({
        id,
        sessionID,
        role: "user",
        time: { created: time },
        agent: input.agent,
        model: { providerID, modelID },
        effort: "normal",
      })
      lastUserID = id
      return id
    }
    const writeAssistant = async (
      time: number,
      fields: Partial<MessageV2.Assistant> & Pick<MessageV2.Assistant, "finish" | "tokens">,
    ) => {
      const id = await MessageV2.nextMessageID(sessionID)
      await Session.updateMessage({
        id,
        sessionID,
        role: "assistant",
        // An assistant turn with no user turn before it (rare) is its own parent.
        parentID: lastUserID ?? id,
        time: { created: time, completed: time },
        modelID,
        providerID,
        mode: input.agent,
        agent: input.agent,
        path: { cwd: input.cwd, root: input.root },
        cost: 0,
        ...fields,
      })
      return id
    }
    const part = (messageID: string) => ({ id: Identifier.ascending("part"), sessionID, messageID })

    for (const entry of entries) {
      if (isCompaction(entry)) {
        const carrier = await writeUser(entry.time)
        const compactionPart = part(carrier)
        // No rootID: the import has no live root message to pin ahead of the summary.
        await Session.updatePart({ ...compactionPart, type: "compaction", auto: false, trigger: "manual" })
        if (entry.codex) {
          const record: CodexCompaction = {
            item: entry.codex.item,
            summaryText: entry.summary,
            keptUserMessages: entry.codex.keptUserMessages,
          }
          await Storage.write([...compactionKey(sessionID), compactionPart.id], record)
        }
        const summary = await writeAssistant(entry.time, {
          summary: true,
          finish: "stop",
          mode: "compaction",
          agent: "compaction",
          tokens: zero,
        })
        await Session.updatePart({ ...part(summary), type: "text", text: entry.summary })
        lastSourceID = entry.sourceID
        lastMessageID = summary
        continue
      }

      if (entry.role === "assistant" && entry.model) modelID = entry.model
      if (entry.role === "user") {
        const id = await writeUser(entry.time)
        for (const item of entry.parts) {
          if (item.type === "text") await Session.updatePart({ ...part(id), type: "text", text: item.text })
          else if (item.type === "image")
            await Session.updatePart({ ...part(id), type: "file", mime: item.mime, url: dataURL(item) })
        }
        lastSourceID = entry.sourceID
        lastMessageID = id
        continue
      }

      const last = entry.parts.at(-1)
      const id = await writeAssistant(entry.time, {
        finish: last?.type === "tool" ? "tool-calls" : "stop",
        tokens: {
          input: entry.tokens?.input ?? 0,
          output: entry.tokens?.output ?? 0,
          reasoning: entry.tokens?.reasoning ?? 0,
          cache: { read: entry.tokens?.cacheRead ?? 0, write: entry.tokens?.cacheWrite ?? 0 },
        },
      })
      for (const item of entry.parts) await writePart(id, item, entry.time)
      lastSourceID = entry.sourceID
      lastMessageID = id
    }

    return { written: entries.length, lastSourceID, lastMessageID }

    async function writePart(messageID: string, item: ForeignPart, time: number) {
      if (item.type === "text") {
        await Session.updatePart({
          ...part(messageID),
          type: "text",
          text: item.text,
          time: { start: time, end: time },
        })
        return
      }
      if (item.type === "reasoning") {
        // Display only: with no provider metadata it is never replayed as signed thinking.
        await Session.updatePart({
          ...part(messageID),
          type: "reasoning",
          text: item.text,
          time: { start: time, end: time },
        })
        return
      }
      if (item.type === "image") {
        await Session.updatePart({ ...part(messageID), type: "file", mime: item.mime, url: dataURL(item) })
        return
      }
      const tool = toolName(source, item.name)
      const toolInputValue = toolInput(source, tool, item.input)
      const output = item.subagentResult ?? item.output
      const timing = { start: time, end: time }
      if (item.isError && output !== undefined) {
        await Session.updatePart({
          ...part(messageID),
          type: "tool",
          callID: item.callID,
          tool,
          state: { status: "error", input: toolInputValue, error: output, time: timing },
        })
        return
      }
      const attachments = item.attachments?.map((attachment) => ({
        ...part(messageID),
        type: "file" as const,
        mime: attachment.mime,
        url: dataURL(attachment),
      }))
      await Session.updatePart({
        ...part(messageID),
        type: "tool",
        callID: item.callID,
        tool,
        state: {
          status: "completed",
          input: toolInputValue,
          output: output ?? NO_RESULT,
          title: item.name,
          metadata: tool === "task" && item.subagentResult !== undefined ? { handoff: item.subagentResult } : {},
          time: timing,
          ...(attachments?.length ? { attachments } : {}),
        },
      })
    }
  }
}

// Reads Codex rollouts (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl) into the
// neutral import shape. Parsing approach adapted from oh-my-pi's
// codex-session-store.ts (MIT, Copyright (c) 2025 Mario Zechner).
import fs from "node:fs/promises"
import path from "node:path"
import { clip, isLive, isRecord, mapLimit, parseLines, sample, str, time, type JsonRecord } from "./jsonl"
import type {
  ForeignConversation,
  ForeignEntry,
  ForeignPart,
  ForeignReader,
  ForeignSessionInfo,
  ForeignTurn,
} from "./types"

export const CODEX_COMPACTION_FALLBACK = "Context compacted by Codex."

// Text Codex adds to the model's input on the user's behalf (environment,
// AGENTS.md, aborted-turn notices). It is never something the user typed.
const INJECTED = /^\s*(<(environment_context|user_instructions|user_shell_command|turn_aborted)\b|# AGENTS\.md)/

function contentText(value: unknown): string {
  if (typeof value === "string") return value
  if (!Array.isArray(value)) return ""
  return value
    .map((item) => {
      const kind = str(item, "type")
      return kind === "input_text" || kind === "output_text" || kind === "text" ? (str(item, "text") ?? "") : ""
    })
    .join("")
}

function args(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value
  if (typeof value !== "string") return {}
  try {
    const parsed: unknown = JSON.parse(value)
    if (isRecord(parsed)) return parsed
  } catch {
    // Custom tools carry free-form input.
  }
  return { input: value }
}

function outputText(value: unknown): string {
  if (typeof value === "string") return value
  const text = contentText(value)
  if (text) return text
  if (value === undefined) return ""
  return JSON.stringify(value)
}

function dataImage(url: unknown): { mime: string; data: string } | undefined {
  if (typeof url !== "string") return undefined
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(url)
  return match ? { mime: match[1], data: match[2] } : undefined
}

function compactionSummary(base: string, kept: string[]) {
  if (!kept.length) return base
  return [base, "User messages kept from before the compaction:", ...kept].join("\n\n")
}

async function rollouts(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const entry of entries) {
    const child = path.join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await rollouts(child)))
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(child)
  }
  return files
}

async function describe(file: string): Promise<ForeignSessionInfo | undefined> {
  const stat = await fs.stat(file).catch(() => undefined)
  if (!stat) return undefined
  const { head, whole } = await sample(file)
  const first = head[0]
  if (first?.type !== "session_meta" || !isRecord(first.payload)) return undefined
  // A subagent's run is saved as its own rollout; its result already sits in the parent conversation.
  if (isRecord(first.payload.source) && "subagent" in first.payload.source) return undefined
  let firstMessage: string | undefined
  for (const record of head) {
    if (record.type === "event_msg" && str(record.payload, "type") === "user_message") {
      firstMessage = str(record.payload, "message")
      if (firstMessage) break
    }
  }
  const conversation = head.some(
    (record) =>
      (record.type === "event_msg" && str(record.payload, "type") === "user_message") ||
      (record.type === "response_item" && str(record.payload, "type") === "message"),
  )
  // A session that was opened and closed without a message has nothing to import.
  if (whole && !conversation) return undefined
  return {
    source: "codex",
    id: str(first.payload, "id") ?? path.basename(file, ".jsonl"),
    path: file,
    cwd: str(first.payload, "cwd"),
    firstMessage: clip(firstMessage),
    created: time(str(first.payload, "timestamp") ?? first.timestamp, stat.birthtimeMs || stat.mtimeMs),
    modified: stat.mtimeMs,
  }
}

function convert(lines: Array<{ line: number; record: JsonRecord }>, info: ForeignSessionInfo): ForeignConversation {
  // Real user turns come from event_msg user_message. Older rollouts lack them;
  // there the response_item user messages that are not injected text stand in.
  const userEvents = lines.some(
    ({ record }) => record.type === "event_msg" && str(record.payload, "type") === "user_message",
  )
  const entries: ForeignEntry[] = []
  const ids = new Map<ForeignEntry, string[]>()
  const calls = new Map<string, Extract<ForeignPart, { type: "tool" }>>()
  let model: string | undefined
  let fallback = info.created

  const push = (entry: ForeignEntry, id: string) => {
    entries.push(entry)
    ids.set(entry, [id])
  }
  const assistant = (id: string, at: number): ForeignTurn => {
    const last = entries.at(-1)
    // A reply that ended in text is complete; anything after it is a new turn,
    // so an imported turn never grows and its sourceID stays put on re-import.
    if (last && !("kind" in last) && last.role === "assistant" && last.parts.at(-1)?.type !== "text") {
      last.sourceID = id
      ids.get(last)!.push(id)
      return last
    }
    const turn: ForeignTurn = { sourceID: id, role: "assistant", time: at, model, parts: [] }
    push(turn, id)
    return turn
  }
  const user = (id: string, at: number, text: string, images: Array<{ mime: string; data: string }>) => {
    const parts: ForeignPart[] = []
    if (text) parts.push({ type: "text", text })
    for (const image of images) parts.push({ type: "image", ...image })
    if (parts.length) push({ sourceID: id, role: "user", time: at, parts }, id)
  }

  for (const { line, record } of lines) {
    const at = time(record.timestamp, fallback)
    fallback = Math.max(fallback, at)
    const payload = record.payload
    if (!isRecord(payload)) continue
    const id = `codex:${line}`
    const kind = str(payload, "type")

    if (record.type === "turn_context") {
      model = str(payload, "model") ?? model
      continue
    }
    if (record.type === "event_msg") {
      if (kind === "user_message") {
        const images = Array.isArray(payload.images) ? payload.images.map(dataImage).filter((item) => !!item) : []
        user(id, at, str(payload, "message") ?? "", images)
      } else if (kind === "thread_rolled_back") {
        // Drop the last N user turns and everything after each of them.
        for (
          let remaining = typeof payload.num_turns === "number" ? payload.num_turns : 0;
          remaining > 0;
          remaining--
        ) {
          const index = entries.findLastIndex((entry) => !("kind" in entry) && entry.role === "user")
          if (index < 0) break
          for (const removed of entries.splice(index)) ids.delete(removed)
        }
      }
      continue
    }
    if (record.type === "compacted") {
      const history = Array.isArray(payload.replacement_history) ? payload.replacement_history.filter(isRecord) : []
      const item = history.findLast(
        (candidate) =>
          (candidate.type === "compaction" && typeof candidate.encrypted_content === "string") ||
          candidate.type === "compaction_summary",
      )
      const kept = history
        .filter((candidate) => candidate.type === "message" && candidate.role === "user")
        .map((candidate) => contentText(candidate.content))
        .filter((text) => text && !INJECTED.test(text))
      const readable = str(payload, "message")?.trim()
      push(
        {
          kind: "compaction",
          sourceID: id,
          time: at,
          summary: compactionSummary(readable || CODEX_COMPACTION_FALLBACK, kept),
          codex: item ? { item, keptUserMessages: kept } : undefined,
        },
        id,
      )
      continue
    }
    if (record.type !== "response_item") continue

    if (kind === "message") {
      const text = contentText(payload.content)
      if (payload.role === "assistant") {
        // Anthropic rejects whitespace-only text blocks.
        if (text.trim()) assistant(id, at).parts.push({ type: "text", text })
      } else if (payload.role === "user" && !userEvents && text && !INJECTED.test(text)) {
        const images = Array.isArray(payload.content)
          ? payload.content
              .filter((item) => str(item, "type") === "input_image")
              .map((item) => dataImage(isRecord(item) ? item.image_url : undefined))
              .filter((item) => !!item)
          : []
        user(id, at, text, images)
      }
    } else if (kind === "reasoning") {
      const texts = ["summary", "content"].flatMap((key) =>
        Array.isArray(payload[key]) ? (payload[key] as unknown[]).map((item) => str(item, "text") ?? "") : [],
      )
      const text = texts.filter(Boolean).join("\n\n")
      if (text) assistant(id, at).parts.push({ type: "reasoning", text })
    } else if (kind === "function_call" || kind === "custom_tool_call") {
      const callID = str(payload, "call_id") ?? str(payload, "id")
      const name = str(payload, "name")
      if (!callID || !name) continue
      const part: Extract<ForeignPart, { type: "tool" }> = {
        type: "tool",
        callID,
        name,
        input: args(kind === "custom_tool_call" ? payload.input : payload.arguments),
      }
      const turn = assistant(`${id}:${callID}`, at)
      turn.parts.push(part)
      calls.set(callID, part)
    } else if (kind === "web_search_call") {
      const callID = str(payload, "call_id") ?? str(payload, "id") ?? `web_search_${line}`
      // Codex runs web search server-side and records no separate output.
      assistant(`${id}:${callID}`, at).parts.push({
        type: "tool",
        callID,
        name: "web_search",
        input: args(payload.action),
        output: "",
      })
    } else if (kind === "function_call_output" || kind === "custom_tool_call_output") {
      const callID = str(payload, "call_id")
      const part = callID ? calls.get(callID) : undefined
      if (!part) continue
      part.output = outputText(payload.output)
      const owner = entries.findLast((entry) => !("kind" in entry) && entry.parts.includes(part))
      if (owner && !("kind" in owner)) {
        owner.sourceID = `${id}:${callID}`
        ids.get(owner)!.push(`${id}:${callID}`)
      }
    }
  }

  // A live session may still be writing its last turn; it comes in on the next import.
  const last = entries.at(-1)
  if (last && !("kind" in last) && last.role === "assistant" && isLive(info.modified)) {
    const waiting = last.parts.some((part) => part.type === "tool" && part.output === undefined)
    if (waiting || last.parts.at(-1)?.type !== "text") {
      entries.pop()
      ids.delete(last)
    }
  }

  return { info, entries, branchIDs: entries.flatMap((entry) => ids.get(entry) ?? []) }
}

export namespace CodexReader {
  export function create(root: string): ForeignReader {
    return {
      source: "codex",
      async list() {
        const infos = await mapLimit(await rollouts(root), 16, describe)
        return infos.toSorted((a, b) => b.modified - a.modified)
      },
      async load(info) {
        return convert(parseLines(await fs.readFile(info.path, "utf8")), info)
      },
    }
  }
}

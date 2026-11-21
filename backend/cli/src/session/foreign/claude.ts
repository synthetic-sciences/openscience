// Reads Claude Code conversations (~/.claude/projects/<folder-slug>/<id>.jsonl)
// into the neutral import shape. Parsing approach adapted from oh-my-pi's
// claude-session-store.ts (MIT, Copyright (c) 2025 Mario Zechner).
import fs from "node:fs/promises"
import path from "node:path"
import {
  clip,
  isLive,
  isRecord,
  mapLimit,
  num,
  parseLines,
  readStats as listingStats,
  sample,
  str,
  time,
  type JsonRecord,
} from "./jsonl"
import type {
  ForeignAttachment,
  ForeignConversation,
  ForeignEntry,
  ForeignPart,
  ForeignReader,
  ForeignSessionInfo,
  ForeignTurn,
} from "./types"

// User records that only carry Claude Code's own slash-command plumbing.
const WRAPPER =
  /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|local-command-caveat)>/
const SUBAGENT_TOOLS = new Set(["Task", "Agent"])

function isConversation(record: JsonRecord) {
  return (
    (record.type === "user" || record.type === "assistant") && record.isSidechain !== true && record.isMeta !== true
  )
}

function isBoundary(record: JsonRecord) {
  return record.type === "system" && record.subtype === "compact_boundary"
}

function userText(record: JsonRecord): string | undefined {
  const message = record.message
  if (!isRecord(message)) return undefined
  const content = message.content
  if (typeof content === "string") return WRAPPER.test(content) ? undefined : content
  if (!Array.isArray(content)) return undefined
  for (const block of content) {
    const value = str(block, "type") === "text" ? str(block, "text") : undefined
    if (value && !WRAPPER.test(value)) return value
  }
  return undefined
}

function image(block: unknown): ForeignAttachment | undefined {
  if (!isRecord(block) || block.type !== "image" || !isRecord(block.source)) return undefined
  const data = str(block.source, "data")
  const mime = str(block.source, "media_type")
  return data && mime ? { mime, data } : undefined
}

function resultContent(value: unknown): { text: string; images: ForeignAttachment[] } {
  if (typeof value === "string") return { text: value, images: [] }
  const texts: string[] = []
  const images: ForeignAttachment[] = []
  if (Array.isArray(value)) {
    for (const block of value) {
      if (str(block, "type") === "text") {
        const value = str(block, "text")
        if (value !== undefined) texts.push(value)
      } else {
        const attachment = image(block)
        if (attachment) images.push(attachment)
      }
    }
  }
  return { text: texts.join("\n"), images }
}

function tokens(usage: unknown): ForeignTurn["tokens"] {
  if (!isRecord(usage)) return undefined
  return {
    input: num(usage, "input_tokens") ?? 0,
    output: num(usage, "output_tokens") ?? 0,
    cacheRead: num(usage, "cache_read_input_tokens"),
    cacheWrite: num(usage, "cache_creation_input_tokens"),
  }
}

async function sessionFiles(root: string): Promise<string[]> {
  const slugs = await fs.readdir(root, { withFileTypes: true }).catch(() => [])
  const files: string[] = []
  for (const slug of slugs) {
    if (!slug.isDirectory()) continue
    const dir = path.join(root, slug.name)
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    // Subagent transcripts live in <id>/subagents/, not beside the session file.
    for (const entry of entries)
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path.join(dir, entry.name))
  }
  return files
}

async function describe(file: string): Promise<ForeignSessionInfo | undefined> {
  const stat = await fs.stat(file).catch(() => undefined)
  if (!stat) return undefined
  const { head, tail, whole } = await sample(file)
  // A session that was opened and closed without a message has nothing to import.
  if (whole && !head.some((record) => isConversation(record))) return undefined
  let cwd: string | undefined
  let firstMessage: string | undefined
  let created: number | undefined
  for (const record of head) {
    cwd ??= str(record, "cwd")
    if (created === undefined && isConversation(record)) created = time(record.timestamp, stat.mtimeMs)
    if (!firstMessage && record.type === "user" && isConversation(record) && record.isCompactSummary !== true) {
      firstMessage = userText(record)
    }
  }
  let custom: string | undefined
  let generated: string | undefined
  for (const record of [...head, ...tail]) {
    custom = str(record, "customTitle") ?? custom
    generated = str(record, "aiTitle") ?? generated
  }
  return {
    source: "claude",
    id: path.basename(file, ".jsonl"),
    path: file,
    cwd,
    title: clip(custom ?? generated),
    firstMessage: clip(firstMessage),
    created: created ?? stat.birthtimeMs ?? stat.mtimeMs,
    modified: stat.mtimeMs,
  }
}

function convert(records: JsonRecord[], info: ForeignSessionInfo): ForeignConversation {
  const byID = new Map<string, JsonRecord>()
  for (const record of records) {
    const id = str(record, "uuid")
    if (id) byID.set(id, record)
  }
  // The branch the user last saw ends at the newest conversation record.
  let leaf: JsonRecord | undefined
  let leafTime = -Infinity
  for (const record of records) {
    if (!isConversation(record) || !str(record, "uuid")) continue
    const at = time(record.timestamp, 0)
    if (at >= leafTime) {
      leaf = record
      leafTime = at
    }
  }
  const chain: JsonRecord[] = []
  const visited = new Set<string>()
  for (let current = leaf; current;) {
    const id = str(current, "uuid")!
    if (visited.has(id)) break
    visited.add(id)
    chain.push(current)
    // A compaction starts a new chain; its logical parent continues the history.
    const next = isBoundary(current) ? str(current, "logicalParentUuid") : str(current, "parentUuid")
    current = next ? byID.get(next) : undefined
  }
  chain.reverse()

  const entries: ForeignEntry[] = []
  const stops = new Map<ForeignTurn, unknown>()
  const messageIDs = new Map<ForeignTurn, string>()
  const seenMessageIDs = new Set<string>()
  let pendingBoundary: JsonRecord | undefined
  const findTool = (callID: string) => {
    for (let index = entries.length - 1; index >= 0; index--) {
      const entry = entries[index]
      if ("kind" in entry || entry.role !== "assistant") continue
      const part = entry.parts.find((item) => item.type === "tool" && item.callID === callID)
      if (part && part.type === "tool") return part
    }
    return undefined
  }

  for (const record of chain) {
    const id = str(record, "uuid")!
    const at = time(record.timestamp, info.modified)
    if (isBoundary(record)) {
      pendingBoundary = record
      continue
    }
    if (!isConversation(record) || !isRecord(record.message)) continue
    const message = record.message
    if (record.type === "user" && record.isCompactSummary === true) {
      const summary = typeof message.content === "string" ? message.content : (userText(record) ?? "")
      entries.push({
        kind: "compaction",
        sourceID: id,
        time: pendingBoundary ? time(pendingBoundary.timestamp, at) : at,
        summary,
      })
      pendingBoundary = undefined
      continue
    }
    if (record.type === "user") {
      const content = message.content
      const parts: ForeignPart[] = []
      if (typeof content === "string") {
        if (!WRAPPER.test(content)) parts.push({ type: "text", text: content })
      } else if (Array.isArray(content)) {
        for (const block of content) {
          const kind = str(block, "type")
          if (kind === "text") {
            const value = str(block, "text")
            if (value && !WRAPPER.test(value)) parts.push({ type: "text", text: value })
          } else if (kind === "image") {
            const attachment = image(block)
            if (attachment) parts.push({ type: "image", ...attachment })
          } else if (kind === "tool_result") {
            const callID = str(block, "tool_use_id")
            const tool = callID ? findTool(callID) : undefined
            if (!tool) continue
            const result = resultContent(isRecord(block) ? block.content : undefined)
            tool.output = result.text
            if (result.images.length) tool.attachments = result.images
            if (isRecord(block) && block.is_error === true) tool.isError = true
            if (SUBAGENT_TOOLS.has(tool.name)) tool.subagentResult = result.text
          }
        }
      }
      if (parts.length) entries.push({ sourceID: id, role: "user", time: at, parts })
      continue
    }
    // Assistant: one API response can span several records sharing message.id.
    const parts: ForeignPart[] = []
    const content = Array.isArray(message.content) ? message.content : []
    for (const block of content) {
      const kind = str(block, "type")
      if (kind === "text") {
        const value = str(block, "text")
        // Anthropic rejects whitespace-only text blocks.
        if (value?.trim()) parts.push({ type: "text", text: value })
      } else if (kind === "thinking") {
        const value = str(block, "thinking")
        if (value) parts.push({ type: "reasoning", text: value })
      } else if (kind === "tool_use") {
        const callID = str(block, "id")
        const name = str(block, "name")
        if (!callID || !name) continue
        parts.push({
          type: "tool",
          callID,
          name,
          input: isRecord(isRecord(block) ? block.input : undefined) ? ((block as JsonRecord).input as JsonRecord) : {},
        })
      }
    }
    const messageID = str(message, "id")
    const previous = entries.at(-1)
    if (messageID && previous && !("kind" in previous) && messageIDs.get(previous) === messageID) {
      previous.parts.push(...parts)
      previous.sourceID = id
      previous.tokens = tokens(message.usage) ?? previous.tokens
      stops.set(previous, message.stop_reason)
      continue
    }
    // A record already imported elsewhere on the branch (preserved across a compaction).
    if (messageID && seenMessageIDs.has(messageID)) continue
    if (!parts.length) continue
    const turn: ForeignTurn = {
      sourceID: id,
      role: "assistant",
      time: at,
      model: str(message, "model"),
      tokens: tokens(message.usage),
      parts,
    }
    entries.push(turn)
    stops.set(turn, message.stop_reason)
    if (messageID) {
      messageIDs.set(turn, messageID)
      seenMessageIDs.add(messageID)
    }
  }

  // A live session may still be writing its last turn; it comes in on the next import.
  const last = entries.at(-1)
  if (last && !("kind" in last) && last.role === "assistant" && isLive(info.modified)) {
    const waiting = last.parts.some((part) => part.type === "tool" && part.output === undefined)
    const stop = stops.get(last)
    if (waiting || stop === null || stop === undefined) entries.pop()
  }

  return { info, entries, branchIDs: chain.map((record) => str(record, "uuid")!) }
}

export namespace ClaudeReader {
  export function create(root: string): ForeignReader {
    return {
      source: "claude",
      async list() {
        // Bounded, and one unreadable file never hides the others.
        const infos = await mapLimit(await sessionFiles(root), 16, describe)
        return infos.toSorted((a, b) => b.modified - a.modified)
      },
      async load(info) {
        const text = await fs.readFile(info.path, "utf8")
        return convert(
          parseLines(text).map((item) => item.record),
          info,
        )
      },
    }
  }

  /** Bytes read while listing; tests use it to prove listing stays cheap. */
  export function readStats() {
    return listingStats
  }
}

/** A coding agent whose saved conversations OpenScience can import. */
export type ForeignSource = "claude" | "codex"

/** Lightweight listing data, read without parsing whole transcripts. */
export type ForeignSessionInfo = {
  source: ForeignSource
  id: string
  path: string
  cwd?: string
  title?: string
  firstMessage?: string
  created: number
  modified: number
  messageCount?: number
}

export type ForeignAttachment = { mime: string; data: string }

export type ForeignPart =
  | { type: "text"; text: string }
  | { type: "image"; mime: string; data: string }
  | { type: "reasoning"; text: string }
  | {
      type: "tool"
      callID: string
      name: string
      input: Record<string, unknown>
      /** Undefined when the source recorded no result (an interrupted turn). */
      output?: string
      attachments?: ForeignAttachment[]
      isError?: boolean
      /** The returned result of a delegated subagent (Claude Code's Task/Agent tool). */
      subagentResult?: string
    }

export type ForeignTokens = {
  input: number
  output: number
  reasoning?: number
  cacheRead?: number
  cacheWrite?: number
}

/** One user or assistant turn in provider-independent form. */
export type ForeignTurn = {
  /** Source record id; a turn merged from several records uses its last record's id. */
  sourceID: string
  role: "user" | "assistant"
  time: number
  model?: string
  tokens?: ForeignTokens
  parts: ForeignPart[]
}

/** A point where the source tool summarised the earlier conversation. */
export type ForeignCompaction = {
  sourceID: string
  time: number
  summary: string
  /** Codex keeps its compacted history encrypted; only OpenAI's Codex route can read it. */
  codex?: { item: Record<string, unknown>; keptUserMessages: string[] }
}

export type ForeignEntry = ForeignTurn | ({ kind: "compaction" } & ForeignCompaction)

export type ForeignConversation = {
  info: ForeignSessionInfo
  entries: ForeignEntry[]
  /** Source record ids on the imported branch, oldest first. */
  branchIDs: string[]
}

export interface ForeignReader {
  readonly source: ForeignSource
  list(): Promise<ForeignSessionInfo[]>
  load(info: ForeignSessionInfo): Promise<ForeignConversation>
}

export function isCompaction(entry: ForeignEntry): entry is { kind: "compaction" } & ForeignCompaction {
  return "kind" in entry && entry.kind === "compaction"
}

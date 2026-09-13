import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Session } from "../session"
import { SessionFilesystem } from "@/session/filesystem"
import type { MessageV2 } from "@/session/message-v2"
import DESCRIPTION from "./recall.txt"

const MAX_FILE_BYTES = 8 * 1024 * 1024
const EXCERPT = 240

type Match = { where: string; offset: number; excerpt: string; time?: number }

function excerpt(text: string, at: number, length: number) {
  const start = Math.max(0, at - Math.floor(EXCERPT / 3))
  const end = Math.min(text.length, Math.max(at + length, start + EXCERPT))
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`
}

function scan(text: string, pattern: RegExp, where: string, time: number | undefined, out: Match[], limit: number) {
  pattern.lastIndex = 0
  for (let match = pattern.exec(text); match !== null && out.length < limit; match = pattern.exec(text)) {
    out.push({ where, offset: match.index, excerpt: excerpt(text, match.index, match[0].length), time })
    if (match[0].length === 0) pattern.lastIndex++
  }
}

/** Every text the session ever produced or read, including turns that a later
 * compaction summarized away: the message store is the full record. */
function historyTexts(messages: MessageV2.WithParts[]) {
  return messages.flatMap((message) => {
    const role = message.info.role
    const time = message.info.time.created
    return message.parts.flatMap((part): Array<{ where: string; text: string; time: number }> => {
      if (part.type === "text" && !part.ignored)
        return [{ where: `${role} text (${message.info.id})`, text: part.text, time }]
      if (part.type === "reasoning") return []
      if (part.type !== "tool") return []
      const input = JSON.stringify(part.state.input ?? {})
      const output =
        part.state.status === "completed" ? part.state.output : part.state.status === "error" ? part.state.error : ""
      return [
        { where: `${part.tool} call (${part.callID})`, text: input, time },
        ...(output ? [{ where: `${part.tool} result (${part.callID})`, text: output, time }] : []),
      ]
    })
  })
}

export const RecallTool = Tool.define("recall", {
  description: DESCRIPTION,
  parameters: z.object({
    pattern: z.string().min(1).max(500).describe("Regular expression (JavaScript syntax, case-insensitive)."),
    scope: z
      .enum(["all", "history", "outputs"])
      .optional()
      .describe(
        "history: every earlier message and tool result of this session, including compacted ones. outputs: saved full tool outputs. Default all.",
      ),
    limit: z.number().int().min(1).max(100).optional().describe("Matches to return (default 20)."),
  }),
  async execute(params, ctx) {
    const pattern = (() => {
      try {
        return new RegExp(params.pattern, "gi")
      } catch (error) {
        throw new Error(`Invalid pattern: ${error instanceof Error ? error.message : String(error)}`)
      }
    })()
    const limit = params.limit ?? 20
    const scope = params.scope ?? "all"
    const matches: Match[] = []

    if (scope !== "outputs") {
      const messages = await Session.messages({ sessionID: ctx.sessionID })
      // Oldest first, and never the call that is running right now.
      for (const entry of historyTexts(messages.filter((message) => message.info.id !== ctx.messageID))) {
        if (matches.length >= limit) break
        scan(entry.text, pattern, entry.where, entry.time, matches, limit)
      }
    }

    if (scope !== "history" && matches.length < limit) {
      const grants = (await SessionFilesystem.list(ctx.sessionID)).filter(
        (grant) => grant.source === "tool" && grant.scope === "session" && !grant.time.revoked,
      )
      for (const grant of grants) {
        if (matches.length >= limit) break
        const file = Bun.file(grant.path)
        const size = await file.size
        if (!size || size > MAX_FILE_BYTES) continue
        const text = await file.text().catch(() => "")
        scan(
          text,
          pattern,
          `saved output ${path.basename(grant.path)} (${grant.path})`,
          grant.time.created,
          matches,
          limit,
        )
      }
    }

    if (!matches.length) {
      return {
        title: `recall: no match for /${params.pattern}/`,
        output: `Nothing in this session's ${scope === "all" ? "history or saved outputs" : scope} matches /${params.pattern}/.`,
        metadata: { count: 0, truncated: false } as Record<string, unknown>,
      }
    }
    const lines = matches.map((match) => `- [${match.where}] @${match.offset}: ${match.excerpt}`)
    return {
      title: `recall: ${matches.length} match(es) for /${params.pattern}/`,
      output: [
        `${matches.length}${matches.length >= limit ? "+" : ""} match(es) for /${params.pattern}/ in this session (offsets are character positions within the named text).`,
        ...lines,
      ].join("\n"),
      metadata: { count: matches.length, truncated: matches.length >= limit } as Record<string, unknown>,
    }
  },
})

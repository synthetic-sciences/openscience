// On the Codex route, give an imported Codex session back its own compacted
// history: the summary text OpenScience shows is replaced by what Codex itself
// would send (the kept user messages, then its encrypted compaction item).
// Other routes never see the encrypted item; they get the summary text.
import { Instance } from "../../project/instance"
import { Storage } from "../../storage/storage"

export namespace CodexReplay {
  type Stored = { item: Record<string, unknown>; summaryText: string; keptUserMessages: string[] }
  type Item = Record<string, unknown>

  // The question OpenScience puts before every compaction summary (MessageV2.toModelMessages).
  const CARRIER_QUESTION = "What did we do so far?"

  function text(item: Item): string | undefined {
    const content = item.content
    if (typeof content === "string") return content
    if (!Array.isArray(content)) return undefined
    return content.map((part) => (typeof part?.text === "string" ? part.text : "")).join("")
  }

  async function stored(sessionID: string): Promise<Stored[]> {
    let projectID: string
    try {
      projectID = Instance.project.id
    } catch {
      return []
    }
    const keys = await Storage.list(["foreign_compaction", projectID, sessionID]).catch(() => [] as string[][])
    const records: Stored[] = []
    // Newest first: when two compactions share a summary, the latest history wins.
    for (const key of keys.toSorted((a, b) => b.join("/").localeCompare(a.join("/")))) {
      const record = await Storage.read<Stored>(key).catch(() => undefined)
      if (record) records.push(record)
    }
    return records
  }

  /** Rewrite `body.input` in place; true when anything changed. */
  export async function rewrite(body: { input?: unknown }, sessionID: string | undefined): Promise<boolean> {
    if (!sessionID || !Array.isArray(body.input)) return false
    const records = await stored(sessionID)
    if (!records.length) return false
    const input = body.input as Item[]
    let changed = false
    for (const record of records) {
      const index = input.findIndex((item) => item.role === "assistant" && text(item) === record.summaryText)
      if (index < 0) continue
      const kept: Item[] = record.keptUserMessages.map((value) => ({
        role: "user",
        content: [{ type: "input_text", text: value }],
      }))
      const start =
        index > 0 && input[index - 1].role === "user" && text(input[index - 1]) === CARRIER_QUESTION ? index - 1 : index
      input.splice(start, index - start + 1, ...kept, record.item)
      // Only the newest compaction is ever in view (filterCompacted drops older history).
      changed = true
      break
    }
    return changed
  }
}

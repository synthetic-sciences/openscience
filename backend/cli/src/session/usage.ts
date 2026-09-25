import { Storage } from "@/storage/storage"
import { MessageV2 } from "./message-v2"
import type { Session } from "."
import { TokenUsage } from "@synsci/util/token-usage"
import type { UsageRow, UsageRoute } from "@synsci/util/usage"

export async function localUsage(start: number, end: number): Promise<UsageRow[]> {
  const rows = new Map<string, UsageRow>()
  const sessions = await Storage.list(["session"])
  for (const key of sessions) {
    const session = await Storage.read<Session.Info>(key).catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
    if (!session || session.time.updated < start) continue
    const keys = await Storage.list(["message", session.id])
    for (let offset = 0; offset < keys.length; offset += 32) {
      const messages = await Promise.all(
        keys.slice(offset, offset + 32).map((key) =>
          Storage.read<MessageV2.Info>(key).catch((error) => {
            if (error instanceof Storage.NotFoundError) return undefined
            throw error
          }),
        ),
      )
      for (const message of messages) {
        if (!message || message.role !== "assistant") continue
        // Forks copy their transcript. Only calls made after this session was
        // created belong to it; inherited history must not be counted again.
        if (message.time.created < session.time.created || message.time.created >= end) continue
        const parts = await Storage.list(["part", message.id])
        const steps: MessageV2.StepFinishPart[] = []
        for (const key of parts) {
          const part = await Storage.read<MessageV2.Part>(key).catch((error) => {
            if (error instanceof Storage.NotFoundError) return undefined
            throw error
          })
          if (part?.type === "step-finish") steps.push(part)
        }
        const entries = steps.length ? steps : [message]
        for (const entry of entries) {
          const recorded = "usage" in entry ? entry.usage : undefined
          const time = recorded?.time ?? message.time.created
          if (time < start || time >= end) continue
          const provider = recorded?.provider ?? message.providerID
          const model = recorded?.model ?? message.modelID
          const route: UsageRoute =
            recorded?.route ??
            (provider === "ollama" || provider === "lmstudio"
              ? "local"
              : provider === "openai-codex"
                ? "chatgpt"
                : "unknown")
          // Managed requests are counted from verified server receipts.
          if (route === "managed") continue
          const tokens = TokenUsage.total(entry.tokens)
          if (!tokens && !entry.cost) continue
          const date = new Date(time).toISOString().slice(0, 10)
          const id = JSON.stringify([date, provider, model, route])
          const row = rows.get(id) ?? {
            date,
            provider,
            model,
            route,
            calls: 0,
            input: 0,
            output: 0,
            reasoning: 0,
            cacheRead: 0,
            cacheWrite: 0,
            tokens: 0,
            cost: 0,
          }
          row.calls += 1
          row.input += entry.tokens.input
          row.output += entry.tokens.output
          row.reasoning += entry.tokens.reasoning
          row.cacheRead += entry.tokens.cache.read
          row.cacheWrite += entry.tokens.cache.write
          row.tokens += tokens
          row.cost += route === "local" || route === "chatgpt" || route === "subscription" ? 0 : entry.cost
          rows.set(id, row)
        }
      }
    }
  }
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date) || a.model.localeCompare(b.model))
}

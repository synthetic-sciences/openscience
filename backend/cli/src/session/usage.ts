import { SessionTraceStore } from "./trace-store"
import { BillingImport } from "./billing-import"
import { usageCost, usageCosts } from "@synsci/util/usage"
import { Storage } from "@/storage/storage"
import { MessageV2 } from "./message-v2"
import type { Session } from "."
import { TokenUsage } from "@synsci/util/token-usage"
import type { UsageRow, UsageRoute } from "@synsci/util/usage"

export async function localUsage(start: number, end: number, projectID?: string): Promise<UsageRow[]> {
  const sessions = await Storage.list(projectID === undefined ? ["session"] : ["session", projectID])
  const scope = projectID === undefined ? undefined : new Set(sessions.map((key) => key.at(-1)!))
  const rows = new Map<string, UsageRow>()
  const seen = new Set<string>()
  const calls = await (
    await Storage.research()
  ).query((db) =>
    db
      .query<{ data: string }, [number, number]>(
        "SELECT data FROM model_call WHERE json_extract(data,'$.occurredAt')>=? AND json_extract(data,'$.occurredAt')<?",
      )
      .all(start, end)
      .map((row) => SessionTraceStore.ModelCall.parse(JSON.parse(row.data)))
      .filter((call) => !scope || scope.has(call.sessionID)),
  )
  const trace = new Map(calls.map((call) => [JSON.stringify([call.sessionID, call.id]), call]))
  for (const key of sessions) {
    const session = await Storage.read<Session.Info>(key).catch((error) => {
      if (error instanceof Storage.NotFoundError) return undefined
      throw error
    })
    // A record without an id (legacy or corrupt) has no messages to list.
    if (!session?.id || session.time.updated < start) continue
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
        if (!message?.id || message.role !== "assistant") continue
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
          const callKey = recorded?.call ? JSON.stringify([session.id, recorded.call]) : undefined
          if (callKey) seen.add(callKey)
          const tokens = TokenUsage.total(entry.tokens)
          if (!tokens && !entry.cost && !recorded) continue
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
          const source =
            route === "local"
              ? "no_provider_charge"
              : route === "chatgpt" || route === "subscription"
                ? "subscription"
                : (recorded?.cost?.source ?? "recorded_unclassified")
          const costs = [
            usageCost(
              source,
              source === "subscription"
                ? null
                : source === "no_provider_charge"
                  ? 0
                  : recorded?.cost
                    ? recorded.cost.amountUSD
                    : entry.cost,
            ),
          ]
          const reported = recorded?.reportedCostUSD ?? (callKey ? trace.get(callKey)?.reportedCostUSD : undefined)
          if (source !== "provider_response" && (reported != null || route === "byok" || route === "custom"))
            costs.push(usageCost("provider_response", reported ?? null))
          row.costs = usageCosts([...(row.costs ?? []), ...costs])
          rows.set(id, row)
        }
      }
    }
  }
  for (const call of calls) {
    if (call.route === "managed" || seen.has(JSON.stringify([call.sessionID, call.id]))) continue
    const date = new Date(call.occurredAt).toISOString().slice(0, 10)
    const id = JSON.stringify([date, call.provider, call.model, call.route])
    const row = rows.get(id) ?? {
      date,
      provider: call.provider,
      model: call.model,
      route: call.route,
      calls: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      tokens: 0,
      cost: 0,
    }
    row.calls++
    row.input += call.reported?.input_tokens ?? 0
    row.output += call.reported?.output_tokens ?? 0
    row.reasoning += call.reported?.reasoning_tokens ?? 0
    row.cacheRead += call.reported?.cached_input_tokens ?? 0
    row.cacheWrite += call.reported?.cache_creation_input_tokens ?? 0
    row.tokens +=
      call.reported?.total_tokens ?? (call.reported?.input_tokens ?? 0) + (call.reported?.output_tokens ?? 0)
    const source =
      call.route === "local"
        ? "no_provider_charge"
        : call.route === "chatgpt" || call.route === "subscription"
          ? "subscription"
          : "provider_response"
    row.costs = usageCosts([
      ...(row.costs ?? []),
      usageCost(
        source,
        source === "no_provider_charge" ? 0 : source === "subscription" ? null : (call.reportedCostUSD ?? null),
      ),
    ])
    rows.set(id, row)
  }
  for (const record of await BillingImport.records(start, end)) {
    if (scope && (!record.sessionID || !scope.has(record.sessionID))) continue
    const date = record.occurredAt.slice(0, 10)
    const model =
      record.match === "matched" && record.requestedModel
        ? record.requestedModel
        : (record.model ?? "Unknown billing model")
    const id = JSON.stringify([date, record.provider, model, "byok"])
    const row = rows.get(id) ?? {
      date,
      provider: record.provider,
      model,
      route: "byok" as const,
      calls: 0,
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      tokens: 0,
      cost: 0,
    }
    row.costs = usageCosts([
      ...(row.costs ?? []),
      usageCost(record.kind === "credit" ? "imported_credit" : "imported_billing", record.amountUSD),
    ])
    rows.set(id, row)
  }
  return [...rows.values()].sort((a, b) => a.date.localeCompare(b.date) || a.model.localeCompare(b.model))
}

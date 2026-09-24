import type { AssistantMessage, Message, Part, Provider, UserMessage } from "@synsci/sdk/v2/client"

/** Sum recorded costs only. A completed Task result reports its direct child turn. */
export function sessionCost(messages: Message[], parts: Record<string, Part[] | undefined>) {
  const amount = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0)
  const lead = messages.reduce((sum, message) => sum + (message.role === "assistant" ? amount(message.cost) : 0), 0)
  const workers = messages.reduce((sum, message) => {
    if (message.role !== "assistant") return sum
    return (parts[message.id] ?? []).reduce((subtotal, part) => {
      if (part.type !== "tool" || part.tool !== "task" || part.state.status !== "completed") return subtotal
      const usage = part.state.metadata?.usage
      return subtotal + amount(usage && typeof usage === "object" ? Reflect.get(usage, "cost") : undefined)
    }, sum)
  }, 0)
  return { lead, workers, total: lead + workers }
}

export function sessionCostFormatter(locale: string) {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "USD", maximumFractionDigits: 8 })
}

/** Recorded access survives a later change to the account's selected provider. */
export function sessionProviderLabel(
  message: Pick<AssistantMessage, "providerID">,
  prompt: Pick<UserMessage, "inference"> | undefined,
  provider: Pick<Provider, "name" | "source"> | undefined,
) {
  const source = prompt?.inference?.source
  if (source === "managed" || (source === undefined && provider?.source === "managed")) return "Ace"
  if (source === "chatgpt") return "ChatGPT"
  return provider?.name ?? message.providerID
}

import { Session } from "."
import { SessionTraceStore } from "./trace-store"
import { UsageLogging } from "./usage-logging"

export namespace CallAudit {
  export async function report(rootID: string) {
    await Session.get(rootID)
    const pending = [rootID]
    const seen = new Set<string>()
    const sessions: { sessionID: string; parentID?: string; telemetrySessionID: string }[] = []
    const calls: {
      sessionID: string
      telemetrySessionID: string
      messageID: string
      stepID?: string
      route: "managed" | "byok" | "chatgpt" | "subscription" | "local" | "custom"
      provider: string
      model: string
      occurredAt: string
      httpCall?: string
      providerRequest?: string
      hold?: string
      recordedTokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
      recordedCostUSD?: number
    }[] = []
    while (pending.length) {
      const sessionID = pending.shift()!
      if (seen.has(sessionID)) continue
      seen.add(sessionID)
      const session = await Session.get(sessionID)
      const telemetrySessionID = await UsageLogging.telemetrySessionID(sessionID)
      sessions.push({ sessionID, ...(session.parentID && { parentID: session.parentID }), telemetrySessionID })
      for (const child of await Session.children(sessionID)) pending.push(child.id)
      const recorded = new Map<string, number>()
      for (const call of (await SessionTraceStore.read(sessionID)).modelCalls) {
        recorded.set(call.id, calls.length)
        calls.push({
          sessionID,
          telemetrySessionID,
          messageID: call.messageID,
          route: call.route,
          provider: call.provider,
          model: call.model,
          occurredAt: new Date(call.occurredAt).toISOString(),
          httpCall: call.id,
          ...(call.providerRequest && { providerRequest: call.providerRequest }),
          ...(call.hold && { hold: call.hold }),
        })
      }
      for (const message of await Session.messages({ sessionID })) {
        for (const part of message.parts) {
          if (part.type !== "step-finish" || !part.usage) continue
          const call = {
            sessionID,
            telemetrySessionID,
            messageID: part.messageID,
            stepID: part.id,
            route: part.usage.route,
            provider: part.usage.provider,
            model: part.usage.model,
            occurredAt: new Date(part.usage.time).toISOString(),
            ...(part.usage.call && { httpCall: part.usage.call }),
            ...(part.usage.providerRequest && { providerRequest: part.usage.providerRequest }),
            ...(part.usage.hold && { hold: part.usage.hold }),
            recordedTokens: part.tokens,
            recordedCostUSD: part.cost,
          }
          const index = part.usage.call ? recorded.get(part.usage.call) : undefined
          if (index === undefined) calls.push(call)
          else calls[index] = { ...calls[index], ...call }
        }
      }
    }
    calls.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || (a.stepID ?? "").localeCompare(b.stepID ?? ""))
    return { rootSessionID: rootID, sessions, calls }
  }
}

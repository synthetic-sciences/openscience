import type { LanguageModelUsage, ProviderMetadata } from "ai"
import type { Provider } from "@/provider/provider"
import type { CallLink } from "@/provider/call-link"
import type { AccessRoute } from "./access-route"
import { SessionTraceStore } from "./trace-store"
import { UsageLogging } from "./usage-logging"

/** Provider transport, structured calls and ordinary steps share this recorder. */
export namespace ModelCallTrace {
  export function create(input: {
    context: Provider.RequestContext
    route: AccessRoute
    provider: string
    model: string
    binding?: UsageLogging.Binding
  }) {
    const calls = new Map<string, SessionTraceStore.ModelCall>()
    const finish = async (call: SessionTraceStore.ModelCall) => {
      calls.set(call.id, call)
      await SessionTraceStore.recordModelCall(call)
    }
    const context: Provider.RequestContext = {
      ...input.context,
      callTrace: {
        async start(timing, body) {
          await finish({
            id: timing.requestID,
            sessionID: timing.sessionID,
            messageID: timing.messageID,
            route: input.route,
            provider: timing.providerID,
            model: timing.modelID,
            occurredAt: timing.startedAt,
            outcome: "pending",
            attempt: timing.attempt,
          })
          if (!input.binding) return
          const request: unknown =
            typeof body === "string"
              ? await Promise.resolve()
                  .then(() => JSON.parse(body))
                  .catch(() => body)
              : undefined
          await UsageLogging.bind({ ...input.binding, operationID: timing.requestID })
          await UsageLogging.event({ ...input.binding, operationID: timing.requestID }, "model.request", {
            phase: "dispatch",
            http_call_id: timing.requestID,
            attempt: timing.attempt,
            ...(request === undefined ? {} : { request }),
          })
        },
        async finish(timing, response) {
          const current = calls.get(timing.requestID)
          if (!current) return
          const outcome =
            timing.outcome === "completed"
              ? response.status === 0 || (response.status !== undefined && response.status >= 400)
                ? "failed"
                : "transport_completed"
              : timing.outcome === "cancelled" || timing.outcome === "aborted"
                ? "cancelled"
                : timing.outcome === "idle_timeout" || timing.outcome === "timeout"
                  ? "timed_out"
                  : "failed"
          await finish({
            ...current,
            outcome,
            completedAt: timing.completedAt,
            ...(response.status === undefined ? {} : { httpStatus: response.status }),
            ...(response.hold ? { hold: response.hold } : {}),
            ...(response.providerRequest ? { providerRequest: response.providerRequest } : {}),
          })
          if (input.binding && outcome !== "transport_completed")
            await UsageLogging.event({ ...input.binding, operationID: timing.requestID }, "error", {
              http_call_id: timing.requestID,
              outcome,
              ...(response.status === undefined ? {} : { http_status: response.status }),
            })
        },
      },
    }
    return {
      context,
      current: () => [...calls.keys()].at(-1),
      async complete(
        call: ReturnType<typeof CallLink.fromResponse>,
        usage: LanguageModelUsage,
        metadata?: ProviderMetadata,
        outcome: "completed" | "failed" = "completed",
      ) {
        const pending = [...calls.values()].filter((item) => item.outcome === "transport_completed")
        const current = call
          ? (calls.get(call.id) ?? {
              id: call.id,
              sessionID: context.sessionID,
              messageID: context.messageID,
              route: input.route,
              provider: input.provider,
              model: input.model,
              occurredAt: Date.now(),
            })
          : pending.length === 1
            ? pending[0]
            : undefined
        if (!current) return
        const observed = UsageLogging.reported(usage, metadata)
        await finish({
          ...current,
          outcome,
          reported: observed.usage,
          reportedCostUSD: observed.cost_usd,
          ...(call?.hold ? { hold: call.hold } : {}),
          ...(call?.providerRequest ? { providerRequest: call.providerRequest } : {}),
        })
        if (outcome === "failed" && input.binding)
          await UsageLogging.event({ ...input.binding, operationID: current.id }, "error", {
            http_call_id: current.id,
            outcome,
            phase: "output_validation",
          })
        return {
          id: current.id,
          ...(current.hold ? { hold: current.hold } : {}),
          ...(current.providerRequest ? { providerRequest: current.providerRequest } : {}),
          ...call,
        }
      },
      async fail(outcome: "failed" | "cancelled") {
        for (const call of calls.values()) {
          if (call.outcome !== "pending" && call.outcome !== "transport_completed") continue
          await finish({ ...call, outcome, completedAt: Date.now() })
          if (input.binding)
            await UsageLogging.event({ ...input.binding, operationID: call.id }, "error", {
              http_call_id: call.id,
              outcome,
            })
        }
      },
    }
  }
}

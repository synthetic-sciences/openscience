import { Decimal } from "decimal.js"
import type { LanguageModelUsage, ProviderMetadata } from "ai"
import type { Provider } from "@/provider/provider"
import type { AccessRoute } from "./access-route"
import { ManagedPricing } from "@/provider/managed-pricing"
import { Session } from "."
import { UsageLogging } from "./usage-logging"
import { SubagentBudget } from "./subagent-budget"

/** Provider-independent admission; physical transport retries reserve separately. */
export namespace SubagentDispatch {
  type Context = { sessionID: string; model: Provider.Model; route: AccessRoute; internal?: boolean }
  const notice =
    "Runtime allowance notice: 75% of this subagent's allowance is used, or remaining capacity is needed for the handoff. Stop exploration. Do not start further research, tools or workers. Return supported findings, artifacts, checks, remaining work and limitations now. Start with Outcome: Complete or Outcome: Incomplete. The final handoff must fit inside the remaining allowance."

  function prices(value: unknown): number[] {
    if (!value || typeof value !== "object") return []
    return Object.entries(value).flatMap(([key, item]) =>
      ["input", "output", "read", "write", "cache_read", "cache_write"].includes(key) &&
      typeof item === "number" &&
      Number.isFinite(item)
        ? [item]
        : prices(item),
    )
  }
  function rate(input: Pick<Context, "model" | "route">) {
    const highest = Math.max(0, ...prices({ cost: input.model.cost, modes: input.model.modes }))
    const fee = input.route === "managed" ? (ManagedPricing.fundingFeeBps(input.model) ?? 0) : 0
    return new Decimal(highest).mul(1000).mul(new Decimal(10000 + fee).div(10000))
  }
  export function unit(model: Provider.Model, route: AccessRoute): SubagentBudget.Unit {
    if (route === "managed" || route === "byok") return "usd"
    if ((route === "local" || route === "custom") && rate({ model, route }).greaterThan(0)) return "usd"
    return "tokens"
  }
  async function checked(input: Context) {
    const state = await SubagentBudget.read(input.sessionID)
    if (!state) return
    const w = state.worker
    const reason =
      w.deadline <= Date.now()
        ? "deadline"
        : w.route !== input.route || w.model.providerID !== input.model.providerID || w.model.modelID !== input.model.id
          ? "route_changed"
          : w.stopReason && w.stopReason !== "budget_wrapup"
            ? w.stopReason
            : undefined
    if (reason) {
      await SubagentBudget.stop(input.sessionID, reason)
      throw new SubagentBudget.LimitError(reason)
    }
    if (!w.active) throw new SubagentBudget.LimitError("cancelled", "Subagent assignment is no longer active")
    if (w.unit === "usd" && !rate(input).greaterThan(0)) {
      await SubagentBudget.stop(input.sessionID, "pricing_unavailable")
      throw new SubagentBudget.LimitError(
        "pricing_unavailable",
        "Reliable model pricing is required for a USD subagent allowance",
      )
    }
    return state
  }
  export async function prepare(input: Context & { inputTokens: number; maxOutputTokens?: number }) {
    const state = await checked(input)
    if (!state) return
    const remaining = SubagentBudget.spendable(state.pool, input.sessionID)
    const tokens =
      state.worker.unit === "tokens" ? remaining : new Decimal(remaining).div(rate(input)).floor().toNumber()
    const output = Math.min(input.maxOutputTokens ?? 2048, Math.max(0, Math.floor(tokens - input.inputTokens)))
    if (output < 1) {
      const reason = state.worker.unit === "usd" ? "budget_limit" : "token_limit"
      await SubagentBudget.stop(input.sessionID, reason)
      throw new SubagentBudget.LimitError(reason, "Subagent limit cannot cover another call and its input")
    }
    const wrapup =
      !!state.worker.wrapup ||
      SubagentBudget.consumed(state.pool, input.sessionID) >= state.worker.limit * 0.75 ||
      output < Math.min(input.maxOutputTokens ?? 2048, 512) ||
      tokens - input.inputTokens - output < input.inputTokens + 512
    if (wrapup) await SubagentBudget.wrapup(input.sessionID)
    if (wrapup && input.internal)
      throw new SubagentBudget.LimitError("budget_wrapup", "Internal work deferred to preserve the subagent handoff")
    return { maxOutputTokens: output, wrapup, notice: wrapup ? notice : undefined }
  }
  export async function begin(input: Context & { callID: string; body: unknown; outputBound?: number }) {
    const state = await checked(input)
    if (!state) return
    if (state.worker.wrapup && input.internal)
      throw new SubagentBudget.LimitError("budget_wrapup", "Internal work deferred to preserve the subagent handoff")
    const text = typeof input.body === "string" ? input.body : JSON.stringify(input.body ?? {})
    const body: Record<string, unknown> = JSON.parse(text)
    const cap = body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens
    const output = typeof cap === "number" ? cap : (input.outputBound ?? 2048)
    const tokens = Buffer.byteLength(text) + output + 256
    const amount = state.worker.unit === "tokens" ? tokens : rate(input).mul(tokens).ceil().toNumber()
    await SubagentBudget.reserve(input.sessionID, input.callID, amount, !!state.worker.wrapup && !input.internal)
  }
  export async function complete(
    input: Context & { callID: string; usage: LanguageModelUsage; metadata?: ProviderMetadata; tier?: string },
  ) {
    const state = await SubagentBudget.read(input.sessionID)
    if (!state) return
    const observed = UsageLogging.reported(input.usage, input.metadata, input.model.providerID)
    const normalized = Session.getUsage({
      model: input.model,
      usage: input.usage,
      metadata: input.metadata,
      tier: input.tier,
      fundingFeeBps: input.route === "managed" ? ManagedPricing.fundingFeeBps(input.model, input.tier) : undefined,
    })
    const known = observed.usage.input_tokens !== null && observed.usage.output_tokens !== null
    const amount =
      state.worker.unit === "tokens"
        ? known
          ? normalized.tokens.input +
            normalized.tokens.cache.read +
            normalized.tokens.cache.write +
            normalized.tokens.output
          : undefined
        : normalized.costSource === "unknown" || (normalized.costSource === "catalog_estimate" && !known)
          ? undefined
          : SubagentBudget.dollars(normalized.cost)
    await SubagentBudget.settle(input.sessionID, input.callID, amount)
  }
}

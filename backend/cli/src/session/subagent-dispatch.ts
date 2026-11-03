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
  type Context = { sessionID: string; model: Provider.Model; route: AccessRoute; internal?: boolean; tier?: string }
  const notice =
    "Runtime allowance notice: this saved assignment is already in its final handoff. Return supported findings, artifacts, checks, remaining work and limitations without further tools. Start with Outcome: Complete or Outcome: Incomplete. The remaining allowance and hard deadline still apply."
  const deadlineNotice =
    "Runtime deadline notice: this saved assignment is already in its final handoff. Return supported findings, artifacts, checks, remaining work and limitations without further tools. Start with Outcome: Complete or Outcome: Incomplete. The remaining allowance and hard deadline still apply."

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
  export function unit(model: Provider.Model, route: AccessRoute): SubagentBudget.Unit {
    if (route === "managed" || route === "byok") return "usd"
    if (
      (route === "local" || route === "custom") &&
      prices({ cost: model.cost, modes: model.modes }).some((price) => price > 0)
    )
      return "usd"
    return "tokens"
  }
  function estimate(input: Context, unit: SubagentBudget.Unit, inputTokens: number) {
    const price = Session.pricing(input.model, inputTokens, input.tier)
    return unit === "tokens"
      ? { input: new Decimal(1), output: new Decimal(1) }
      : {
          input: new Decimal(Math.max(price?.input ?? 0, price?.cache?.read ?? 0, price?.cache?.write ?? 0)).mul(1000),
          output: new Decimal(price?.output ?? 0).mul(1000),
        }
  }
  async function checked(input: Context, inputTokens: number) {
    const state = await SubagentBudget.read(input.sessionID)
    if (!state) return
    const w = state.worker
    const reason =
      w.deadline <= Date.now()
        ? "deadline"
        : w.route !== input.route || w.model.providerID !== input.model.providerID || w.model.modelID !== input.model.id
          ? "route_changed"
          : w.stopReason && w.stopReason !== "budget_wrapup" && w.stopReason !== "deadline_wrapup"
            ? w.stopReason
            : undefined
    if (reason) {
      await SubagentBudget.stop(input.sessionID, reason)
      throw new SubagentBudget.LimitError(reason)
    }
    if (!w.active) throw new SubagentBudget.LimitError("cancelled", "Subagent assignment is no longer active")
    const rates = estimate(input, w.unit, inputTokens)
    if (w.unit === "usd" && !rates.input.greaterThan(0) && !rates.output.greaterThan(0)) {
      await SubagentBudget.stop(input.sessionID, "pricing_unavailable")
      throw new SubagentBudget.LimitError(
        "pricing_unavailable",
        "Reliable model pricing is required for a USD subagent allowance",
      )
    }
    return { ...state, rates }
  }
  export async function prepare(input: Context & { inputTokens: number; maxOutputTokens?: number }) {
    const state = await checked(input, input.inputTokens)
    if (!state) return
    const remaining = new Decimal(SubagentBudget.spendable(state.pool, input.sessionID))
    const desired = input.maxOutputTokens ?? 2048
    const inputCost = state.rates.input.mul(input.inputTokens)
    const affordable = state.rates.output.isZero()
      ? inputCost.lessThanOrEqualTo(remaining)
        ? desired
        : 0
      : Decimal.max(0, remaining.minus(inputCost).div(state.rates.output).floor()).toNumber()
    const output = Math.min(desired, affordable)
    if (output < 1) {
      const reason = state.worker.unit === "usd" ? "budget_limit" : "token_limit"
      await SubagentBudget.stop(input.sessionID, reason)
      const minimum = inputCost.plus(state.rates.output)
      const amount = (value: Decimal) =>
        state.worker.unit === "usd" ? `USD ${value.div(1_000_000_000).toString()}` : `${value.toString()} tokens`
      throw new SubagentBudget.LimitError(
        reason,
        `Subagent limit cannot cover another call and its input: at least ${amount(minimum)} estimated; ${amount(remaining)} available.`,
      )
    }
    // Honor saved handoff contracts; new assignments use their full work allowance.
    const wrapup = !!state.worker.wrapup
    const reason = state.worker.wrapupReason ?? "budget_wrapup"
    if (wrapup && input.internal)
      throw new SubagentBudget.LimitError(reason, "Internal work deferred to preserve the subagent handoff")
    return {
      maxOutputTokens: output,
      wrapup,
      notice: wrapup ? (reason === "deadline_wrapup" ? deadlineNotice : notice) : undefined,
    }
  }
  export async function begin(input: Context & { callID: string; body: unknown; outputBound?: number }) {
    const text = typeof input.body === "string" ? input.body : JSON.stringify(input.body ?? {})
    const body: Record<string, unknown> = JSON.parse(text)
    const tokens = Buffer.byteLength(text) + 256
    const state = await checked(input, tokens)
    if (!state) return
    if (state.worker.wrapup && input.internal)
      throw new SubagentBudget.LimitError(
        state.worker.wrapupReason ?? "budget_wrapup",
        "Internal work deferred to preserve the subagent handoff",
      )
    const cap = body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens
    const output = typeof cap === "number" ? cap : (input.outputBound ?? 2048)
    const amount = state.rates.input.mul(tokens).plus(state.rates.output.mul(output)).ceil().toNumber()
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

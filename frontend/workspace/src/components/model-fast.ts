import { fastRateLabel } from "@/context/model-pricing"

type Cost = { input: number; output: number }

export type FastCapableRoute = {
  cost?: Cost
  modes?: Record<string, unknown>
}

/** The catalog's Fast mode carries its own rates once pricing has loaded. */
function fastCost(mode: unknown): Cost | undefined {
  if (!mode || typeof mode !== "object") return
  const cost = (mode as { cost?: unknown }).cost
  if (!cost || typeof cost !== "object") return
  const input = (cost as { input?: unknown }).input
  const output = (cost as { output?: unknown }).output
  if (typeof input !== "number" || typeof output !== "number") return
  return { input, output }
}

export function exactRouteFastMode(
  route: FastCapableRoute | undefined,
  tier: string,
): { active: boolean; rate?: string } | undefined {
  if (!route || !Object.prototype.hasOwnProperty.call(route.modes ?? {}, "fast")) return
  const rate = fastRateLabel(fastCost(route.modes?.fast), route.cost)
  return { active: tier === "fast", ...(rate ? { rate } : {}) }
}

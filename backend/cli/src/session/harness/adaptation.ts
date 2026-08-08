import z from "zod"
import { HarnessContract } from "./contract"
import { HarnessEvaluation } from "./evaluation"

export namespace HarnessAdaptation {
  const Hash = z.string().regex(/^[a-f0-9]{64}$/)

  export const Event = z
    .object({
      candidateID: Hash,
      island: z.number().int().nonnegative(),
      revision: z.number().int().nonnegative(),
      status: HarnessEvaluation.Status,
      score: z.number().finite().optional(),
    })
    .strict()
    .superRefine((value, ctx) => {
      if (value.status !== "passed" || value.score !== undefined) return
      ctx.addIssue({ code: "custom", path: ["score"], message: "A passing adaptation event requires a score" })
    })
  export type Event = z.infer<typeof Event>

  export const Signal = z
    .object({
      island: z.number().int().nonnegative(),
      visits: z.number().int().nonnegative(),
      decayedVisits: z.number().finite().nonnegative(),
      improvements: z.number().int().nonnegative(),
      accumulatedImprovement: z.number().finite().nonnegative(),
      decayedReward: z.number().finite().nonnegative(),
      rewardMean: z.number().finite().nonnegative(),
      intensity: z.number().finite().min(0).max(1),
      ucb: z.number().finite().nonnegative(),
      bestID: Hash.optional(),
      bestFitness: z.number().finite().optional(),
    })
    .strict()
  export type Signal = z.infer<typeof Signal>

  export const Summary = z
    .object({
      protocolVersion: z.literal("adaptive-search-v1"),
      policySHA256: Hash,
      events: z.number().int().nonnegative(),
      stalled: z.number().int().nonnegative(),
      selectedIsland: z.number().int().nonnegative().optional(),
      globalStagnation: z.boolean(),
      islands: z.array(Signal).min(1).max(4),
    })
    .strict()
  export type Summary = z.infer<typeof Summary>

  export const Control = z
    .object({
      protocolVersion: z.literal("adaptive-search-v1"),
      policySHA256: Hash,
      eventCount: z.number().int().nonnegative(),
      stalled: z.number().int().nonnegative(),
      selectedIsland: z.number().int().nonnegative().optional(),
      targetIsland: z.number().int().nonnegative(),
      visits: z.number().int().nonnegative(),
      accumulatedImprovement: z.number().finite().nonnegative(),
      rewardMean: z.number().finite().nonnegative(),
      intensity: z.number().finite().min(0).max(1),
      draw: z.number().finite().min(0).max(1),
      explore: z.boolean(),
      globalStagnation: z.boolean(),
    })
    .strict()
  export type Control = z.infer<typeof Control>

  const digest = (input: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(input)).digest("hex")

  export const fingerprint = (policy: HarnessContract.Search) => digest(HarnessContract.Search.parse(policy))

  export function derive(input: {
    policy: HarnessContract.Search
    direction: "maximize" | "minimize"
    islands: number
    events: Event[]
  }): Summary {
    const policy = HarnessContract.Search.parse(input.policy)
    const count = z.number().int().min(1).max(4).parse(input.islands)
    const events = input.events
      .map((event) => Event.parse(event))
      .toSorted((a, b) => a.revision - b.revision || a.candidateID.localeCompare(b.candidateID))
    if (new Set(events.map((event) => event.candidateID)).size !== events.length) {
      throw new Error(`Adaptive search may consume at most one final event per candidate`)
    }
    if (events.some((event) => event.island >= count)) {
      throw new Error(`Adaptive search event references an unknown island`)
    }
    const state = Array.from({ length: count }, (_, island) => ({
      island,
      visits: 0,
      decayedVisits: 0,
      improvements: 0,
      accumulatedImprovement: 0,
      decayedReward: 0,
      bestID: undefined as string | undefined,
      bestFitness: undefined as number | undefined,
    }))
    const global = { best: undefined as number | undefined, stalled: 0 }
    for (const event of events) {
      const item = state[event.island]!
      const fitness =
        event.status === "passed" ? (input.direction === "maximize" ? event.score! : -event.score!) : undefined
      const local = item.bestFitness
      const gain = fitness === undefined || local === undefined ? 0 : Math.max(fitness - local, 0)
      const delta = local === undefined ? 0 : Math.min(gain / Math.max(Math.abs(local), policy.signal.epsilon), 1)
      const globalGain = global.best === undefined ? 0 : gain / Math.max(Math.abs(global.best), policy.signal.epsilon)
      const reward = Math.min(Math.max(globalGain, 0), 1)
      item.visits += 1
      item.decayedVisits = policy.signal.decay * item.decayedVisits + 1
      item.accumulatedImprovement =
        policy.signal.decay * item.accumulatedImprovement + (1 - policy.signal.decay) * delta ** 2
      item.decayedReward = policy.signal.decay * item.decayedReward + reward
      if (fitness !== undefined && (local === undefined || fitness > local)) {
        item.bestFitness = fitness
        item.bestID = event.candidateID
        if (local !== undefined) item.improvements += 1
      }
      const improved = fitness !== undefined && (global.best === undefined || fitness > global.best)
      global.stalled = improved ? 0 : global.stalled + 1
      if (improved) global.best = fitness
    }
    const total = Math.max(
      1,
      state.reduce((sum, item) => sum + item.visits, 0),
    )
    const islands = state.map((item) => {
      const rewardMean = item.decayedVisits ? item.decayedReward / item.decayedVisits : 0
      const intensity =
        policy.local.minIntensity +
        (policy.local.maxIntensity - policy.local.minIntensity) /
          (1 + Math.sqrt(item.accumulatedImprovement + policy.signal.epsilon))
      const bonus = item.visits ? policy.global.exploration * Math.sqrt(Math.log(total + 1) / item.visits) : 0
      return Signal.parse({ ...item, rewardMean, intensity, ucb: rewardMean + bonus })
    })
    const active = islands.filter((item) => item.visits)
    const cold = active.filter((item) => item.visits < policy.global.minVisits)
    const selected = (cold.length ? cold : active).toSorted(
      (a, b) =>
        (cold.length ? a.visits - b.visits : b.ucb - a.ucb) || b.rewardMean - a.rewardMean || a.island - b.island,
    )[0]
    return Summary.parse({
      protocolVersion: policy.protocolVersion,
      policySHA256: fingerprint(policy),
      events: events.length,
      stalled: global.stalled,
      selectedIsland: selected?.island,
      globalStagnation:
        active.length > 0 &&
        global.stalled >= policy.stagnation.patience &&
        active.every((item) => item.accumulatedImprovement <= policy.stagnation.maxSignal),
      islands,
    })
  }

  export function control(input: {
    policy: HarnessContract.Search
    direction: "maximize" | "minimize"
    islands: number
    events: Event[]
    targetIsland: number
    key: string
  }): Control {
    const summary = derive(input)
    const signal = summary.islands[input.targetIsland]
    if (!signal) throw new Error(`Adaptive search target references an unknown island`)
    const token = digest({
      key: input.key,
      policySHA256: summary.policySHA256,
      island: signal.island,
      events: summary.events,
    })
    const draw = Number.parseInt(token.slice(0, 13), 16) / 0xfffffffffffff
    return Control.parse({
      protocolVersion: summary.protocolVersion,
      policySHA256: summary.policySHA256,
      eventCount: summary.events,
      stalled: summary.stalled,
      selectedIsland: summary.selectedIsland,
      targetIsland: signal.island,
      visits: signal.visits,
      accumulatedImprovement: signal.accumulatedImprovement,
      rewardMean: signal.rewardMean,
      intensity: signal.intensity,
      draw,
      explore: draw < signal.intensity,
      globalStagnation: summary.globalStagnation,
    })
  }
}

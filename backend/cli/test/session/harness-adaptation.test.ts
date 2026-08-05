import { describe, expect, test } from "bun:test"
import { HarnessAdaptation } from "../../src/session/harness/adaptation"
import { HarnessContract } from "../../src/session/harness/contract"

const id = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")

describe("verified adaptive search controller", () => {
  test("implements decayed local improvement and globally normalized reward exactly", () => {
    const events: HarnessAdaptation.Event[] = [
      { candidateID: id("a"), island: 0, revision: 1, status: "passed", score: 10 },
      { candidateID: id("b"), island: 1, revision: 2, status: "passed", score: 8 },
      { candidateID: id("c"), island: 0, revision: 3, status: "passed", score: 12 },
    ]
    const improved = HarnessAdaptation.derive({
      policy: HarnessContract.adaptiveSearch,
      direction: "maximize",
      islands: 2,
      events,
    })
    expect(improved).toMatchObject({ events: 3, stalled: 0, selectedIsland: 1, globalStagnation: false })
    expect(improved.islands[0]).toMatchObject({
      visits: 2,
      decayedVisits: 1.9,
      improvements: 1,
      accumulatedImprovement: 0.004,
      decayedReward: 0.2,
    })
    expect(improved.islands[0]!.rewardMean).toBeCloseTo(0.2 / 1.9, 12)

    const decayed = HarnessAdaptation.derive({
      policy: HarnessContract.adaptiveSearch,
      direction: "maximize",
      islands: 2,
      events: [...events, { candidateID: id("d"), island: 0, revision: 4, status: "passed", score: 11 }],
    })
    expect(decayed.islands[0]!.accumulatedImprovement).toBeCloseTo(0.0036, 12)
    expect(decayed.islands[0]!.decayedReward).toBeCloseTo(0.18, 12)
    expect(decayed.islands[0]!.decayedVisits).toBeCloseTo(2.71, 12)
    expect(decayed.stalled).toBe(1)
  })

  test("handles minimizing negative metrics without inverting improvement", () => {
    const result = HarnessAdaptation.derive({
      policy: HarnessContract.adaptiveSearch,
      direction: "minimize",
      islands: 1,
      events: [
        { candidateID: id("negative-baseline"), island: 0, revision: 1, status: "passed", score: -10 },
        { candidateID: id("negative-improvement"), island: 0, revision: 2, status: "passed", score: -12 },
      ],
    })
    expect(result.islands[0]).toMatchObject({
      visits: 2,
      improvements: 1,
      bestID: id("negative-improvement"),
      bestFitness: 12,
      accumulatedImprovement: 0.004,
      decayedReward: 0.2,
    })
  })

  test("decays failed attempts, triggers measured stagnation, and remains deterministic", () => {
    const events: HarnessAdaptation.Event[] = [
      { candidateID: id("seed"), island: 0, revision: 1, status: "passed", score: 1 },
      ...Array.from({ length: 5 }, (_, index) => ({
        candidateID: id(`failure-${index}`),
        island: 0,
        revision: index + 2,
        status: "failed" as const,
      })),
    ]
    const summary = HarnessAdaptation.derive({
      policy: HarnessContract.adaptiveSearch,
      direction: "maximize",
      islands: 1,
      events,
    })
    expect(summary).toMatchObject({ events: 6, stalled: 5, selectedIsland: 0, globalStagnation: true })
    const input = {
      policy: HarnessContract.adaptiveSearch,
      direction: "maximize" as const,
      islands: 1,
      events,
      targetIsland: 0,
      key: "run:session:revision",
    }
    expect(HarnessAdaptation.control(input)).toEqual(HarnessAdaptation.control(input))
    expect(HarnessAdaptation.control(input)).toMatchObject({
      eventCount: 6,
      stalled: 5,
      selectedIsland: 0,
      targetIsland: 0,
      globalStagnation: true,
    })
  })

  test("fails closed on duplicate candidate events and out-of-range islands", () => {
    const event = { candidateID: id("duplicate"), island: 0, revision: 1, status: "passed" as const, score: 1 }
    expect(() =>
      HarnessAdaptation.derive({
        policy: HarnessContract.adaptiveSearch,
        direction: "maximize",
        islands: 1,
        events: [event, { ...event, revision: 2 }],
      }),
    ).toThrow("at most one final event")
    expect(() =>
      HarnessAdaptation.derive({
        policy: HarnessContract.adaptiveSearch,
        direction: "maximize",
        islands: 1,
        events: [{ ...event, island: 1 }],
      }),
    ).toThrow("unknown island")
  })
})

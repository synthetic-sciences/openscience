import { describe, expect, test } from "bun:test"
import { HarnessProfile } from "../../src/session/harness/profile"
import type { HarnessContract } from "../../src/session/harness/contract"

const cases: Array<[string, string, HarnessContract.Profile]> = [
  ["research", "Optimize this Kaggle benchmark score and iterate on submissions.", "optimize"],
  ["research", "Reproduce the main result from this paper and its experiment.", "reproduce"],
  ["physics", "Derive the Hamiltonian for this theoretical system.", "theory"],
  ["physics", "Build a finite element PDE solver and verify it.", "numerical"],
  ["ml", "Post-train this model with SFT and GRPO.", "training"],
  ["ml", "Train and evaluate a weather forecasting model.", "forecast"],
]

describe("harness profile router", () => {
  test("keeps ordinary work on the direct ReAct control", () => {
    const result = HarnessProfile.classify({ agent: "research", text: "Summarize the methods section in this file." })
    expect(result).toMatchObject({ id: "react", source: "control", confidence: 1 })
    expect(result.prompt).toContain("smallest reliable path")
    expect(HarnessProfile.classify({ agent: "research", text: "Improve the benchmark documentation." }).id).toBe(
      "react",
    )
  })

  test.each(cases)("routes %s tasks with strong observable evidence", (agent, text, id) => {
    expect(HarnessProfile.classify({ agent, text }).id).toBe(id)
  })

  test("lets an explicit benchmark contract override keyword heuristics", () => {
    const contract = {
      profile: "numerical",
      runID: "run-contract",
    } as HarnessContract.Info
    const result = HarnessProfile.classify({
      agent: "research",
      text: "Optimize the leaderboard score.",
      contract,
    })
    expect(result).toMatchObject({ id: "numerical", source: "contract", confidence: 1 })
    expect(result.reasons).toEqual(["contract:run-contract"])
  })
})

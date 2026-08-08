import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Global } from "../../src/global"
import { RSICritic } from "../../src/session/rsi/critic"
import { RSIDistill } from "../../src/session/rsi/distill"
import type { RSITrajectory } from "../../src/session/rsi/trajectory"

const proposals = new Set<string>()

afterEach(async () => {
  await Promise.all(
    [...proposals].map((name) =>
      fs.rm(path.join(Global.Path.data, "learned-skill-proposals", name), { recursive: true, force: true }),
    ),
  )
  proposals.clear()
})

function trajectory(): RSITrajectory.Trajectory {
  return {
    sessionId: "session-12345678",
    timestamp: Date.now(),
    agent: "research",
    hypothesis: "A verified workflow improves a benchmark metric on held-out tasks.",
    steps: [
      { tool: "read", inputSummary: "data", outputSummary: "schema" },
      { tool: "bash", inputSummary: "baseline", outputSummary: "0.5" },
      { tool: "edit", inputSummary: "candidate", outputSummary: "saved" },
      { tool: "bash", inputSummary: "evaluate", outputSummary: "0.8" },
    ],
    reportedOutcome: "success",
    outcome: "unverified",
    tokenCost: 1000,
  }
}

describe("RSI verification boundary", () => {
  test("assigns no correctness credit to self-reported completion", () => {
    const score = RSICritic.evaluate(trajectory())
    expect(score.correctness).toBe(0)
    expect(score.notes).toContain("verification=unverified")
  })

  test("drafts only externally verified skill proposals", async () => {
    const unverified = trajectory()
    unverified.score = 100
    expect(await RSIDistill.propose(unverified)).toBeNull()

    const verified = trajectory()
    verified.outcome = "success"
    verified.verification = {
      runID: "run-1",
      evaluator: "official-evaluator",
      status: "passed",
      score: 0.8,
      evaluatedAt: Date.now(),
    }
    verified.score = RSICritic.evaluate(verified).total
    const name = await RSIDistill.propose(verified)
    expect(name).not.toBeNull()
    proposals.add(name!)
    const skill = await Bun.file(path.join(Global.Path.data, "learned-skill-proposals", name!, "SKILL.md")).text()
    expect(skill).toContain("source: rsi-proposal")
    expect(skill).toContain("status: pending")
    expect(skill).toContain("not active until held-out evaluation")
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessEvaluation } from "../../src/session/harness/evaluation"
import { HarnessSearch } from "../../src/session/harness/search"

const sessions = new Set<string>()
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")

afterEach(async () => {
  await Promise.all(
    [...sessions].flatMap((sessionID) =>
      ["contracts", "evaluations", "search"].map((name) =>
        fs.rm(path.join(Global.Path.data, "harness", name, `${encodeURIComponent(sessionID)}.json`), { force: true }),
      ),
    ),
  )
  sessions.clear()
})

function contract(
  sessionID: string,
  input?: { profile?: HarnessContract.Profile; direction?: "maximize" | "minimize" },
) {
  sessions.add(sessionID)
  return HarnessContract.bind({
    schemaVersion: 1,
    runID: `run-${sessionID}`,
    sessionID,
    objective: "Improve the held-out score under a fixed candidate budget",
    benchmark: {
      name: "search-test",
      version: "1",
      taskID: "task-1",
      split: "held_out",
      evaluator: "official-evaluator",
      metric: "score",
      direction: input?.direction ?? "maximize",
    },
    profile: input?.profile ?? "optimize",
    model: { provider: "test", name: "model" },
    tools: [],
    skills: [],
    budget: { steps: 20 },
    seed: 7,
    intervention: "autonomous",
    contamination: { policy: "hidden tests stay hidden", hiddenTestsAccessible: false },
    createdAt: Date.now(),
  })
}

const artifact = (name: string) => ({ uri: `candidate://${name}`, sha256: hash(name) })

async function setup(
  sessionID: string,
  input?: { candidates?: number; stall?: number; target?: number; direction?: "maximize" | "minimize" },
) {
  await contract(sessionID, { direction: input?.direction })
  return HarnessSearch.initialize({
    sessionID,
    candidates: input?.candidates ?? 8,
    stall: input?.stall,
    target: input?.target,
  })
}

async function add(sessionID: string, name: string, parentIDs: string[] = [], branch = name) {
  return HarnessSearch.add({
    sessionID,
    parentIDs,
    branch,
    proposal: `proposal ${name}`,
    artifact: artifact(name),
  })
}

async function evaluate(
  sessionID: string,
  candidateID: string,
  score: number | undefined,
  status: HarnessEvaluation.Status = "passed",
) {
  await HarnessEvaluation.record({
    schemaVersion: 1,
    runID: `run-${sessionID}`,
    sessionID,
    subject: { type: "candidate", id: candidateID },
    evaluator: { name: "official-evaluator", version: "1", source: "benchmark" },
    status,
    ...(score === undefined ? {} : { score }),
    metrics: score === undefined ? {} : { score },
    checks: [{ id: "gate", status, blocking: true, evidence: [`candidate:${candidateID}`] }],
    evidence: [`report:${candidateID}`],
    evaluatedAt: Date.now(),
  })
  return HarnessSearch.verify({ sessionID, candidateID })
}

describe("harness candidate graph", () => {
  test("requires an explicit optimize benchmark contract", async () => {
    sessions.add("search-missing")
    await expect(HarnessSearch.initialize({ sessionID: "search-missing", candidates: 4 })).rejects.toThrow(
      "No harness contract",
    )
    await contract("search-react", { profile: "react" })
    await expect(HarnessSearch.initialize({ sessionID: "search-react", candidates: 4 })).rejects.toThrow(
      "optimize profile",
    )
  })

  test("initializes idempotently but rejects budget drift", async () => {
    await setup("search-init", { candidates: 4, stall: 2 })
    const first = await HarnessSearch.initialize({ sessionID: "search-init", candidates: 4, stall: 2 })
    expect(first.budget).toEqual({ candidates: 4, stall: 2 })
    await expect(HarnessSearch.initialize({ sessionID: "search-init", candidates: 5, stall: 2 })).rejects.toThrow(
      "different contract or budget",
    )
  })

  test("content-addresses candidates and deduplicates without spending budget", async () => {
    await setup("search-dedupe", { candidates: 2 })
    const first = await add("search-dedupe", "seed")
    const duplicate = await add("search-dedupe", "seed")
    expect(first.id).toHaveLength(64)
    expect(duplicate).toMatchObject({ accepted: true, id: first.id })
    expect(Object.keys(duplicate.state.candidates)).toHaveLength(1)
  })

  test("allows only one parentless seed", async () => {
    await setup("search-seed")
    await add("search-seed", "seed")
    await expect(add("search-seed", "orphan")).rejects.toThrow("Only the first candidate")
  })

  test("rejects unknown, duplicate, and unverified parents", async () => {
    await setup("search-parents")
    const seed = await add("search-parents", "seed")
    await expect(add("search-parents", "unknown", [hash("unknown")])).rejects.toThrow("must exist")
    await expect(add("search-parents", "duplicate", [seed.id, seed.id])).rejects.toThrow("must be unique")
    await expect(add("search-parents", "unverified", [seed.id])).rejects.toThrow("externally verified")
  })

  test("keeps self-reported observations out of elite state and lineage", async () => {
    await setup("search-observed")
    const seed = await add("search-observed", "seed")
    const state = await HarnessSearch.observe({
      sessionID: "search-observed",
      candidateID: seed.id,
      status: "passed",
      score: 999,
      feedback: "agent says this is excellent",
    })
    expect(state.bestID).toBeUndefined()
    expect(HarnessSearch.recommend(state)).toMatchObject({ strategy: "seed", parentIDs: [] })
    await expect(add("search-observed", "child", [seed.id])).rejects.toThrow("externally verified")
  })

  test("requires the external evaluation to name the exact candidate", async () => {
    await setup("search-subject")
    const seed = await add("search-subject", "seed")
    await HarnessEvaluation.record({
      schemaVersion: 1,
      runID: "run-search-subject",
      sessionID: "search-subject",
      subject: { type: "run", id: "run-search-subject" },
      evaluator: { name: "official-evaluator", version: "1", source: "benchmark" },
      status: "passed",
      score: 1,
      metrics: { score: 1 },
      checks: [{ id: "gate", status: "passed", blocking: true, evidence: ["run"] }],
      evidence: ["run-report"],
      evaluatedAt: Date.now(),
    })
    await expect(HarnessSearch.verify({ sessionID: "search-subject", candidateID: seed.id })).rejects.toThrow(
      "not bound to candidate",
    )
  })

  test("promotes only passing externally evaluated candidates", async () => {
    await setup("search-verified")
    const seed = await add("search-verified", "seed")
    const failed = await evaluate("search-verified", seed.id, 100, "failed")
    expect(failed.bestID).toBeUndefined()
    expect(failed.candidates[seed.id]?.result?.source).toBe("verified")
    await expect(add("search-verified", "child", [seed.id])).rejects.toThrow("externally verified passing")
  })

  test("ranks verified scores in the declared direction", async () => {
    await setup("search-rank")
    const seed = await add("search-rank", "seed", [], "baseline")
    await evaluate("search-rank", seed.id, 0.5)
    const child = await add("search-rank", "child", [seed.id], "improved")
    const state = await evaluate("search-rank", child.id, 0.8)
    expect(state.bestID).toBe(child.id)
    expect(state.stalled).toBe(0)
  })

  test("preserves branch diversity during early exploration", async () => {
    await setup("search-explore", { candidates: 10 })
    const seed = await add("search-explore", "seed", [], "baseline")
    await evaluate("search-explore", seed.id, 0.5)
    const a = await add("search-explore", "a", [seed.id], "common")
    await evaluate("search-explore", a.id, 0.9)
    const b = await add("search-explore", "b", [seed.id], "rare")
    await evaluate("search-explore", b.id, 0.6)
    const a2 = await add("search-explore", "a2", [a.id], "common")
    const state = await evaluate("search-explore", a2.id, 0.8)
    const choice = HarnessSearch.recommend(state)
    expect(choice.strategy).toBe("explore")
    expect(choice.parentIDs).toEqual([b.id])
  })

  test("switches to verified-rank exploitation after half the budget", async () => {
    await setup("search-exploit", { candidates: 6 })
    const seed = await add("search-exploit", "seed", [], "base")
    await evaluate("search-exploit", seed.id, 0.5)
    const a = await add("search-exploit", "a", [seed.id], "a")
    await evaluate("search-exploit", a.id, 0.7)
    const b = await add("search-exploit", "b", [seed.id], "b")
    const state = await evaluate("search-exploit", b.id, 0.9)
    expect(HarnessSearch.recommend(state)).toMatchObject({ strategy: "exploit", parentIDs: [b.id] })
  })

  test("minimizes when the benchmark contract declares a loss metric", async () => {
    await setup("search-minimize", { direction: "minimize" })
    const seed = await add("search-minimize", "seed", [], "base")
    await evaluate("search-minimize", seed.id, 0.5)
    const child = await add("search-minimize", "child", [seed.id], "lower-loss")
    const state = await evaluate("search-minimize", child.id, 0.2)
    expect(state.bestID).toBe(child.id)
  })

  test("recommends cross-branch fusion after verified stagnation", async () => {
    await setup("search-fuse", { candidates: 8, stall: 1 })
    const seed = await add("search-fuse", "seed", [], "base")
    await evaluate("search-fuse", seed.id, 0.9)
    const weaker = await add("search-fuse", "weaker", [seed.id], "alternate")
    const state = await evaluate("search-fuse", weaker.id, 0.7)
    expect(state.stalled).toBe(1)
    expect(HarnessSearch.recommend(state)).toMatchObject({
      strategy: "fuse",
      parentIDs: [seed.id, weaker.id],
    })
  })

  test("enforces the candidate budget transactionally and survives restart", async () => {
    await setup("search-budget", { candidates: 1 })
    const seed = await add("search-budget", "seed")
    await evaluate("search-budget", seed.id, 0.5)
    const rejected = await add("search-budget", "overflow", [seed.id])
    expect(rejected.accepted).toBe(false)
    expect(rejected.state).toMatchObject({ status: "completed", stopReason: "budget_exhausted" })
    expect(Object.keys(await HarnessSearch.read("search-budget").then((state) => state.candidates))).toHaveLength(1)
  })

  test("serializes concurrent branches against one remaining budget slot", async () => {
    await setup("search-concurrent", { candidates: 2 })
    const seed = await add("search-concurrent", "seed")
    await evaluate("search-concurrent", seed.id, 0.5)
    const results = await Promise.all([
      add("search-concurrent", "branch-a", [seed.id], "a"),
      add("search-concurrent", "branch-b", [seed.id], "b"),
    ])
    expect(results.filter((result) => result.accepted)).toHaveLength(1)
    const state = await HarnessSearch.read("search-concurrent")
    expect(Object.keys(state.candidates)).toHaveLength(2)
    expect(state).toMatchObject({ status: "completed", stopReason: "budget_exhausted" })
  })

  test("stops immediately when the declared target is reached", async () => {
    await setup("search-target", { target: 0.8 })
    const seed = await add("search-target", "seed")
    const state = await evaluate("search-target", seed.id, 0.81)
    expect(state).toMatchObject({ status: "completed", stopReason: "objective_met", bestID: seed.id })
  })

  test("makes verified evaluations immutable and manual stops resumable", async () => {
    await setup("search-stop")
    const seed = await add("search-stop", "seed")
    await evaluate("search-stop", seed.id, 0.5)
    await HarnessEvaluation.record({
      ...(await HarnessEvaluation.read("search-stop"))!,
      score: 0.6,
      metrics: { score: 0.6 },
    })
    await expect(HarnessSearch.verify({ sessionID: "search-stop", candidateID: seed.id })).rejects.toThrow("immutable")
    const stopped = await HarnessSearch.finish("search-stop", "user_cancelled")
    expect(await HarnessSearch.read("search-stop")).toEqual(stopped)
  })
})

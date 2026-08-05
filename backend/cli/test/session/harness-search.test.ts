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
  input?: {
    profile?: HarnessContract.Profile
    direction?: "maximize" | "minimize"
    candidates?: number
    wallTimeMs?: number
    objectives?: HarnessContract.Objectives
  },
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
      objectives: input?.objectives,
    },
    profile: input?.profile ?? "optimize",
    model: { provider: "test", name: "model" },
    tools: [],
    skills: [],
    budget: {
      steps: 20,
      ...(input?.candidates === undefined ? {} : { candidates: input.candidates }),
      ...(input?.wallTimeMs === undefined ? {} : { wallTimeMs: input.wallTimeMs }),
    },
    seed: 7,
    intervention: "autonomous",
    contamination: { policy: "hidden tests stay hidden", hiddenTestsAccessible: false },
    createdAt: Date.now(),
  })
}

const artifact = (name: string) => ({ uri: `candidate://${name}`, sha256: hash(name) })

async function setup(
  sessionID: string,
  input?: {
    candidates?: number
    stall?: number
    target?: number
    direction?: "maximize" | "minimize"
    objectives?: HarnessContract.Objectives
    leased?: boolean
  },
) {
  await contract(sessionID, { direction: input?.direction, objectives: input?.objectives })
  const state = await HarnessSearch.initialize({
    sessionID,
    candidates: input?.candidates ?? 8,
    stall: input?.stall,
    target: input?.target,
  })
  if (input?.leased) return state
  const target = path.join(Global.Path.data, "harness", "search", `${encodeURIComponent(sessionID)}.json`)
  const advisory = JSON.parse(await fs.readFile(target, "utf8"))
  advisory.schemaVersion = 2
  delete advisory.proposalPolicy
  await fs.writeFile(target, JSON.stringify(advisory))
  return HarnessSearch.read(sessionID)
}

async function add(
  sessionID: string,
  name: string,
  parentIDs: string[] = [],
  branch = name,
  inspirationIDs: string[] = [],
) {
  return HarnessSearch.add({
    sessionID,
    parentIDs,
    inspirationIDs,
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
  metrics: Record<string, number> = {},
) {
  await HarnessEvaluation.record({
    schemaVersion: 1,
    runID: `run-${sessionID}`,
    sessionID,
    subject: { type: "candidate", id: candidateID },
    evaluator: { name: "official-evaluator", version: "1", source: "benchmark" },
    status,
    ...(score === undefined ? {} : { score }),
    metrics: score === undefined ? metrics : { score, ...metrics },
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

  test("uses contract budgets and rejects attempted expansion", async () => {
    await contract("search-contract-budget", { candidates: 2, wallTimeMs: 1_000 })
    const state = await HarnessSearch.initialize({ sessionID: "search-contract-budget" })
    expect(state.budget).toMatchObject({ candidates: 2, wallTimeMs: 1_000 })
    await expect(HarnessSearch.initialize({ sessionID: "search-contract-budget", candidates: 3 })).rejects.toThrow(
      "cannot exceed",
    )
  })

  test("leases adaptive generation modes and bounded verified trajectory context", async () => {
    const initial = await setup("search-leased", { candidates: 8, leased: true })
    const seed = HarnessSearch.recommend(initial)
    expect(initial.proposalPolicy).toBe("leased-v3")
    expect(seed).toMatchObject({
      revision: 0,
      strategy: "seed",
      mode: "single-pass",
      parentIDs: [],
      inspirationIDs: [],
      targetIsland: 0,
      contextIDs: [],
    })
    await expect(
      HarnessSearch.add({
        sessionID: "search-leased",
        parentIDs: [],
        branch: "missing-lease",
        proposal: "bypass the server recommendation",
        artifact: artifact("missing-lease"),
      }),
    ).rejects.toThrow("recommendation_id is required")

    const first = await HarnessSearch.add({
      sessionID: "search-leased",
      recommendationID: seed.id,
      parentIDs: seed.parentIDs,
      inspirationIDs: seed.inspirationIDs,
      branch: "baseline",
      proposal: "establish a direct baseline",
      artifact: artifact("leased-seed"),
    })
    expect(first.state.candidates[first.id]?.lease).toEqual({
      id: seed.id,
      revision: seed.revision,
      strategy: seed.strategy,
      mode: seed.mode,
      targetIsland: seed.targetIsland,
      contextIDs: seed.contextIDs,
    })
    await evaluate("search-leased", first.id, 0.9)
    const explore = HarnessSearch.recommend(await HarnessSearch.read("search-leased"))
    expect(explore).toMatchObject({ strategy: "explore", mode: "stepwise", parentIDs: [], contextIDs: [] })

    await expect(
      HarnessSearch.add({
        sessionID: "search-leased",
        recommendationID: seed.id,
        parentIDs: [],
        branch: "stale",
        proposal: "race an obsolete state revision",
        artifact: artifact("stale-lease"),
      }),
    ).rejects.toThrow("stale")
    await expect(
      HarnessSearch.add({
        sessionID: "search-leased",
        recommendationID: explore.id,
        parentIDs: [first.id],
        branch: "off-policy",
        proposal: "replace the leased independent root with a local edit",
        artifact: artifact("off-policy"),
      }),
    ).rejects.toThrow("does not match")

    const alternate = await HarnessSearch.add({
      sessionID: "search-leased",
      recommendationID: explore.id,
      parentIDs: explore.parentIDs,
      inspirationIDs: explore.inspirationIDs,
      branch: "alternate",
      proposal: "plan and implement an independent approach",
      artifact: artifact("leased-alternate"),
    })
    await evaluate("search-leased", alternate.id, 0.8)
    const migrate = HarnessSearch.recommend(await HarnessSearch.read("search-leased"))
    expect(migrate).toMatchObject({
      strategy: "migrate",
      mode: "stepwise",
      parentIDs: [alternate.id],
      inspirationIDs: [first.id],
      contextIDs: [alternate.id, first.id],
    })
    const moved = await HarnessSearch.add({
      sessionID: "search-leased",
      recommendationID: migrate.id,
      parentIDs: migrate.parentIDs,
      inspirationIDs: migrate.inspirationIDs,
      branch: "alternate",
      proposal: "transfer the verified source insight into the target lineage",
      artifact: artifact("leased-migration"),
    })
    const next = HarnessSearch.recommend(moved.state)
    expect(next.contextIDs).not.toContain(moved.id)
    expect(next.contextIDs.every((id) => moved.state.candidates[id]?.result?.source === "verified")).toBe(true)
  })

  test("requests focused diffs for exploitation and serializes recommendation races", async () => {
    const initial = await setup("search-lease-race", { candidates: 2, leased: true })
    const seed = HarnessSearch.recommend(initial)
    const attempts = await Promise.allSettled(
      ["a", "b"].map((name) =>
        HarnessSearch.add({
          sessionID: "search-lease-race",
          recommendationID: seed.id,
          parentIDs: seed.parentIDs,
          inspirationIDs: seed.inspirationIDs,
          branch: name,
          proposal: `concurrent proposal ${name}`,
          artifact: artifact(`lease-race-${name}`),
        }),
      ),
    )
    expect(attempts.filter((item) => item.status === "fulfilled")).toHaveLength(1)
    expect(attempts.filter((item) => item.status === "rejected")).toHaveLength(1)
    const state = await HarnessSearch.read("search-lease-race")
    const first = Object.values(state.candidates)[0]!
    await evaluate("search-lease-race", first.id, 0.5)
    const exploit = HarnessSearch.recommend(await HarnessSearch.read("search-lease-race"))
    expect(exploit).toMatchObject({ strategy: "exploit", mode: "diff", parentIDs: [first.id] })
    expect(exploit.contextIDs).toEqual([first.id])
  })

  test("fails closed when leased recommendation provenance is edited", async () => {
    const initial = await setup("search-lease-tamper", { leased: true })
    const recommendation = HarnessSearch.recommend(initial)
    const seed = await HarnessSearch.add({
      sessionID: "search-lease-tamper",
      recommendationID: recommendation.id,
      parentIDs: recommendation.parentIDs,
      inspirationIDs: recommendation.inspirationIDs,
      branch: "baseline",
      proposal: "baseline",
      artifact: artifact("lease-tamper"),
    })
    const file = path.join(Global.Path.data, "harness", "search", "search-lease-tamper.json")
    const state = JSON.parse(await fs.readFile(file, "utf8"))
    state.candidates[seed.id].lease.mode = "diff"
    await fs.writeFile(file, JSON.stringify(state))
    await expect(HarnessSearch.read("search-lease-tamper")).rejects.toThrow("identity does not match")
  })

  test("caps deep trajectory context without admitting unverified state", async () => {
    await setup("search-context-cap", { candidates: 20 })
    const seed = await add("search-context-cap", "seed", [], "line")
    await evaluate("search-context-cap", seed.id, 0.1)
    const nodes = [seed]
    for (const index of Array.from({ length: 7 }, (_, index) => index)) {
      const parent = nodes.at(-1)!
      const child = await add("search-context-cap", `child-${index}`, [parent.id], "line")
      await evaluate("search-context-cap", child.id, 0.2 + index / 10)
      nodes.push(child)
    }
    const state = await HarnessSearch.read("search-context-cap")
    const recommendation = HarnessSearch.recommend(state)
    expect(recommendation.mode).toBe("diff")
    expect(recommendation.contextIDs).toHaveLength(6)
    expect(recommendation.contextIDs[0]).toBe(nodes.at(-1)!.id)
    expect(recommendation.contextIDs.every((id) => state.candidates[id]?.result?.source === "verified")).toBe(true)
  })

  test("content-addresses candidates and deduplicates without spending budget", async () => {
    await setup("search-dedupe", { candidates: 2 })
    const first = await add("search-dedupe", "seed")
    const duplicate = await add("search-dedupe", "seed")
    expect(first.id).toHaveLength(64)
    expect(duplicate).toMatchObject({ accepted: true, deduplicated: true, id: first.id })
    expect(Object.keys(duplicate.state.candidates)).toHaveLength(1)

    const revision = duplicate.state.revision
    const wrapped = await HarnessSearch.add({
      sessionID: "search-dedupe",
      parentIDs: [hash("unknown-wrapper-parent")],
      inspirationIDs: [hash("unknown-wrapper-inspiration")],
      branch: "different-wrapper",
      proposal: "Claim the same bytes are a new discovery",
      artifact: { uri: "candidate://mirror", sha256: artifact("seed").sha256 },
    })
    expect(wrapped).toMatchObject({ accepted: true, deduplicated: true, id: first.id })
    expect(wrapped.state.revision).toBe(revision)
    expect(Object.keys(wrapped.state.candidates)).toHaveLength(1)
  })

  test("serializes concurrent content duplicates into one budget slot", async () => {
    await setup("search-dedupe-race", { candidates: 2 })
    const sha256 = hash("shared-bytes")
    const results = await Promise.all([
      HarnessSearch.add({
        sessionID: "search-dedupe-race",
        parentIDs: [],
        branch: "first",
        proposal: "first wrapper",
        artifact: { uri: "candidate://first", sha256 },
      }),
      HarnessSearch.add({
        sessionID: "search-dedupe-race",
        parentIDs: [],
        branch: "second",
        proposal: "second wrapper",
        artifact: { uri: "candidate://second", sha256 },
      }),
    ])
    expect(results.every((result) => result.accepted)).toBe(true)
    expect(new Set(results.map((result) => result.id)).size).toBe(1)
    expect(results.filter((result) => result.deduplicated)).toHaveLength(1)
    expect(Object.keys((await HarnessSearch.read("search-dedupe-race")).candidates)).toHaveLength(1)
  })

  test("assigns deterministic islands server-side and preserves them across restart", async () => {
    const initial = await setup("search-islands", { candidates: 8 })
    expect(initial.population).toEqual({ mode: "islands", count: 2, topology: "ring", migrationInterval: 2 })

    const first = await add("search-islands", "first", [], "line-a")
    expect(first.state.candidates[first.id]).toMatchObject({ island: 0, ordinal: 0 })
    await evaluate("search-islands", first.id, 0.9)
    const second = await add("search-islands", "second", [], "line-b")
    expect(second.state.candidates[second.id]).toMatchObject({ island: 1, ordinal: 1 })
    await evaluate("search-islands", second.id, 0.8)
    const child = await add("search-islands", "child", [first.id], "line-a")
    expect(child.state.candidates[child.id]).toMatchObject({ island: 0, ordinal: 2, parentIDs: [first.id] })
    expect(await HarnessSearch.read("search-islands")).toEqual(child.state)
  })

  test("migrates verified inspiration into a target island without copying candidate bytes", async () => {
    await setup("search-migrate", { candidates: 8, stall: 5 })
    const source = await add("search-migrate", "source", [], "source")
    await evaluate("search-migrate", source.id, 0.9)
    const target = await add("search-migrate", "target", [], "target")
    const state = await evaluate("search-migrate", target.id, 0.8)
    expect(HarnessSearch.recommend(state)).toMatchObject({
      strategy: "migrate",
      mode: "stepwise",
      parentIDs: [target.id],
      inspirationIDs: [source.id],
      targetIsland: 1,
      contextIDs: [target.id, source.id],
      reasons: ["candidates:2", "ring:0->1", "verified-inspiration", "new-artifact-required"],
    })

    const migrated = await add("search-migrate", "migrated", [target.id], "target", [source.id])
    expect(migrated.state.candidates[migrated.id]).toMatchObject({
      island: 1,
      parentIDs: [target.id],
      inspirationIDs: [source.id],
    })
    await expect(add("search-migrate", "invalid", [target.id], "target", [migrated.id])).rejects.toThrow(
      "externally verified passing inspirations",
    )
    await expect(add("search-migrate", "overlap", [source.id], "target", [source.id])).rejects.toThrow(
      "distinct from parents",
    )

    const revision = migrated.state.revision
    const copied = await HarnessSearch.add({
      sessionID: "search-migrate",
      parentIDs: [target.id],
      inspirationIDs: [source.id],
      branch: "target",
      proposal: "Copy the source elite without modifying it",
      artifact: { uri: "candidate://copied-source", sha256: artifact("source").sha256 },
    })
    expect(copied).toMatchObject({ accepted: true, deduplicated: true, id: source.id })
    expect(copied.state.revision).toBe(revision)
    expect(HarnessSearch.recommend(copied.state).strategy).not.toBe("migrate")
  })

  test("allows bounded independent roots and releases failed root capacity", async () => {
    await setup("search-seed", { candidates: 4 })
    const first = await add("search-seed", "seed", [], "branch-a")
    await evaluate("search-seed", first.id, 0, "failed")
    await add("search-seed", "replacement", [], "branch-a")
    await add("search-seed", "independent", [], "branch-b")
    await expect(add("search-seed", "overflow", [], "branch-c")).rejects.toThrow("root budget")
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

  test("preserves evaluator-declared Pareto alternatives without changing the primary winner", async () => {
    await setup("search-pareto", {
      candidates: 8,
      stall: 1,
      objectives: [
        { metric: "robustness", direction: "maximize" },
        { metric: "latency", direction: "minimize" },
      ],
    })
    const seed = await add("search-pareto", "seed", [], "accurate")
    await evaluate("search-pareto", seed.id, 0.9, "passed", { robustness: 0.2, latency: 20 })
    const alternate = await add("search-pareto", "alternate", [seed.id], "robust")
    const diverse = await evaluate("search-pareto", alternate.id, 0.8, "passed", { robustness: 0.9, latency: 10 })
    expect(diverse.bestID).toBe(seed.id)
    expect(diverse.archiveIDs).toEqual([seed.id, alternate.id])
    expect(HarnessSearch.frontier(diverse).map((item) => item.id)).toEqual([seed.id, alternate.id])
    expect(HarnessSearch.recommend(diverse)).toMatchObject({
      strategy: "fuse",
      parentIDs: [seed.id, alternate.id],
      reasons: ["stalled:1", "cross-branch-fusion", "pareto-frontier:2", "multi-metric-complementarity"],
    })

    const dominated = await add("search-pareto", "dominated", [seed.id], "weak")
    const state = await evaluate("search-pareto", dominated.id, 0.7, "passed", { robustness: 0.1, latency: 30 })
    expect(state.bestID).toBe(seed.id)
    expect(state.archiveIDs).toEqual([seed.id, alternate.id])
  })

  test("rejects incomplete or primary-duplicating objective contracts", async () => {
    await expect(
      contract("search-objective-duplicate", {
        objectives: [{ metric: "score", direction: "maximize" }],
      }),
    ).rejects.toThrow("cannot duplicate the primary")

    await setup("search-objective-missing", {
      objectives: [{ metric: "robustness", direction: "maximize" }],
    })
    const seed = await add("search-objective-missing", "seed")
    await HarnessEvaluation.record({
      schemaVersion: 1,
      runID: "run-search-objective-missing",
      sessionID: "search-objective-missing",
      subject: { type: "candidate", id: seed.id },
      evaluator: { name: "official-evaluator", version: "1", source: "benchmark" },
      status: "passed",
      score: 0.9,
      metrics: { score: 0.9 },
      checks: [{ id: "gate", status: "passed", blocking: true, evidence: [`candidate:${seed.id}`] }],
      evidence: [`report:${seed.id}`],
      evaluatedAt: Date.now(),
    })
    await expect(HarnessSearch.verify({ sessionID: "search-objective-missing", candidateID: seed.id })).rejects.toThrow(
      "missing declared objective metric robustness",
    )
  })

  test("fails closed when the persisted Pareto archive is edited", async () => {
    await setup("search-pareto-tamper", {
      objectives: [{ metric: "robustness", direction: "maximize" }],
    })
    const seed = await add("search-pareto-tamper", "seed")
    await evaluate("search-pareto-tamper", seed.id, 0.9, "passed", { robustness: 0.8 })
    const file = path.join(Global.Path.data, "harness", "search", "search-pareto-tamper.json")
    const state = JSON.parse(await fs.readFile(file, "utf8"))
    state.archiveIDs = []
    await fs.writeFile(file, JSON.stringify(state))
    await expect(HarnessSearch.read("search-pareto-tamper")).rejects.toThrow("Pareto archive does not match")
  })

  test("fails closed when persisted island policy or assignment is edited", async () => {
    await setup("search-island-tamper", { candidates: 8 })
    const seed = await add("search-island-tamper", "seed")
    const file = path.join(Global.Path.data, "harness", "search", "search-island-tamper.json")
    const assignment = JSON.parse(await fs.readFile(file, "utf8"))
    assignment.candidates[seed.id].island = 1
    await fs.writeFile(file, JSON.stringify(assignment))
    await expect(HarnessSearch.read("search-island-tamper")).rejects.toThrow("island does not match")

    assignment.candidates[seed.id].island = 0
    assignment.population.migrationInterval = 99
    await fs.writeFile(file, JSON.stringify(assignment))
    await expect(HarnessSearch.read("search-island-tamper")).rejects.toThrow("server-derived budget policy")

    assignment.population.migrationInterval = 2
    assignment.candidates[seed.id].generation = 7
    await fs.writeFile(file, JSON.stringify(assignment))
    await expect(HarnessSearch.read("search-island-tamper")).rejects.toThrow("generation does not match")

    assignment.candidates[seed.id].generation = 0
    assignment.candidates[seed.id].proposal = "edited after registration"
    await fs.writeFile(file, JSON.stringify(assignment))
    await expect(HarnessSearch.read("search-island-tamper")).rejects.toThrow("identity does not match")
  })

  test("migrates legacy single-metric search state without changing its frontier", async () => {
    await setup("search-pareto-legacy")
    const seed = await add("search-pareto-legacy", "seed")
    await evaluate("search-pareto-legacy", seed.id, 0.9)
    const file = path.join(Global.Path.data, "harness", "search", "search-pareto-legacy.json")
    const legacy = JSON.parse(await fs.readFile(file, "utf8"))
    legacy.schemaVersion = 1
    delete legacy.objectives
    delete legacy.archiveIDs
    delete legacy.population
    delete legacy.candidates[seed.id].inspirationIDs
    delete legacy.candidates[seed.id].island
    delete legacy.candidates[seed.id].ordinal
    await fs.writeFile(file, JSON.stringify(legacy))
    const state = await HarnessSearch.read("search-pareto-legacy")
    expect(state.schemaVersion).toBe(3)
    expect(state.proposalPolicy).toBe("advisory-v2")
    expect(state.population).toEqual({ mode: "legacy", count: 1, topology: "ring", migrationInterval: 1 })
    expect(state.objectives).toEqual([])
    expect(state.archiveIDs).toEqual([seed.id])
    expect(state.bestID).toBe(seed.id)
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

  test("opens independent roots early and switches to strategy divergence after prolonged stagnation", async () => {
    await setup("search-adaptive", { candidates: 10, stall: 1 })
    const seed = await add("search-adaptive", "seed", [], "base")
    let state = await evaluate("search-adaptive", seed.id, 0.9)
    expect(HarnessSearch.recommend(state)).toMatchObject({ strategy: "explore", parentIDs: [] })
    const alternate = await add("search-adaptive", "alternate", [], "alternate")
    state = await evaluate("search-adaptive", alternate.id, 0.7)
    expect(HarnessSearch.recommend(state).strategy).toBe("fuse")
    const fused = await add("search-adaptive", "fused", [seed.id, alternate.id], "fusion")
    state = await evaluate("search-adaptive", fused.id, 0.8)
    expect(HarnessSearch.recommend(state)).toMatchObject({ strategy: "diverge", parentIDs: [seed.id] })
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
    await expect(
      HarnessEvaluation.record({
        ...(await HarnessEvaluation.read("search-stop"))!,
        score: 0.6,
        metrics: { score: 0.6 },
      }),
    ).rejects.toThrow("immutable")
    const stopped = await HarnessSearch.finish("search-stop", "user_cancelled")
    expect(await HarnessSearch.read("search-stop")).toEqual(stopped)
  })
})

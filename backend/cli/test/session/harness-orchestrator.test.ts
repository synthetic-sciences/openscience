import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessOrchestrator } from "../../src/session/harness/orchestrator"

const sessions = new Set<string>()

afterEach(async () => {
  await Promise.all(
    [...sessions].flatMap((sessionID) =>
      ["contracts", "orchestration"].map((name) =>
        fs.rm(path.join(Global.Path.data, "harness", name, `${encodeURIComponent(sessionID)}.json`), { force: true }),
      ),
    ),
  )
  sessions.clear()
})

function contract(
  sessionID: string,
  orchestration?: HarnessContract.Orchestration,
  budget: HarnessContract.Info["budget"] = { steps: 70, tokens: 70_000, costUSD: 7, wallTimeMs: 70_000 },
) {
  sessions.add(sessionID)
  return HarnessContract.Info.parse({
    schemaVersion: 1,
    runID: `run-${sessionID}`,
    sessionID,
    objective: "Find a novel robust PDE method and falsify it on held-out cases",
    benchmark: {
      name: "pde",
      version: "2026.08",
      taskID: "task-1",
      split: "held_out",
      evaluator: "official-evaluator",
      evaluatorVersion: "1",
      evaluatorSource: "benchmark",
      metric: "score",
      direction: "maximize",
    },
    profile: "numerical",
    orchestration,
    packs: ["pde", "physics"],
    model: { provider: "test", name: "model" },
    tools: ["read", "bash", "python"],
    skills: [],
    budget,
    seed: 17,
    intervention: "autonomous",
    contamination: { policy: "hidden tests remain external", hiddenTestsAccessible: false },
    createdAt: Date.now(),
  })
}

const traits = (values: Partial<HarnessContract.Traits> = {}): HarnessContract.Traits => ({
  decomposability: 0.5,
  sequentiality: 0.5,
  toolIntensity: 0.5,
  uncertainty: 0.5,
  verificationRisk: 0.5,
  novelty: 0.5,
  crossDomain: 0.2,
  ...values,
})

const config = (
  topology: HarnessContract.Topology,
  values?: Partial<HarnessContract.Traits>,
): HarnessContract.Orchestration => ({
  topology,
  traits: values ? traits(values) : undefined,
  maxWorkers: 2,
  maxRounds: 2,
  minIndependentVerifiers: 2,
})

async function bind(sessionID: string, orchestration = config("tournament")) {
  return HarnessContract.bind(contract(sessionID, orchestration))
}

const done = (
  summary: string,
  usage: NonNullable<HarnessOrchestrator.Result["usage"]> = {
    steps: 1,
    tokens: 100,
    costUSD: 0.01,
    wallTimeMs: 10,
  },
) => ({
  summary,
  artifactRefs: [`artifact://${summary}`],
  evidenceRefs: [`evidence://${summary}`],
  usage,
})

const verdict = (decision: HarnessOrchestrator.Verdict["decision"]): HarnessOrchestrator.Verdict => ({
  decision,
  confidence: decision === "abstain" ? 0.4 : 0.8,
  checks: [
    {
      id: "independent-check",
      status: decision === "support" ? "passed" : decision === "reject" ? "failed" : "inconclusive",
      evidenceRefs: [`evidence://verdict-${decision}`],
    },
  ],
})

const advance = async (sessionID: string, state: HarnessOrchestrator.State): Promise<HarnessOrchestrator.State> => {
  if (["awaiting_checkpoint", "completed"].includes(state.status)) return state
  const work = HarnessOrchestrator.ready(state)[0]
  if (!work) return state
  const result = {
    ...done(work.label),
    evidenceRefs: work.role === "verification" ? [`evidence://${work.label}`] : [],
    verdict: work.role === "verification" ? verdict("support") : undefined,
  }
  const next = await HarnessOrchestrator.complete({
    sessionID,
    workID: work.id,
    workerSessionID: `worker-${sessionID}-${state.revision}`,
    result,
  })
  return advance(sessionID, next)
}

describe("scientific coalition orchestration", () => {
  test("selects coordination only when task traits justify its overhead", () => {
    expect(HarnessOrchestrator.select(contract("policy-small", { ...config("auto"), maxWorkers: 1 })).topology).toBe(
      "solo",
    )
    expect(
      HarnessOrchestrator.select(
        contract("policy-central", config("auto", { toolIntensity: 0.9, decomposability: 0.3 })),
      ).topology,
    ).toBe("centralized")
    expect(
      HarnessOrchestrator.select(contract("policy-evolve", config("auto", { novelty: 0.9, uncertainty: 0.9 })))
        .topology,
    ).toBe("evolution")
    expect(
      HarnessOrchestrator.select(contract("policy-fork", config("auto", { decomposability: 0.9, crossDomain: 0.8 })))
        .topology,
    ).toBe("fork_join")
  })

  test("honors forced topology and rejects an incomplete role contract", () => {
    expect(HarnessOrchestrator.select(contract("forced", config("evolution")))).toMatchObject({
      topology: "evolution",
      source: "contract",
    })
    expect(() =>
      HarnessOrchestrator.select(
        contract("forced-invalid", { ...config("tournament"), roles: ["generation", "verification"] }),
      ),
    ).toThrow("do not permit")
    expect(() =>
      HarnessContract.Orchestration.parse({
        ...config("auto"),
        adaptive: {
          protocolVersion: "marginal-utility-v1",
          minRounds: 1,
          patience: 1,
          minUtilityGain: 0.01,
          maxUncertainty: 0.05,
        },
      }),
    ).toThrow("explicit evolution")
  })

  test("persists a restart-safe DAG and unlocks work only after dependencies", async () => {
    await bind("dag")
    const initial = await HarnessOrchestrator.initialize("dag")
    const roots = HarnessOrchestrator.ready(initial)
    expect(initial.selection.topology).toBe("tournament")
    expect(roots.map((work) => work.role)).toEqual(["generation", "generation"])

    const first = await HarnessOrchestrator.complete({
      sessionID: "dag",
      workID: roots[0]!.id,
      workerSessionID: "worker-a",
      result: done("proposal-a"),
    })
    expect(HarnessOrchestrator.ready(first).map((work) => work.id)).toEqual([roots[1]!.id])

    const ranking = Object.values(first.work).find((work) => work.role === "ranking")!
    await expect(
      HarnessOrchestrator.complete({
        sessionID: "dag",
        workID: ranking.id,
        workerSessionID: "worker-skip",
        result: done("invalid-ranking"),
      }),
    ).rejects.toThrow("before its dependencies")

    const second = await HarnessOrchestrator.complete({
      sessionID: "dag",
      workID: roots[1]!.id,
      workerSessionID: "worker-b",
      result: done("proposal-b"),
    })
    const proximity = HarnessOrchestrator.ready(second)[0]!
    expect(proximity.role).toBe("proximity")
    expect(proximity.context).toEqual([
      expect.objectContaining({ summary: "proposal-a", evidenceRefs: ["evidence://proposal-a"] }),
      expect.objectContaining({ summary: "proposal-b", evidenceRefs: ["evidence://proposal-b"] }),
    ])
    await expect(
      HarnessOrchestrator.complete({
        sessionID: "dag",
        workID: proximity.id,
        workerSessionID: "worker-a",
        result: done("invalid-reuse"),
      }),
    ).rejects.toThrow("distinct worker session")

    const restarted = await HarnessOrchestrator.initialize("dag")
    expect(restarted).toEqual(second)
  })

  test("enforces per-role allocation and immutable idempotent completion", async () => {
    await bind("budget", { ...config("auto"), maxWorkers: 1, minIndependentVerifiers: 1 })
    const initial = await HarnessOrchestrator.initialize("budget")
    const work = HarnessOrchestrator.ready(initial)[0]!
    await expect(
      HarnessOrchestrator.complete({
        sessionID: "budget",
        workID: work.id,
        workerSessionID: "worker-over",
        result: done("overspend", { steps: work.allocation.steps! + 1 }),
      }),
    ).rejects.toThrow("exceeded its steps")

    const input = {
      sessionID: "budget",
      workID: work.id,
      workerSessionID: "worker-ok",
      result: done("bounded"),
    }
    const completed = await HarnessOrchestrator.complete(input)
    expect(completed.status).toBe("completed")
    expect(await HarnessOrchestrator.complete(input)).toEqual(completed)
    await expect(HarnessOrchestrator.complete({ ...input, result: done("mutated") })).rejects.toThrow("immutable")
  })

  test("propagates failures through descendants while preserving independent roots", async () => {
    await bind("failure")
    const initial = await HarnessOrchestrator.initialize("failure")
    const roots = HarnessOrchestrator.ready(initial)
    const failed = await HarnessOrchestrator.fail({
      sessionID: "failure",
      workID: roots[0]!.id,
      workerSessionID: "worker-failed",
      failure: "solver diverged",
    })
    expect(failed.work[roots[0]!.id]!.status).toBe("failed")
    expect(HarnessOrchestrator.ready(failed).map((work) => work.id)).toEqual([roots[1]!.id])
    expect(Object.values(failed.work).filter((work) => work.status === "cancelled").length).toBeGreaterThan(0)

    const completed = await HarnessOrchestrator.complete({
      sessionID: "failure",
      workID: roots[1]!.id,
      workerSessionID: "worker-survivor",
      result: done("surviving-root"),
    })
    expect(completed.status).toBe("completed")
  })

  test("rejects state whose dependency order no longer forms a DAG", async () => {
    await bind("cycle")
    const state = await HarnessOrchestrator.initialize("cycle")
    const dependent = state.order.find((id) => state.work[id]!.dependencies.length > 0)!
    const order = [dependent, ...state.order.filter((id) => id !== dependent)]
    expect(HarnessOrchestrator.State.safeParse({ ...state, order }).success).toBe(false)
  })

  test("aggregates blinded verifier disagreement only after the full panel settles", async () => {
    await bind("consensus")
    const initial = await HarnessOrchestrator.initialize("consensus")
    const sessions = new Map<string, string>()
    const decisions = new Map([
      ["independent-verification-1", "support" as const],
      ["independent-verification-2", "reject" as const],
    ])
    const settle = async (state: HarnessOrchestrator.State): Promise<HarnessOrchestrator.State> => {
      if (state.status === "completed") return state
      const work = HarnessOrchestrator.ready(state)[0]!
      const worker = `worker-${sessions.size + 1}`
      sessions.set(work.id, worker)
      const result = {
        ...done(work.label),
        evidenceRefs: work.role === "verification" ? [`evidence://${work.label}`] : [],
        verdict: work.role === "verification" ? verdict(decisions.get(work.label)!) : undefined,
      }
      const next = await HarnessOrchestrator.complete({
        sessionID: "consensus",
        workID: work.id,
        workerSessionID: worker,
        result,
      })
      if (work.role === "verification" && next.status === "active") expect(next.consensus).toBeUndefined()
      return settle(next)
    }
    const completed = await settle(initial)
    expect(completed.consensus).toMatchObject({
      status: "disputed",
      verifierCount: 2,
      support: 1,
      reject: 1,
      abstain: 0,
      provisional: true,
    })
    expect(completed.consensus!.evidenceRefs).toContain("evidence://verdict-support")
    expect(completed.consensus!.evidenceRefs).toContain("evidence://verdict-reject")
  })

  test("does not label one review as consensus and requires observable verifier evidence", async () => {
    await bind("single-consensus", { ...config("tournament"), minIndependentVerifiers: 1 })
    const advance = async (state: HarnessOrchestrator.State, count = 0): Promise<HarnessOrchestrator.State> => {
      if (state.status === "completed") return state
      const work = HarnessOrchestrator.ready(state)[0]!
      if (work.role === "verification") {
        await expect(
          HarnessOrchestrator.complete({
            sessionID: "single-consensus",
            workID: work.id,
            workerSessionID: `worker-missing-${count}`,
            result: { ...done("missing-evidence"), evidenceRefs: [], verdict: verdict("support") },
          }),
        ).rejects.toThrow("observable evidence")
      }
      const next = await HarnessOrchestrator.complete({
        sessionID: "single-consensus",
        workID: work.id,
        workerSessionID: `worker-${count}`,
        result: {
          ...done(work.label),
          evidenceRefs: work.role === "verification" ? ["evidence://single"] : [],
          verdict: work.role === "verification" ? verdict("support") : undefined,
        },
      })
      return advance(next, count + 1)
    }
    const completed = await advance(await HarnessOrchestrator.initialize("single-consensus"))
    expect(completed.consensus).toMatchObject({ status: "insufficient", verifierCount: 1, support: 1 })
  })

  test("gates evolution rounds on external marginal utility and preserves final verification after early stop", async () => {
    const sessionID = "adaptive-stall"
    const orchestration: HarnessContract.Orchestration = {
      ...config("evolution"),
      maxRounds: 3,
      adaptive: {
        protocolVersion: "marginal-utility-v1",
        minRounds: 2,
        patience: 1,
        minUtilityGain: 0.05,
        maxUncertainty: 0.05,
      },
    }
    const bound = await HarnessContract.bind(contract(sessionID, orchestration))
    const first = await advance(sessionID, await HarnessOrchestrator.initialize(sessionID))
    expect(first).toMatchObject({ protocolVersion: "coalition-v2", status: "awaiting_checkpoint" })
    expect(HarnessOrchestrator.ready(first)).toEqual([])
    await expect(
      HarnessOrchestrator.checkpoint(
        {
          sessionID,
          round: 2,
          utility: 0.5,
          uncertainty: 0.01,
          evidenceRefs: ["evidence://premature"],
          evaluatedAt: Date.now(),
        },
        bound,
      ),
    ).rejects.toThrow("round 1")
    await expect(
      HarnessOrchestrator.checkpoint(
        {
          sessionID,
          round: 1,
          utility: 0.5,
          uncertainty: 0.01,
          evidenceRefs: ["evidence://stale"],
          evaluatedAt: bound.createdAt,
        },
        bound,
      ),
    ).rejects.toThrow("predates")

    const one = {
      sessionID,
      round: 1,
      utility: 0.5,
      uncertainty: 0.01,
      evidenceRefs: ["evidence://round-1"],
      evaluatedAt: Date.now(),
    }
    const resumed = await HarnessOrchestrator.checkpoint(one, bound)
    expect(resumed).toMatchObject({ status: "active", adaptive: { stalled: 0, phase: "searching" } })
    expect(await HarnessOrchestrator.checkpoint(one, bound)).toEqual(resumed)
    await expect(HarnessOrchestrator.checkpoint({ ...one, utility: 0.6 }, bound)).rejects.toThrow("immutable")

    const second = await advance(sessionID, resumed)
    expect(second).toMatchObject({ status: "awaiting_checkpoint", adaptive: { checkpoints: [{ round: 1 }] } })
    const stopped = await HarnessOrchestrator.checkpoint(
      {
        sessionID,
        round: 2,
        utility: 0.51,
        uncertainty: 0.01,
        evidenceRefs: ["evidence://round-2"],
        evaluatedAt: Date.now(),
      },
      bound,
    )
    expect(stopped).toMatchObject({
      status: "active",
      adaptive: { phase: "finalizing", stalled: 1, stopReason: "marginal_utility_exhausted" },
    })
    expect(Object.values(stopped.work).filter((item) => item.status === "cancelled").length).toBeGreaterThan(0)
    expect(HarnessOrchestrator.ready(stopped).map((item) => item.role)).toEqual(["investigation"])

    const completed = await advance(sessionID, stopped)
    expect(completed).toMatchObject({ status: "completed", consensus: { status: "supported", verifierCount: 2 } })
  })

  test("does not let uncertain utility stop search and detects checkpoint storage tampering", async () => {
    const sessionID = "adaptive-uncertain"
    const orchestration: HarnessContract.Orchestration = {
      ...config("evolution"),
      maxRounds: 2,
      adaptive: {
        protocolVersion: "marginal-utility-v1",
        minRounds: 1,
        patience: 1,
        minUtilityGain: 0.05,
        maxUncertainty: 0.05,
        targetUtility: 0.8,
      },
    }
    const bound = await HarnessContract.bind(contract(sessionID, orchestration))
    const first = await advance(sessionID, await HarnessOrchestrator.initialize(sessionID))
    const resumed = await HarnessOrchestrator.checkpoint(
      {
        sessionID,
        round: 1,
        utility: 0.99,
        uncertainty: 0.5,
        evidenceRefs: ["evidence://uncertain"],
        evaluatedAt: Date.now(),
      },
      bound,
    )
    expect(resumed).toMatchObject({
      status: "active",
      adaptive: { phase: "searching", stalled: 0, checkpoints: [{ qualified: false }] },
    })
    const second = await advance(sessionID, resumed)
    const finalizing = await HarnessOrchestrator.checkpoint(
      {
        sessionID,
        round: 2,
        utility: 0.99,
        uncertainty: 0.5,
        evidenceRefs: ["evidence://still-uncertain"],
        evaluatedAt: Date.now(),
      },
      bound,
    )
    expect(finalizing).toMatchObject({ adaptive: { phase: "finalizing", stopReason: "max_rounds" } })

    const file = path.join(Global.Path.data, "harness", "orchestration", `${encodeURIComponent(sessionID)}.json`)
    const data = await Bun.file(file).json()
    data.adaptive.checkpoints[0].utility = 0.1
    await Bun.write(file, JSON.stringify(data))
    await expect(HarnessOrchestrator.read(sessionID)).rejects.toThrow()
  })

  test("honors the minimum search depth before a qualified target can stop evolution", async () => {
    const sessionID = "adaptive-target"
    const orchestration: HarnessContract.Orchestration = {
      ...config("evolution"),
      maxRounds: 3,
      adaptive: {
        protocolVersion: "marginal-utility-v1",
        minRounds: 2,
        patience: 1,
        minUtilityGain: 0.05,
        maxUncertainty: 0.05,
        targetUtility: 0.8,
      },
    }
    const bound = await HarnessContract.bind(contract(sessionID, orchestration))
    const first = await advance(sessionID, await HarnessOrchestrator.initialize(sessionID))
    const resumed = await HarnessOrchestrator.checkpoint(
      {
        sessionID,
        round: 1,
        utility: 0.9,
        uncertainty: 0.01,
        evidenceRefs: ["evidence://target-before-minimum"],
        evaluatedAt: Date.now(),
      },
      bound,
    )
    expect(resumed.adaptive).toMatchObject({ phase: "searching" })
    expect(resumed.adaptive?.stopReason).toBeUndefined()

    const second = await advance(sessionID, resumed)
    const stopped = await HarnessOrchestrator.checkpoint(
      {
        sessionID,
        round: 2,
        utility: 0.91,
        uncertainty: 0.01,
        evidenceRefs: ["evidence://qualified-target"],
        evaluatedAt: Date.now(),
      },
      bound,
    )
    expect(stopped.adaptive).toMatchObject({ phase: "finalizing", stopReason: "target_reached" })
    expect(HarnessOrchestrator.ready(stopped).map((item) => item.role)).toEqual(["investigation"])
  })
})

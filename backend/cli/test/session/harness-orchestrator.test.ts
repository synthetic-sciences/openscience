import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessOrchestrator } from "../../src/session/harness/orchestrator"

const sessions = new Set<string>()
const digest = (input: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(input)).digest("hex")

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

const routed = (
  decision: HarnessOrchestrator.Verdict["decision"],
  severity: NonNullable<HarnessOrchestrator.Verdict["severity"]>,
  confidence = decision === "abstain" ? 0.4 : 0.8,
): HarnessOrchestrator.Verdict => ({ ...verdict(decision), severity, confidence })

const turns: string[] = []

const attest = async (
  sessionID: string,
  work: HarnessOrchestrator.Work | HarnessOrchestrator.Ready,
  worker: string,
  outcome: HarnessOrchestrator.WorkerReceipt["outcome"] = "completed",
  usage: NonNullable<HarnessOrchestrator.Result["usage"]> = done("receipt").usage,
) => {
  const state = await HarnessOrchestrator.read(sessionID)
  const completedAt = Date.now()
  return HarnessOrchestrator.attest({
    sessionID,
    workID: work.id,
    workerSessionID: worker,
    turnID: `task-turn-${turns.push(work.id)}`,
    agent: work.agent,
    prompt: `Execute this exact coalition unit:\n${work.prompt}`,
    outcome,
    usage,
    toolCalls: 1,
    failedToolCalls: outcome === "failed" ? 1 : 0,
    startedAt: Math.max(state.createdAt, completedAt - 1),
    completedAt,
  })
}

const finish = async (
  sessionID: string,
  work: HarnessOrchestrator.Work | HarnessOrchestrator.Ready,
  worker: string,
  result: Parameters<typeof HarnessOrchestrator.complete>[0]["result"],
) => {
  await attest(sessionID, work, worker, "completed", result.usage ?? {})
  return HarnessOrchestrator.complete({ sessionID, workID: work.id, workerSessionID: worker, result })
}

const fail = async (
  sessionID: string,
  work: HarnessOrchestrator.Work | HarnessOrchestrator.Ready,
  worker: string,
  failure: string,
) => {
  await attest(sessionID, work, worker, "failed")
  return HarnessOrchestrator.fail({ sessionID, workID: work.id, workerSessionID: worker, failure })
}

const rekey = (state: HarnessOrchestrator.State, policy: HarnessOrchestrator.State["sessionPolicy"]) => {
  const ids = new Map<string, string>()
  const work: Record<string, HarnessOrchestrator.Work> = {}
  const order = state.order.map((id) => {
    const item = state.work[id]!
    const dependencies = item.dependencies.map((dependency) => ids.get(dependency)!)
    const next = digest({
      runID: state.runID,
      role: item.role,
      label: item.label,
      dependencies,
      round: item.round,
      ...(policy === "legacy-v1" ? {} : { sessionPolicy: policy }),
      ...(item.lane ? { lane: item.lane } : {}),
    })
    ids.set(id, next)
    work[next] = { ...item, id: next, dependencies }
    return next
  })
  return { ...state, work, order }
}

const advance = async (sessionID: string, state: HarnessOrchestrator.State): Promise<HarnessOrchestrator.State> => {
  if (["awaiting_checkpoint", "completed"].includes(state.status)) return state
  const work = HarnessOrchestrator.ready(state)[0]
  if (!work) return state
  const result = {
    ...done(work.label),
    evidenceRefs: work.role === "verification" ? [`evidence://${work.label}`] : [],
    verdict: work.role === "verification" ? verdict("support") : undefined,
  }
  const next = await finish(sessionID, work, work.resumeSessionID ?? `worker-${sessionID}-${state.revision}`, result)
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
    expect(() => HarnessContract.Orchestration.parse(config("verifier_loop"))).toThrow("repair contract")
    expect(() =>
      HarnessContract.Orchestration.parse({
        ...config("centralized"),
        repair: { protocolVersion: "verifier-routed-v1", minConfidence: 0.7 },
      }),
    ).toThrow("explicit verifier_loop")
  })

  test("accepts only after a complete high-confidence verifier panel", async () => {
    const sessionID = "repair-accept"
    const orchestration: HarnessContract.Orchestration = {
      ...config("verifier_loop"),
      maxRounds: 3,
      repair: { protocolVersion: "verifier-routed-v1", minConfidence: 0.7 },
    }
    await bind(sessionID, orchestration)
    const initial = await HarnessOrchestrator.initialize(sessionID)
    expect(initial).toMatchObject({
      protocolVersion: "coalition-v3",
      repair: { phase: "producing", routes: [] },
    })
    expect(initial.work[initial.order[0]!]!.allocation.steps).toBe(7)
    const candidate = HarnessOrchestrator.ready(initial)[0]!
    const proposed = await finish(sessionID, candidate, "repair-author", done("candidate"))
    const verifiers = HarnessOrchestrator.ready(proposed)
    expect(verifiers).toHaveLength(2)
    const first = await finish(sessionID, verifiers[0]!, "repair-verifier-a", {
      ...done("verified-a"),
      verdict: routed("support", "none"),
    })
    expect(first.status).toBe("active")
    expect(first.consensus).toBeUndefined()
    const settled = await finish(sessionID, HarnessOrchestrator.ready(first)[0]!, "repair-verifier-b", {
      ...done("verified-b"),
      verdict: routed("support", "none"),
    })
    expect(settled).toMatchObject({
      status: "completed",
      repair: { phase: "completed", stopReason: "accepted" },
      consensus: { status: "supported", verifierCount: 2, support: 2, reject: 0, abstain: 0 },
    })
    expect(settled.repair!.routes.map((item) => item.decision)).toEqual(["accept"])
    expect(HarnessOrchestrator.State.safeParse(settled).success).toBe(true)
    const file = path.join(Global.Path.data, "harness", "orchestration", `${encodeURIComponent(sessionID)}.json`)
    const stored = JSON.parse(await fs.readFile(file, "utf8")) as HarnessOrchestrator.State
    stored.repair!.minConfidence = 0.75
    await fs.writeFile(file, JSON.stringify(stored))
    await expect(HarnessOrchestrator.read(sessionID)).rejects.toThrow("bound contract")
  })

  test("requires repair-panel severity after Task execution", async () => {
    const sessionID = "repair-severity"
    await bind(sessionID, {
      ...config("verifier_loop"),
      maxRounds: 1,
      repair: { protocolVersion: "verifier-routed-v1", minConfidence: 0.7 },
    })
    const initial = await HarnessOrchestrator.initialize(sessionID)
    const proposed = await finish(
      sessionID,
      HarnessOrchestrator.ready(initial)[0]!,
      "severity-author",
      done("candidate"),
    )
    const verifier = HarnessOrchestrator.ready(proposed)[0]!
    await attest(sessionID, verifier, "severity-verifier")
    await expect(
      HarnessOrchestrator.complete({
        sessionID,
        workID: verifier.id,
        workerSessionID: "severity-verifier",
        result: { ...done("missing-severity"), verdict: verdict("support") },
      }),
    ).rejects.toThrow("severity classification")
  })

  test("routes localized defects to revision and excludes stale panels from final consensus", async () => {
    const sessionID = "repair-revise"
    await bind(sessionID, {
      ...config("verifier_loop"),
      maxRounds: 3,
      repair: { protocolVersion: "verifier-routed-v1", minConfidence: 0.7 },
    })
    const initial = await HarnessOrchestrator.initialize(sessionID)
    const candidate = HarnessOrchestrator.ready(initial)[0]!
    const proposed = await finish(sessionID, candidate, "revise-author", done("candidate-with-local-defect"))
    const panel = HarnessOrchestrator.ready(proposed)
    const rejected = await finish(sessionID, panel[0]!, "revise-verifier-a", {
      ...done("localized-counterexample"),
      verdict: routed("reject", "minor"),
    })
    const routedState = await finish(sessionID, HarnessOrchestrator.ready(rejected)[0]!, "revise-verifier-b", {
      ...done("otherwise-sound"),
      verdict: routed("support", "none"),
    })
    const revision = HarnessOrchestrator.ready(routedState)[0]!
    expect(revision).toMatchObject({ role: "revision", label: "targeted-revision-1" })
    expect(routedState.repair!.routes[0]!.actionID).toBe(revision.id)
    expect(revision.context.map((item) => item.role)).toEqual(["generation", "verification", "verification"])
    const repaired = await finish(sessionID, revision, "reviser", done("complete-repaired-candidate"))
    const final = HarnessOrchestrator.ready(repaired)
    const checked = await finish(sessionID, final[0]!, "fresh-final-a", {
      ...done("repair-check-a"),
      verdict: routed("support", "none"),
    })
    const settled = await finish(sessionID, HarnessOrchestrator.ready(checked)[0]!, "fresh-final-b", {
      ...done("repair-check-b"),
      verdict: routed("support", "none"),
    })
    expect(settled.repair!.routes.map((item) => item.decision)).toEqual(["revise", "accept"])
    expect(settled.repair!.routes[0]!.candidateID).toBe(candidate.id)
    expect(settled.repair!.routes[1]!.candidateID).toBe(revision.id)
    expect(settled.consensus).toMatchObject({ status: "supported", verifierCount: 2, support: 2, reject: 0 })
  })

  test("routes critical defects to a clean restart without rejected candidate context", async () => {
    const sessionID = "repair-restart"
    await bind(sessionID, {
      ...config("verifier_loop"),
      maxRounds: 2,
      repair: { protocolVersion: "verifier-routed-v1", minConfidence: 0.7 },
    })
    const initial = await HarnessOrchestrator.initialize(sessionID)
    const candidate = HarnessOrchestrator.ready(initial)[0]!
    const proposed = await finish(sessionID, candidate, "restart-author", done("invalid-premise-candidate"))
    const panel = HarnessOrchestrator.ready(proposed)
    const rejected = await finish(sessionID, panel[0]!, "restart-verifier-a", {
      ...done("fatal-counterexample"),
      verdict: routed("reject", "critical"),
    })
    const routedState = await finish(sessionID, HarnessOrchestrator.ready(rejected)[0]!, "restart-verifier-b", {
      ...done("secondary-review"),
      verdict: routed("reject", "minor"),
    })
    const restart = HarnessOrchestrator.ready(routedState)[0]!
    expect(restart).toMatchObject({ role: "generation", label: "clean-restart-1" })
    expect(routedState.repair!.routes[0]!.actionID).toBe(restart.id)
    expect(restart.dependencies).toEqual(routedState.repair!.routes[0]!.verifierIDs)
    expect(restart.context.map((item) => item.role)).toEqual(["verification", "verification"])
    expect(restart.context.some((item) => item.summary === "invalid-premise-candidate")).toBe(false)
    expect(restart.prompt).toContain("Start from a blank solution")
  })

  test("routes abstention to evidence acquisition and stops at the immutable attempt ceiling", async () => {
    const sessionID = "repair-investigate"
    await bind(sessionID, {
      ...config("verifier_loop"),
      maxRounds: 2,
      repair: { protocolVersion: "verifier-routed-v1", minConfidence: 0.7 },
    })
    const initial = await HarnessOrchestrator.initialize(sessionID)
    const candidate = HarnessOrchestrator.ready(initial)[0]!
    const proposed = await finish(sessionID, candidate, "investigate-author", done("evidence-limited-candidate"))
    const panel = HarnessOrchestrator.ready(proposed)
    const uncertain = await finish(sessionID, panel[0]!, "investigate-verifier-a", {
      ...done("missing-observation"),
      verdict: routed("abstain", "unknown"),
    })
    const routedState = await finish(sessionID, HarnessOrchestrator.ready(uncertain)[0]!, "investigate-verifier-b", {
      ...done("provisional-support"),
      verdict: routed("support", "none"),
    })
    const investigation = HarnessOrchestrator.ready(routedState)[0]!
    expect(investigation).toMatchObject({ role: "investigation", label: "evidence-investigation-1" })
    expect(routedState.repair!.routes[0]!.actionID).toBe(investigation.id)
    const evidenced = await finish(sessionID, investigation, "evidence-worker", done("new-observable-evidence"))
    const final = HarnessOrchestrator.ready(evidenced)
    expect(final[0]!.context.map((item) => item.role)).toEqual(["generation", "investigation"])
    expect(final[0]!.context.some((item) => item.role === "verification")).toBe(false)
    const first = await finish(sessionID, final[0]!, "attempt-two-a", {
      ...done("remaining-failure-a"),
      verdict: routed("reject", "minor"),
    })
    const settled = await finish(sessionID, HarnessOrchestrator.ready(first)[0]!, "attempt-two-b", {
      ...done("remaining-failure-b"),
      verdict: routed("reject", "minor"),
    })
    expect(settled).toMatchObject({
      status: "completed",
      repair: { phase: "completed", stopReason: "attempt_limit" },
      consensus: { status: "rejected", verifierCount: 2, reject: 2 },
    })
    expect(settled.repair!.routes.map((item) => item.decision)).toEqual(["investigate", "revise"])
    expect(settled.repair!.routes[1]!.actionID).toBeUndefined()

    const file = path.join(Global.Path.data, "harness", "orchestration", `${encodeURIComponent(sessionID)}.json`)
    const stored = JSON.parse(await fs.readFile(file, "utf8")) as HarnessOrchestrator.State
    stored.repair!.routes[0]!.decision = "accept"
    await fs.writeFile(file, JSON.stringify(stored))
    await expect(HarnessOrchestrator.read(sessionID)).rejects.toThrow("Repair route derivation drifted")
  })

  test("reserves the whole conditional repair budget before starting", async () => {
    const sessionID = "repair-budget"
    await HarnessContract.bind(
      contract(
        sessionID,
        {
          ...config("verifier_loop"),
          maxRounds: 3,
          repair: { protocolVersion: "verifier-routed-v1", minConfidence: 0.7 },
        },
        { steps: 8 },
      ),
    )
    await expect(HarnessOrchestrator.initialize(sessionID)).rejects.toThrow("every orchestration unit")
  })

  test("fails closed when a routed producer cannot return an artifact", async () => {
    const sessionID = "repair-work-failed"
    await bind(sessionID, {
      ...config("verifier_loop"),
      maxRounds: 2,
      repair: { protocolVersion: "verifier-routed-v1", minConfidence: 0.7 },
    })
    const initial = await HarnessOrchestrator.initialize(sessionID)
    const settled = await fail(
      sessionID,
      HarnessOrchestrator.ready(initial)[0]!,
      "failed-repair-author",
      "no valid artifact produced",
    )
    expect(settled).toMatchObject({
      status: "completed",
      repair: { phase: "completed", stopReason: "work_failed", routes: [] },
      consensus: { status: "insufficient", verifierCount: 0 },
    })
    expect(HarnessOrchestrator.ready(settled)).toEqual([])
  })

  test("persists a restart-safe DAG and unlocks work only after dependencies", async () => {
    await bind("dag")
    const initial = await HarnessOrchestrator.initialize("dag")
    const roots = HarnessOrchestrator.ready(initial)
    expect(initial.selection.topology).toBe("tournament")
    expect(HarnessOrchestrator.State.safeParse({ ...initial, workerPolicy: "claimed-v1" }).success).toBe(false)
    expect(roots.map((work) => work.role)).toEqual(["generation", "generation"])

    const first = await finish("dag", roots[0]!, "worker-a", done("proposal-a"))
    expect(HarnessOrchestrator.ready(first).map((work) => work.id)).toEqual([roots[1]!.id])

    const ranking = Object.values(first.work).find((work) => work.role === "ranking")!
    await expect(attest("dag", ranking, "worker-skip")).rejects.toThrow("not ready")

    const second = await finish("dag", roots[1]!, "worker-b", done("proposal-b"))
    const proximity = HarnessOrchestrator.ready(second)[0]!
    expect(proximity.role).toBe("proximity")
    expect(proximity.context).toEqual([
      expect.objectContaining({ summary: "proposal-a", evidenceRefs: ["evidence://proposal-a"] }),
      expect.objectContaining({ summary: "proposal-b", evidenceRefs: ["evidence://proposal-b"] }),
    ])
    await expect(finish("dag", proximity, "worker-a", done("invalid-reuse"))).rejects.toThrow("distinct worker session")

    const restarted = await HarnessOrchestrator.initialize("dag")
    expect(restarted).toEqual(second)
  })

  test("requires immutable Task-attested execution before accepting coalition output", async () => {
    const sessionID = "task-receipt"
    await bind(sessionID)
    const initial = await HarnessOrchestrator.initialize(sessionID)
    const work = HarnessOrchestrator.ready(initial)[0]!
    await expect(
      HarnessOrchestrator.complete({
        sessionID,
        workID: work.id,
        workerSessionID: "unattested-worker",
        result: done("fabricated-output"),
      }),
    ).rejects.toThrow("executed by the Task tool")

    const now = Date.now()
    const input = {
      sessionID,
      workID: work.id,
      workerSessionID: "actual-task-session",
      turnID: "actual-task-turn",
      agent: work.agent,
      prompt: `Bound Task prompt:\n${work.prompt}`,
      outcome: "completed" as const,
      usage: { steps: 2, tokens: 321, costUSD: 0.02, wallTimeMs: 20 },
      toolCalls: 3,
      failedToolCalls: 0,
      startedAt: Math.max(initial.createdAt, now - 20),
      completedAt: now,
    }
    await expect(
      HarnessOrchestrator.attest({
        ...input,
        agent: HarnessOrchestrator.WorkerAgent.parse(work.agent === "reviewer" ? "task" : "reviewer"),
      }),
    ).rejects.toThrow("wrong coalition agent")
    await expect(HarnessOrchestrator.attest({ ...input, prompt: "Omit the bound work prompt" })).rejects.toThrow(
      "omitted the canonical coalition prompt",
    )

    const executed = await HarnessOrchestrator.attest(input)
    expect(executed.work[work.id]).toMatchObject({
      status: "executed",
      workerSessionID: input.workerSessionID,
      workerReceipt: {
        workID: work.id,
        turnID: input.turnID,
        outcome: "completed",
        usage: input.usage,
        provisional: true,
      },
    })
    expect(await HarnessOrchestrator.attest(input)).toEqual(executed)
    expect(
      HarnessOrchestrator.State.safeParse({
        ...executed,
        work: {
          ...executed.work,
          [work.id]: {
            ...executed.work[work.id]!,
            workerReceipt: { ...executed.work[work.id]!.workerReceipt!, toolCalls: 99 },
          },
        },
      }).success,
    ).toBe(false)

    const other = HarnessOrchestrator.ready(executed)[0]!
    await expect(
      HarnessOrchestrator.attest({ ...input, workID: other.id, agent: other.agent, prompt: other.prompt }),
    ).rejects.toThrow("already attests")
    await expect(
      HarnessOrchestrator.complete({
        sessionID,
        workID: work.id,
        workerSessionID: input.workerSessionID,
        result: done("measured-output", { ...input.usage, tokens: input.usage.tokens + 1 }),
      }),
    ).rejects.toThrow("does not match")

    const completed = await HarnessOrchestrator.complete({
      sessionID,
      workID: work.id,
      workerSessionID: input.workerSessionID,
      result: {
        summary: "measured-output",
        artifactRefs: ["artifact://measured-output"],
        evidenceRefs: ["evidence://measured-output"],
      },
    })
    expect(completed.work[work.id]!.result!.usage).toEqual(input.usage)
  })

  test("resumes only the exact same producer lane while keeping verification fresh", async () => {
    const sessionID = "producer-lanes"
    await bind(sessionID, { ...config("evolution"), maxRounds: 1 })
    const initial = await HarnessOrchestrator.initialize(sessionID)
    const roots = HarnessOrchestrator.ready(initial)
    expect(initial).toMatchObject({
      schemaVersion: 3,
      sessionPolicy: "producer-lanes-v1",
      workerPolicy: "task-attested-v1",
    })
    expect(roots.map((work) => [work.label, work.lane, work.resumeSessionID])).toEqual([
      ["seed-a", "producer-a", undefined],
      ["seed-b", "producer-b", undefined],
    ])
    expect(roots[0]!.prompt).toContain("propose, test, repair, and critique")
    expect(roots[0]!.prompt).toContain("cannot certify a benchmark result")
    expect(
      HarnessOrchestrator.State.safeParse({
        ...initial,
        work: { ...initial.work, [roots[0]!.id]: { ...initial.work[roots[0]!.id]!, lane: "producer-b" } },
      }).success,
    ).toBe(false)

    const first = await finish(sessionID, roots[0]!, "lane-a-session", done("seed-a"))
    const second = await finish(sessionID, roots[1]!, "lane-b-session", done("seed-b"))
    expect(first.work[roots[0]!.id]!.workerSessionID).toBe("lane-a-session")

    const evolve = async (state: HarnessOrchestrator.State): Promise<HarnessOrchestrator.State> => {
      if (HarnessOrchestrator.ready(state).some((work) => work.role === "evolution")) return state
      const work = HarnessOrchestrator.ready(state)[0]!
      return evolve(await finish(sessionID, work, `fresh-${state.revision}`, done(work.label)))
    }
    const staged = await evolve(second)
    const ready = HarnessOrchestrator.ready(staged)
    expect(ready.map((work) => [work.lane, work.resumeSessionID])).toEqual([
      ["producer-a", "lane-a-session"],
      ["producer-b", "lane-b-session"],
    ])

    await expect(finish(sessionID, ready[0]!, "substituted-session", done("substituted"))).rejects.toThrow(
      "must resume",
    )
    await expect(finish(sessionID, ready[1]!, "lane-a-session", done("crossed"))).rejects.toThrow("must resume")

    const restarted = await HarnessOrchestrator.initialize(sessionID)
    expect(HarnessOrchestrator.ready(restarted).map((work) => work.resumeSessionID)).toEqual([
      "lane-a-session",
      "lane-b-session",
    ])
    const a = await finish(sessionID, ready[0]!, "lane-a-session", done("evolved-a"))
    const b = await finish(sessionID, ready[1]!, "lane-b-session", done("evolved-b"))
    const tampered = {
      ...b,
      work: {
        ...b.work,
        [ready[1]!.id]: { ...b.work[ready[1]!.id]!, workerSessionID: "lane-a-session" },
      },
    }
    expect(HarnessOrchestrator.State.safeParse(tampered).success).toBe(false)
    expect(a.work[ready[0]!.id]!.workerSessionID).toBe("lane-a-session")

    const probe = HarnessOrchestrator.ready(b)[0]!
    expect(probe).toMatchObject({ role: "investigation" })
    expect(probe.lane).toBeUndefined()
    expect(probe.resumeSessionID).toBeUndefined()
    const investigated = await finish(sessionID, probe, "fresh-investigator", done("investigation"))
    const verifier = HarnessOrchestrator.ready(investigated)[0]!
    expect(verifier).toMatchObject({ role: "verification" })
    expect(verifier.resumeSessionID).toBeUndefined()
    await expect(
      finish(sessionID, verifier, "lane-a-session", {
        ...done("tainted-verification"),
        verdict: verdict("support"),
      }),
    ).rejects.toThrow("distinct worker session")
  })

  test("migrates version-one orchestration into fresh-session compatibility mode", async () => {
    const sessionID = "legacy-orchestration"
    await bind(sessionID)
    const initial = await HarnessOrchestrator.initialize(sessionID)
    const file = path.join(Global.Path.data, "harness", "orchestration", `${encodeURIComponent(sessionID)}.json`)
    const legacy = { ...rekey(initial, "legacy-v1") } as Record<string, unknown>
    legacy.schemaVersion = 1
    delete legacy.sessionPolicy
    await Bun.write(file, JSON.stringify(legacy))

    const migrated = await HarnessOrchestrator.read(sessionID)
    expect(migrated).toMatchObject({
      schemaVersion: 3,
      sessionPolicy: "legacy-v1",
      workerPolicy: "claimed-v1",
    })
    expect(Object.values(migrated.work).every((work) => work.lane === undefined)).toBe(true)
    const work = HarnessOrchestrator.ready(migrated)[0]!
    const completed = await HarnessOrchestrator.complete({
      sessionID,
      workID: work.id,
      workerSessionID: "legacy-fresh-session",
      result: done("legacy-work"),
    })
    expect(completed.sessionPolicy).toBe("legacy-v1")
  })

  test("migrates version-two orchestration into claimed-worker compatibility mode", async () => {
    const sessionID = "version-two-orchestration"
    await bind(sessionID)
    const initial = await HarnessOrchestrator.initialize(sessionID)
    const file = path.join(Global.Path.data, "harness", "orchestration", `${encodeURIComponent(sessionID)}.json`)
    const previous = { ...rekey(initial, initial.sessionPolicy) } as Record<string, unknown>
    previous.schemaVersion = 2
    delete previous.workerPolicy
    await Bun.write(file, JSON.stringify(previous))

    const migrated = await HarnessOrchestrator.read(sessionID)
    expect(migrated).toMatchObject({
      schemaVersion: 3,
      sessionPolicy: "fresh-v1",
      workerPolicy: "claimed-v1",
    })
    const work = HarnessOrchestrator.ready(migrated)[0]!
    const completed = await HarnessOrchestrator.complete({
      sessionID,
      workID: work.id,
      workerSessionID: "version-two-worker",
      result: done("version-two-output"),
    })
    expect(completed.work[work.id]!.status).toBe("completed")
  })

  test("enforces per-role allocation and immutable idempotent completion", async () => {
    await bind("budget-over", { ...config("auto"), maxWorkers: 1, minIndependentVerifiers: 1 })
    const over = await HarnessOrchestrator.initialize("budget-over")
    const oversized = HarnessOrchestrator.ready(over)[0]!
    await expect(
      finish("budget-over", oversized, "worker-over", done("overspend", { steps: oversized.allocation.steps! + 1 })),
    ).rejects.toThrow("exceeded its steps")

    await bind("budget", { ...config("auto"), maxWorkers: 1, minIndependentVerifiers: 1 })
    const initial = await HarnessOrchestrator.initialize("budget")
    const work = HarnessOrchestrator.ready(initial)[0]!

    const input = {
      sessionID: "budget",
      workID: work.id,
      workerSessionID: "worker-ok",
      result: done("bounded"),
    }
    await attest("budget", work, input.workerSessionID, "completed", input.result.usage)
    const completed = await HarnessOrchestrator.complete(input)
    expect(completed.status).toBe("completed")
    expect(await HarnessOrchestrator.complete(input)).toEqual(completed)
    await expect(HarnessOrchestrator.complete({ ...input, result: done("mutated") })).rejects.toThrow("immutable")
  })

  test("propagates failures through descendants while preserving independent roots", async () => {
    await bind("failure")
    const initial = await HarnessOrchestrator.initialize("failure")
    const roots = HarnessOrchestrator.ready(initial)
    const failed = await fail("failure", roots[0]!, "worker-failed", "solver diverged")
    expect(failed.work[roots[0]!.id]!.status).toBe("failed")
    expect(HarnessOrchestrator.ready(failed).map((work) => work.id)).toEqual([roots[1]!.id])
    expect(Object.values(failed.work).filter((work) => work.status === "cancelled").length).toBeGreaterThan(0)

    const completed = await finish("failure", roots[1]!, "worker-survivor", done("surviving-root"))
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
      const next = await finish("consensus", work, worker, result)
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
      const worker = `worker-${count}`
      const result = {
        ...done(work.label),
        evidenceRefs: work.role === "verification" ? ["evidence://single"] : [],
        verdict: work.role === "verification" ? verdict("support") : undefined,
      }
      await attest("single-consensus", work, worker, "completed", result.usage)
      if (work.role === "verification") {
        await expect(
          HarnessOrchestrator.complete({
            sessionID: "single-consensus",
            workID: work.id,
            workerSessionID: worker,
            result: { ...done("missing-evidence"), evidenceRefs: [], verdict: verdict("support") },
          }),
        ).rejects.toThrow("observable evidence")
      }
      const next = await HarnessOrchestrator.complete({
        sessionID: "single-consensus",
        workID: work.id,
        workerSessionID: worker,
        result,
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

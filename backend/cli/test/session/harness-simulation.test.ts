import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { HarnessRoutes } from "../../src/server/routes/harness"
import { Global } from "../../src/global"
import { HarnessAdapter } from "../../src/session/harness/adapter"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessDomain } from "../../src/session/harness/domain"
import { HarnessSearch } from "../../src/session/harness/search"
import { HarnessSimulation } from "../../src/session/harness/simulation"

const sessions = new Set<string>()
const token = "simulation-evaluator-capability-token-000000000000000"
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")

afterEach(async () => {
  await Promise.all(
    [...sessions].flatMap((sessionID) =>
      ["bindings", "contracts", "evaluations", "search", "simulations"].map((name) =>
        fs.rm(path.join(Global.Path.data, "harness", name, `${encodeURIComponent(sessionID)}.json`), { force: true }),
      ),
    ),
  )
  await fs.rm(path.join(Global.Path.data, "harness", "retrospectives"), { recursive: true, force: true })
  sessions.clear()
})

function protocol() {
  return HarnessContract.Simulation.parse({
    kind: "pde",
    engine: {
      name: "reference-solver",
      version: "1.2.3",
      commandSHA256: hash("reference-solver case.json"),
      configSHA256: hash("effective-config"),
    },
    problemSHA256: hash("equation-domain-bc-ic"),
    reference: { kind: "manufactured", identity: "mms-v1", sha256: hash("manufactured-solution") },
    validation: {
      errorNorm: "relative L2",
      minLevels: 3,
      maxLevels: 6,
      expectedOrder: 2,
      orderTolerance: 0.2,
      maxResidual: 1e-8,
      invariantTolerances: { mass_drift: 1e-6 },
      requiredStressTests: ["solver_tolerance_sensitivity", "reference_replay"],
    },
  })
}

function task(sessionID: string, optimize = false): HarnessAdapter.Task {
  sessions.add(sessionID)
  return HarnessAdapter.Task.parse({
    schemaVersion: 1,
    runID: `run-${sessionID}`,
    sessionID,
    benchmark: optimize ? "physics" : "pde",
    version: "2026.08",
    taskID: "sim-1",
    split: "validation",
    evaluator: { name: "simulation-evaluator", version: "4", source: "benchmark", token },
    objective: "Validate the exact numerical artifact before accepting its score",
    profile: optimize ? "optimize" : "numerical",
    simulation: protocol(),
    extraPacks: optimize ? ["pde"] : [],
    metric: { name: "score", direction: "maximize" },
    model: { provider: "test", name: "model" },
    tools: ["read", "bash"],
    skills: [{ name: "simulator-validation", sha256: hash("simulator-validation-skill") }],
    budget: { steps: 30, ...(optimize ? { candidates: 2 } : {}) },
    seed: 11,
    intervention: "autonomous",
    contamination: { policy: "reference outputs remain evaluator-private", hiddenTestsAccessible: false },
    createdAt: Date.now(),
  })
}

function submit(contract: HarnessContract.Info, subject?: HarnessSimulation.Submit["subject"]) {
  const simulation = contract.simulation
  if (!simulation) throw new Error("Expected a simulator protocol")
  return HarnessSimulation.Submit.parse({
    schemaVersion: 1,
    runID: contract.runID,
    sessionID: contract.sessionID,
    evaluatorToken: token,
    subject: subject ?? {
      type: "run",
      id: contract.runID,
      artifact: { uri: "artifact:solution", sha256: hash("solution-artifact") },
    },
    engine: simulation.engine,
    problemSHA256: simulation.problemSHA256,
    reference: simulation.reference,
    validationInputSHA256: hash("validation-input"),
    levels: [
      { label: "coarse", h: 0.1, error: 0.01, residual: 1e-9, invariants: { mass_drift: 2e-7 } },
      { label: "medium", h: 0.05, error: 0.0025, residual: 2e-9, invariants: { mass_drift: 3e-7 } },
      { label: "fine", h: 0.025, error: 0.000625, residual: 3e-9, invariants: { mass_drift: 4e-7 } },
    ],
    stressTests: [
      { id: "solver_tolerance_sensitivity", status: "passed", evidence: ["artifact:tolerance-sweep.json"] },
      { id: "reference_replay", status: "passed", evidence: ["artifact:reference-replay.json"] },
    ],
    evidence: ["artifact:validation-report.json"],
    evaluatedAt: Date.now(),
  })
}

const checks = (contract: HarnessContract.Info) =>
  HarnessDomain.compose(contract.packs ?? []).map((check) => ({
    id: check.id,
    status: "passed" as const,
    blocking: check.severity === "blocking",
    evidence: [`receipt:${check.id}`],
  }))

function evaluation(contract: HarnessContract.Info, receiptID?: string, candidateID?: string) {
  return HarnessAdapter.Evaluation.parse({
    schemaVersion: 1,
    runID: contract.runID,
    sessionID: contract.sessionID,
    evaluatorToken: token,
    candidateID,
    simulationReceiptID: receiptID,
    status: "passed",
    score: 0.91,
    metrics: { score: 0.91 },
    checks: checks(contract),
    evidence: ["official:numerical-result.json"],
    evaluatedAt: Date.now(),
  })
}

describe("contract-bound simulator validation", () => {
  test("derives convergence and invariant checks instead of accepting a self-reported pass", async () => {
    const contract = await HarnessAdapter.bind(task("simulation-run"))
    const input = { ...submit(contract), evaluatedAt: contract.createdAt + 10 }
    const receipt = await HarnessSimulation.record(input, await HarnessAdapter.authorize(contract.sessionID, token))
    expect(receipt.status).toBe("passed")
    expect(receipt.medianObservedOrder).toBeCloseTo(2)
    expect(receipt.checks).toMatchObject({
      enoughLevels: true,
      resolutionDecreases: true,
      errorDecreases: true,
      observedOrder: true,
      residualBound: true,
      invariants: { mass_drift: true },
      stressTests: { solver_tolerance_sensitivity: true, reference_replay: true },
    })
    expect(JSON.stringify(receipt)).not.toContain(token)
    expect(await HarnessSimulation.list(contract.sessionID)).toEqual([receipt])
    expect((await HarnessSimulation.record(input, contract)).receiptID).toBe(receipt.receiptID)

    await expect(
      HarnessSimulation.record({ ...input, engine: { ...input.engine, version: "silently-changed" } }, contract),
    ).rejects.toThrow("engine does not match")
    expect(await HarnessSimulation.list(contract.sessionID)).toHaveLength(1)
    expect(() =>
      HarnessContract.Info.parse({
        ...contract,
        benchmark: { ...contract.benchmark, evaluatorSource: "human" },
      }),
    ).toThrow("capability-authenticated evaluator source")
  })

  test("blocks final success without a passing receipt and retains failed numerical evidence", async () => {
    const contract = await HarnessAdapter.bind(task("simulation-gate"))
    await expect(HarnessAdapter.ingest(evaluation(contract))).rejects.toThrow("must reference")

    const input = { ...submit(contract), evaluatedAt: contract.createdAt + 10 }
    const levels = input.levels.map((level, index) =>
      index === 1 ? { ...level, error: 0.008, residual: 1e-4 } : level,
    )
    const failed = await HarnessSimulation.record(
      { ...input, levels, validationInputSHA256: hash("failed-validation-input") },
      contract,
    )
    expect(failed.status).toBe("failed")
    expect(failed.checks.residualBound).toBe(false)
    expect(failed.medianObservedOrder).toBeCloseTo(2)
    expect(failed.checks.observedOrder).toBe(false)
    await expect(
      HarnessAdapter.ingest({ ...evaluation(contract, failed.receiptID), evaluatedAt: input.evaluatedAt + 1 }),
    ).rejects.toThrow("requires a passing simulation receipt")

    const passed = await HarnessSimulation.record(input, contract)
    await expect(
      HarnessAdapter.ingest({
        ...evaluation(contract, passed.receiptID),
        evaluatedAt: contract.createdAt + 5,
      }),
    ).rejects.toThrow("predates its referenced validation receipt")
    const result = await HarnessAdapter.ingest({
      ...evaluation(contract, passed.receiptID),
      evaluatedAt: input.evaluatedAt + 2,
    })
    expect(result.evaluation).toMatchObject({ status: "passed", simulationReceiptID: passed.receiptID })
    expect(await HarnessSimulation.list(contract.sessionID)).toHaveLength(2)
  })

  test("fails closed when a persisted receipt is edited outside the append-only API", async () => {
    const contract = await HarnessAdapter.bind(task("simulation-tamper"))
    const receipt = await HarnessSimulation.record(submit(contract), contract)
    const file = path.join(Global.Path.data, "harness", "simulations", `${encodeURIComponent(contract.sessionID)}.json`)
    const journal = (await Bun.file(file).json()) as { items: Record<string, HarnessSimulation.Info> }
    journal.items[receipt.receiptID].status = "failed"
    await Bun.write(file, JSON.stringify(journal))
    await expect(HarnessSimulation.list(contract.sessionID)).rejects.toThrow("content hash is invalid")
  })

  test("binds candidate receipts to the exact content-addressed artifact", async () => {
    const contract = await HarnessAdapter.bind(task("simulation-candidate", true))
    const search = await HarnessSearch.initialize({ sessionID: contract.sessionID, candidates: 2 })
    const recommendation = HarnessSearch.recommend(search)
    const candidate = await HarnessSearch.add({
      sessionID: contract.sessionID,
      recommendationID: recommendation.id,
      parentIDs: recommendation.parentIDs,
      inspirationIDs: recommendation.inspirationIDs,
      branch: "finite-volume",
      proposal: "Validate the finite-volume implementation",
      artifact: { uri: "artifact:solver-candidate", sha256: hash("candidate-artifact") },
    })
    const subject = {
      type: "candidate" as const,
      id: candidate.id,
      artifact: candidate.state.candidates[candidate.id]!.artifact,
    }
    const input = submit(contract, subject)
    await expect(
      HarnessSimulation.record(
        { ...input, subject: { ...subject, artifact: { ...subject.artifact, sha256: hash("different-artifact") } } },
        contract,
      ),
    ).rejects.toThrow("does not match the candidate artifact")

    const receipt = await HarnessSimulation.record(input, contract)
    const result = await HarnessAdapter.ingest(evaluation(contract, receipt.receiptID, candidate.id))
    expect(result.search?.bestID).toBe(candidate.id)
  })

  test("exposes receipt recording and reads only behind the evaluator capability", async () => {
    const contract = await HarnessAdapter.bind(task("simulation-route"))
    const app = HarnessRoutes()
    const recorded = await app.request("/simulations/receipts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(submit(contract)),
    })
    expect(recorded.status).toBe(200)
    const receipt = (await recorded.json()) as HarnessSimulation.Info
    expect(receipt.status).toBe("passed")

    const denied = await app.request(`/simulations/receipts/${receipt.receiptID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: contract.sessionID, evaluatorToken: "short" }),
    })
    expect(denied.status).not.toBe(200)

    const read = await app.request(`/simulations/receipts/${receipt.receiptID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: contract.sessionID, evaluatorToken: token }),
    })
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({ receiptID: receipt.receiptID, status: "passed" })
  })
})

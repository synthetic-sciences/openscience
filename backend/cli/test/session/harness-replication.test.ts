import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { HarnessRoutes } from "../../src/server/routes/harness"
import { HarnessAdapter } from "../../src/session/harness/adapter"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessDomain } from "../../src/session/harness/domain"
import { HarnessOrchestrator } from "../../src/session/harness/orchestrator"
import { HarnessReplication } from "../../src/session/harness/replication"
import { HarnessReport } from "../../src/session/harness/report"
import { HarnessSearch } from "../../src/session/harness/search"

const sessions = new Set<string>()
const receipts = new Set<string>()
const token = "replicated-evaluator-capability-token-0000000000000000"
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")
const digest = (value: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex")

afterEach(async () => {
  await Promise.all(
    [...sessions].flatMap((sessionID) =>
      ["bindings", "contracts", "evaluations", "orchestration", "reports", "search"].map((name) =>
        fs.rm(path.join(Global.Path.data, "harness", name, `${encodeURIComponent(sessionID)}.json`), { force: true }),
      ),
    ),
  )
  await Promise.all(
    [...sessions].map((sessionID) =>
      fs.rm(path.join(Global.Path.data, "harness", "replications", "subjects", digest(sessionID)), {
        recursive: true,
        force: true,
      }),
    ),
  )
  await Promise.all(
    [...receipts].map((receiptID) =>
      fs.rm(path.join(Global.Path.data, "harness", "replications", `${receiptID}.json`), { force: true }),
    ),
  )
  sessions.clear()
  receipts.clear()
})

function protocol(
  input: {
    estimator?: HarnessContract.ReplicationEstimator
    direction?: "maximize" | "minimize" | "pass"
    target?: number
    strata?: number
    clusters?: number
    width?: number
  } = {},
) {
  const estimator = input.estimator ?? "mean"
  const direction = input.direction ?? "maximize"
  return HarnessContract.Replication.parse({
    protocolVersion: "replicated-evaluation-v1",
    validatorSHA256: hash("replication-validator-v1"),
    environmentSHA256: hash("locked-replication-environment"),
    sampling: {
      design: "crossed-stratified-cluster-v1",
      stratumKind: "benchmark task",
      clusterKind: "independent seed",
      strata: Array.from({ length: input.strata ?? 2 }, (_, index) => ({
        id: `task-${index}`,
        commitmentSHA256: hash(`task-${index}`),
      })).toSorted((left, right) => left.id.localeCompare(right.id)),
      clusters: Array.from({ length: input.clusters ?? 5 }, (_, index) => ({
        id: `seed-${index}`,
        commitmentSHA256: hash(`seed-${index}`),
      })).toSorted((left, right) => left.id.localeCompare(right.id)),
    },
    estimator,
    interval:
      estimator === "pass_rate"
        ? { method: "wilson-score-v1", confidence: 0.95 }
        : { method: "stratified-bootstrap-percentile-v1", confidence: 0.95, resamples: 1_000, seed: 1729 },
    decision: {
      rule: "conservative-bound-v1",
      direction,
      target: input.target ?? 0.75,
      maxIntervalWidth: input.width,
    },
    failurePolicy: "fail-closed",
  })
}

function task(
  sessionID: string,
  input: {
    replication?: HarnessContract.Replication
    profile?: HarnessContract.Profile
    candidates?: number
  } = {},
): HarnessAdapter.Task {
  sessions.add(sessionID)
  const replication = input.replication ?? protocol()
  return HarnessAdapter.Task.parse({
    schemaVersion: 1,
    runID: `run-${sessionID}`,
    sessionID,
    benchmark: "statistics",
    version: "2026.08",
    taskID: "replicated-statistical-result",
    split: "validation",
    evaluator: { name: "official-evaluator", version: "7", source: "benchmark", token },
    objective: "Produce a result that remains above the target across frozen tasks and independent seeds",
    profile: input.profile,
    replication,
    metric: {
      name: replication.estimator === "pass_rate" ? "pass_rate" : "score",
      direction: replication.decision.direction,
      target: replication.decision.target,
    },
    model: { provider: "test", name: "model" },
    tools: ["read", "bash"],
    skills: [],
    budget: { steps: 30, candidates: input.candidates },
    seed: 17,
    intervention: "autonomous",
    contamination: { policy: "frozen units remain evaluator-owned", hiddenTestsAccessible: false },
    createdAt: Date.now(),
  })
}

function observations(
  contract: HarnessContract.Info,
  input: {
    scores?: number[]
    statuses?: Array<"passed" | "failed" | "inconclusive">
    evaluatedAt?: number
  } = {},
) {
  const replication = contract.replication!
  const units = replication.sampling.strata.flatMap((stratum) =>
    replication.sampling.clusters.map((cluster) => ({ stratum, cluster })),
  )
  return units.map((unit, index) =>
    HarnessReplication.Observation.parse({
      stratumID: unit.stratum.id,
      clusterID: unit.cluster.id,
      stratumSHA256: unit.stratum.commitmentSHA256,
      clusterSHA256: unit.cluster.commitmentSHA256,
      status: input.statuses?.[index] ?? "passed",
      score:
        replication.estimator === "pass_rate" || (input.statuses?.[index] ?? "passed") !== "passed"
          ? undefined
          : (input.scores?.[index] ?? 0.9),
      outputSHA256: hash(`${contract.sessionID}:${unit.stratum.id}:${unit.cluster.id}:output`),
      environmentSHA256: hash("locked-replication-environment"),
      evidence: [`replicate:${unit.stratum.id}/${unit.cluster.id}.json`],
      evaluatedAt: input.evaluatedAt ?? Math.max(Date.now(), contract.createdAt),
    }),
  )
}

async function replicate(
  contract: HarnessContract.Info,
  input = observations(contract),
  subject: HarnessReplication.Subject = { type: "run", id: contract.runID },
) {
  const receipt = await HarnessReplication.record(
    { sessionID: contract.sessionID, evaluatorToken: token, subject, observations: input },
    await HarnessAdapter.authorize(contract.sessionID, token),
  )
  receipts.add(receipt.receiptID)
  return receipt
}

function evaluation(contract: HarnessContract.Info, receipt?: HarnessReplication.Receipt, candidateID?: string) {
  const checks = HarnessDomain.compose(contract.packs ?? []).map((check) => ({
    id: check.id,
    status: "passed" as const,
    blocking: check.severity === "blocking",
    evidence: [`receipt:${check.id}`],
  }))
  return HarnessAdapter.Evaluation.parse({
    schemaVersion: 1,
    runID: contract.runID,
    sessionID: contract.sessionID,
    evaluatorToken: token,
    candidateID,
    replicationReceiptID: receipt?.receiptID,
    status: "passed",
    score: receipt?.statistics.estimate ?? 0.99,
    metrics: { [contract.benchmark.metric!]: receipt?.statistics.estimate ?? 0.99 },
    checks,
    evidence: ["official:aggregate.json"],
    evaluatedAt: Math.max(Date.now(), receipt?.evaluatedAt ?? 0),
  })
}

describe("replicated evaluation and conservative promotion", () => {
  test("injects the full-grid and conservative-bound policy into main and coalition contexts", async () => {
    const contract = await HarnessAdapter.bind(task("replication-prompt"))
    const prompt = await HarnessReplication.context(contract.sessionID)
    expect(prompt).toContain("2 benchmark task × 5 independent seed clusters (10 units)")
    expect(prompt).toContain("conservative confidence bound, not the best replicate")
    expect(prompt).not.toContain(token)

    const state = await HarnessOrchestrator.initialize(contract.sessionID)
    expect(HarnessOrchestrator.ready(state)[0]!.prompt).toContain(prompt)
  })

  test("promotes only the backend aggregate whose lower bound clears the target", async () => {
    const contract = await HarnessAdapter.bind(task("replication-pass"))
    await expect(HarnessAdapter.ingest(evaluation(contract))).rejects.toThrow("replicated evaluation receipt")
    const receipt = await replicate(contract)
    expect(receipt).toMatchObject({
      status: "passed",
      statistics: { units: 10, passed: 10 },
      subject: { type: "run", id: contract.runID },
    })
    expect(receipt.statistics.estimate).toBeCloseTo(0.9)
    expect(receipt.statistics.conservativeBound).toBeCloseTo(0.9)
    expect(JSON.stringify(receipt)).not.toContain(token)

    await expect(
      HarnessAdapter.ingest({
        ...evaluation(contract, receipt),
        score: 0.99,
        metrics: { score: 0.99 },
      }),
    ).rejects.toThrow("backend-derived replicated estimate")

    const result = await HarnessAdapter.ingest(evaluation(contract, receipt))
    const report = HarnessReport.compile({ contract, evaluations: [result.evaluation], generatedAt: Date.now() })
    expect(result.evaluation).toMatchObject({ status: "passed", replicationReceiptID: receipt.receiptID })
    expect(result.evaluation.score).toBeCloseTo(0.9)
    expect(report.quality.replicationReceiptID).toBe(receipt.receiptID)
  })

  test("rejects environment drift from the precommitted replication environment", async () => {
    const contract = await HarnessAdapter.bind(task("replication-environment"))
    const changed = observations(contract)
    changed[0] = { ...changed[0]!, environmentSHA256: hash("drifted-environment") }
    await expect(replicate(contract, changed)).rejects.toThrow("changed the frozen environment")
  })

  test("rejects task or cluster substitution behind a valid frozen unit ID", async () => {
    const contract = await HarnessAdapter.bind(task("replication-axis-substitution"))
    const changed = observations(contract)
    changed[0] = { ...changed[0]!, clusterSHA256: hash("substituted-cluster") }
    await expect(replicate(contract, changed)).rejects.toThrow("changed a frozen axis commitment")
  })

  test("freezes one canonical receipt per subject while preserving exact retry idempotency", async () => {
    const contract = await HarnessAdapter.bind(task("replication-single-receipt"))
    const first = observations(contract, { scores: Array(10).fill(0.1) })
    const [receipt, concurrent] = await Promise.all([replicate(contract, first), replicate(contract, first)])
    expect(concurrent.receiptID).toBe(receipt.receiptID)
    const retry = await replicate(contract, first)
    expect(retry.receiptID).toBe(receipt.receiptID)
    await expect(replicate(contract, observations(contract, { scores: Array(10).fill(0.99) }))).rejects.toThrow(
      "selective retries are forbidden",
    )
  })

  test("derives finite aggregates without overflowing valid extreme scores", async () => {
    const extremeProtocol = protocol({ target: 1e307, strata: 1, clusters: 5 })
    const contract = await HarnessAdapter.bind(task("replication-stable-aggregate", { replication: extremeProtocol }))
    const receipt = await replicate(contract, observations(contract, { scores: Array(5).fill(1e308) }))
    expect(receipt.status).toBe("passed")
    expect(receipt.statistics.estimate).toBe(1e308)
    expect(receipt.statistics.interval).toEqual([1e308, 1e308])
  })

  test("rejects lucky-best promotion when the conservative bound fails", async () => {
    const contract = await HarnessAdapter.bind(task("replication-lucky-best"))
    const scores = [0.99, 0.1, 0.1, 0.1, 0.1, 0.99, 0.1, 0.1, 0.1, 0.1]
    const receipt = await replicate(contract, observations(contract, { scores }))
    expect(receipt.statistics.estimate).toBeCloseTo(0.278)
    expect(receipt.statistics.conservativeBound).toBeLessThan(0.75)
    expect(receipt.status).toBe("failed")
    await expect(HarnessAdapter.ingest(evaluation(contract, receipt))).rejects.toThrow(
      "passing conservative replication receipt",
    )
  })

  test("uses the upper bound for minimized metrics and enforces precision limits", async () => {
    const minimizeProtocol = protocol({ direction: "minimize", target: 0.2 })
    const minimize = await HarnessAdapter.bind(task("replication-minimize", { replication: minimizeProtocol }))
    const minimized = await replicate(minimize, observations(minimize, { scores: Array(10).fill(0.1) }))
    expect(minimized.status).toBe("passed")
    expect(minimized.statistics.conservativeBound).toBeCloseTo(0.1)
    const accepted = await HarnessAdapter.ingest(evaluation(minimize, minimized))
    expect(accepted.evaluation.status).toBe("passed")

    const narrowProtocol = protocol({ target: 0, strata: 1, clusters: 5, width: 0.01 })
    const narrow = await HarnessAdapter.bind(task("replication-width", { replication: narrowProtocol }))
    const imprecise = await replicate(narrow, observations(narrow, { scores: [0, 1, 2, 3, 4] }))
    expect(imprecise.statistics.conservativeBound).toBeGreaterThanOrEqual(0)
    expect(imprecise.statistics.intervalWidth).toBeGreaterThan(0.01)
    expect(imprecise.failures).toContainEqual(expect.stringContaining("interval width"))
    expect(imprecise.status).toBe("failed")
  })

  test("freezes direction, target, sample size, and deterministic bootstrap semantics", async () => {
    expect(() => protocol({ clusters: 4 })).toThrow("at least five independent clusters")
    const mismatched = task("replication-decision-drift")
    await expect(
      HarnessAdapter.bind({ ...mismatched, metric: { name: "score", direction: "maximize", target: 0.8 } }),
    ).rejects.toThrow("decision must match")

    const first = await HarnessAdapter.bind(task("replication-deterministic-a"))
    const second = await HarnessAdapter.bind(task("replication-deterministic-b"))
    const scores = [0.2, 0.4, 0.6, 0.8, 1, 0.3, 0.5, 0.7, 0.9, 1.1]
    const one = await replicate(first, observations(first, { scores }))
    const two = await replicate(second, observations(second, { scores }))
    expect(one.statistics).toEqual(two.statistics)
  })

  test("requires the exact frozen grid and rejects duplicate pseudo-replicates", async () => {
    const contract = await HarnessAdapter.bind(task("replication-grid"))
    const complete = observations(contract)
    await expect(replicate(contract, complete.slice(1))).rejects.toThrow("complete frozen")
    await expect(replicate(contract, [...complete.slice(0, -1), complete[0]!])).rejects.toThrow("must be unique")

    const base = protocol()
    expect(() =>
      HarnessContract.Replication.parse({
        ...base,
        sampling: {
          ...base.sampling,
          clusters: base.sampling.clusters.map((item, index) => ({
            ...item,
            commitmentSHA256: index ? item.commitmentSHA256 : base.sampling.clusters[1]!.commitmentSHA256,
          })),
        },
      }),
    ).toThrow("commitments must be unique")
  })

  test("fails closed on numeric replicate failures and preserves inconclusive units", async () => {
    const failed = await HarnessAdapter.bind(task("replication-unit-failed"))
    const failedReceipt = await replicate(
      failed,
      observations(failed, {
        statuses: ["failed", "passed", "passed", "passed", "passed", "passed", "passed", "passed", "passed", "passed"],
      }),
    )
    expect(failedReceipt.status).toBe("failed")
    expect(failedReceipt.statistics.estimate).toBeUndefined()
    expect(failedReceipt.failures).toContain("unit:task-0/seed-0:failed")

    const uncertain = await HarnessAdapter.bind(task("replication-unit-inconclusive"))
    const uncertainReceipt = await replicate(
      uncertain,
      observations(uncertain, {
        statuses: [
          "inconclusive",
          "passed",
          "passed",
          "passed",
          "passed",
          "passed",
          "passed",
          "passed",
          "passed",
          "passed",
        ],
      }),
    )
    expect(uncertainReceipt.status).toBe("inconclusive")
    expect(uncertainReceipt.statistics.inconclusive).toBe(1)
  })

  test("computes IQM and Wilson intervals rather than trusting submitted summaries", async () => {
    const iqmProtocol = protocol({ estimator: "iqm", target: 0, strata: 1, clusters: 5 })
    const iqm = await HarnessAdapter.bind(task("replication-iqm", { replication: iqmProtocol }))
    const iqmReceipt = await replicate(iqm, observations(iqm, { scores: [0, 1, 2, 3, 100] }))
    expect(iqmReceipt.statistics.estimate).toBe(2)
    expect(iqmReceipt.statistics.method).toBe("stratified-bootstrap-percentile-v1")

    expect(() => protocol({ estimator: "pass_rate", direction: "pass", strata: 2 })).toThrow(
      "one stratum of independent Bernoulli clusters",
    )
    const passProtocol = protocol({ estimator: "pass_rate", direction: "pass", target: 0.8, strata: 1, clusters: 20 })
    const binary = await HarnessAdapter.bind(task("replication-wilson", { replication: passProtocol }))
    const passReceipt = await replicate(binary)
    expect(passReceipt.statistics).toMatchObject({ estimate: 1, method: "wilson-score-v1" })
    expect(passReceipt.statistics.conservativeBound).toBeGreaterThan(0.8)
    expect(passReceipt.status).toBe("passed")

    const statuses = Array.from({ length: 20 }, (_, index) => (index < 16 ? ("passed" as const) : ("failed" as const)))
    const weak = await HarnessAdapter.bind(task("replication-wilson-weak", { replication: passProtocol }))
    const weakReceipt = await replicate(weak, observations(weak, { statuses }))
    expect(weakReceipt.statistics.estimate).toBe(0.8)
    expect(weakReceipt.statistics.conservativeBound).toBeLessThan(0.8)
    expect(weakReceipt.status).toBe("failed")
  })

  test("binds observations and receipts to candidate birth, session, and subject", async () => {
    const contract = await HarnessAdapter.bind(task("replication-candidate", { profile: "optimize", candidates: 2 }))
    const missing = { type: "candidate" as const, id: hash("future-candidate") }
    await expect(replicate(contract, observations(contract), missing)).rejects.toThrow("does not exist")

    const state = await HarnessSearch.initialize({ sessionID: contract.sessionID, candidates: 2 })
    const recommendation = HarnessSearch.recommend(state)
    const added = await HarnessSearch.add({
      sessionID: contract.sessionID,
      recommendationID: recommendation.id,
      parentIDs: recommendation.parentIDs,
      inspirationIDs: recommendation.inspirationIDs,
      branch: "replication-candidate",
      proposal: "Evaluate this immutable candidate across the complete frozen grid",
      artifact: { uri: "candidate://replicated", sha256: hash("replicated-candidate") },
    })
    const candidate = (await HarnessSearch.read(contract.sessionID)).candidates[added.id]!
    await expect(
      replicate(contract, observations(contract, { evaluatedAt: candidate.createdAt - 1 }), {
        type: "candidate",
        id: candidate.id,
      }),
    ).rejects.toThrow("subject interval")

    const receipt = await replicate(contract, observations(contract), { type: "candidate", id: candidate.id })
    const result = await HarnessAdapter.ingest(evaluation(contract, receipt, candidate.id))
    expect(result.evaluation).toMatchObject({ subject: { type: "candidate", id: candidate.id }, status: "passed" })

    const other = await HarnessAdapter.bind(task("replication-other-session"))
    await expect(HarnessAdapter.ingest(evaluation(other, receipt))).rejects.toThrow("different harness session")
  })

  test("prevents post-hoc receipts after a final evaluation", async () => {
    const contract = await HarnessAdapter.bind(task("replication-post-hoc"))
    const checks = evaluation(contract).checks
    await HarnessAdapter.ingest({
      schemaVersion: 1,
      runID: contract.runID,
      sessionID: contract.sessionID,
      evaluatorToken: token,
      status: "failed",
      score: 0.2,
      metrics: { score: 0.2 },
      checks,
      evidence: ["official:failed-final.json"],
      evaluatedAt: Date.now(),
    })
    await expect(replicate(contract)).rejects.toThrow("before the subject's final evaluation")
  })

  test("detects both ordinary tampering and content-addressed derived-state forgery", async () => {
    const contract = await HarnessAdapter.bind(task("replication-tamper"))
    const receipt = await replicate(contract)
    const target = path.join(Global.Path.data, "harness", "replications", `${receipt.receiptID}.json`)
    await Bun.write(target, JSON.stringify({ ...receipt, recordedAt: receipt.recordedAt + 1 }))
    expect(await HarnessReplication.read(receipt.receiptID)).toBeNull()

    const forged = {
      ...receipt,
      status: "failed" as const,
      failures: ["forged verdict"],
      statistics: { ...receipt.statistics, estimate: 0.99 },
    }
    const stable = structuredClone(forged) as Record<string, unknown>
    delete stable.receiptID
    const receiptID = digest(stable)
    receipts.add(receiptID)
    await Bun.write(target.replace(receipt.receiptID, receiptID), JSON.stringify({ ...forged, receiptID }))
    expect(await HarnessReplication.read(receiptID)).not.toBeNull()
    await expect(
      HarnessReplication.assert({
        contract,
        receiptID,
        subject: { type: "run", id: contract.runID },
        score: 0.99,
        evaluatedAt: Date.now(),
        recordedAt: Date.now(),
        requirePassed: false,
      }),
    ).rejects.toThrow("non-canonical receipt")
  })

  test("exposes replicated receipts only through the evaluator capability", async () => {
    const contract = await HarnessAdapter.bind(task("replication-route"))
    const app = HarnessRoutes()
    const response = await app.request("/replications/receipts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionID: contract.sessionID,
        evaluatorToken: token,
        subject: { type: "run", id: contract.runID },
        observations: observations(contract),
      }),
    })
    expect(response.status).toBe(200)
    const receipt = (await response.json()) as HarnessReplication.Receipt
    receipts.add(receipt.receiptID)

    const denied = await app.request(`/replications/receipts/${receipt.receiptID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionID: contract.sessionID,
        evaluatorToken: "wrong-token-0000000000000000000000000000",
      }),
    })
    expect(denied.status).not.toBe(200)

    const read = await app.request(`/replications/receipts/${receipt.receiptID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: contract.sessionID, evaluatorToken: token }),
    })
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({ receiptID: receipt.receiptID, status: "passed" })
  })
})

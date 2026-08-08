import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { HarnessAdapter } from "../../src/session/harness/adapter"
import { HarnessAudit } from "../../src/session/harness/audit"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessEvaluation } from "../../src/session/harness/evaluation"
import { HarnessSearch } from "../../src/session/harness/search"

const sessions = new Set<string>()
const receipts = new Set<string>()
const token = "active-audit-evaluator-capability-token-000000000000"
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")

afterEach(async () => {
  await Promise.all(
    [...sessions].flatMap((sessionID) => [
      fs.rm(path.join(Global.Path.data, "harness", "bindings", `${encodeURIComponent(sessionID)}.json`), {
        force: true,
      }),
      fs.rm(path.join(Global.Path.data, "harness", "contracts", `${encodeURIComponent(sessionID)}.json`), {
        force: true,
      }),
      fs.rm(path.join(Global.Path.data, "harness", "search", `${encodeURIComponent(sessionID)}.json`), {
        force: true,
      }),
      fs.rm(path.join(Global.Path.data, "harness", "evaluations", `${encodeURIComponent(sessionID)}.json`), {
        force: true,
      }),
      fs.rm(path.join(Global.Path.data, "harness", "audits", encodeURIComponent(sessionID)), {
        recursive: true,
        force: true,
      }),
    ]),
  )
  await Promise.all(
    [...receipts].map((receiptID) =>
      fs.rm(path.join(Global.Path.data, "harness", "audit-receipts", `${receiptID}.json`), { force: true }),
    ),
  )
  sessions.clear()
  receipts.clear()
})

function config(values: Partial<HarnessContract.Audit> = {}): HarnessContract.Audit {
  return HarnessContract.Audit.parse({
    mode: "performance",
    budget: 3,
    minSamples: 2,
    noiseVariance: 0.05,
    lengthscale: 0.7,
    beta: 0,
    failureThreshold: 0.5,
    tolerance: 0.01,
    maxUncertainty: 0.05,
    estimationWeight: 0.5,
    diversityWeight: 0.3,
    coverageWeight: 0.2,
    ...values,
  })
}

async function bind(sessionID: string, audit = config()) {
  sessions.add(sessionID)
  return HarnessAdapter.bind({
    schemaVersion: 1,
    runID: `run-${sessionID}`,
    sessionID,
    benchmark: "statistics",
    version: "2026.08",
    taskID: "active-audit",
    split: "validation",
    evaluator: { name: "official-evaluator", version: "1", source: "benchmark", token },
    objective: "Estimate held-out loss and discover diverse failures",
    audit,
    metric: { name: "loss", direction: "minimize" },
    model: { provider: "test", name: "model" },
    tools: [],
    skills: [],
    budget: { steps: 20 },
    seed: 7,
    intervention: "autonomous",
    contamination: { policy: "hidden probes remain external", hiddenTestsAccessible: false },
    createdAt: Date.now(),
  })
}

const line = Array.from(
  { length: 5 },
  (_, index): HarnessAudit.Probe => ({
    id: `probe-${index}`,
    commitment: hash(`hidden-probe-${index}`),
    features: [index - 2],
    stratum: index < 3 ? "left" : "right",
    weight: 1,
    priorLoss: 0.5,
  }),
)

const history = Array.from(
  { length: 5 },
  (_, index): HarnessAudit.TransferProbe => ({
    id: `history-${index}`,
    commitment: hash(`hidden-history-${index}`),
    sourceLosses: [0.1 + index * 0.05, 0.2 + index * 0.05, 0.3 + index * 0.05],
    stratum: index < 3 ? "left" : "right",
    weight: 1,
  }),
)

function proactive(values: Partial<HarnessContract.Audit> = {}) {
  return config({
    budget: 3,
    minSamples: 2,
    tolerance: 1,
    maxUncertainty: 1,
    transfer: {
      protocolVersion: "score-history-prior-v1",
      poolSHA256: hash(JSON.stringify(history)),
      sourceManifestSHA256: hash(
        JSON.stringify({
          sourceModels: ["source-a", "source-b", "source-c"],
          scores: history.map((probe) => ({ id: probe.id, sourceLosses: probe.sourceLosses })),
        }),
      ),
      selectionSHA256: hash("pca-gmm-selection"),
      selectionMethod: "pca-gmm-profile-v1",
      sourceModels: ["source-a", "source-b", "source-c"],
      calibrationSamples: 2,
      maxCalibrationMAE: 0.2,
    },
    ...values,
  })
}

function access(sessionID: string): HarnessAudit.Access {
  return { sessionID, evaluatorToken: token }
}

describe("active committed-probe audit", () => {
  test("preserves legacy contract fingerprints unless proactive promotion is explicit", () => {
    const legacy = { mode: "performance" as const, budget: 3, minSamples: 2 }
    const parsed = HarnessContract.Audit.parse(legacy)
    expect(parsed.promotionRequired).toBeUndefined()
    expect(JSON.stringify(parsed)).not.toContain("promotionRequired")
    expect(() => HarnessContract.Audit.parse({ ...legacy, promotionRequired: true })).toThrow("transfer-qualified")
    expect(() => HarnessContract.Audit.parse({ ...proactive(), mode: "failure", promotionRequired: true })).toThrow(
      "failure-only",
    )
  })

  test("binds an opaque pool to the evaluator capability and audited artifact", async () => {
    const contract = await bind("audit-bind")
    const input: HarnessAudit.Initialize = {
      ...access(contract.sessionID),
      subject: { type: "run", id: contract.runID, artifactSHA256: hash("frozen-run-artifact") },
      probes: line,
    }
    await expect(HarnessAudit.initialize({ ...input, evaluatorToken: "x".repeat(40) })).rejects.toThrow(
      "capability was rejected",
    )
    const state = await HarnessAudit.initialize(input)
    expect(state).toMatchObject({
      protocolVersion: "active-audit-v1",
      status: "active",
      revision: 0,
      estimate: { observed: 0, failures: 0, abstain: true },
    })
    expect(state.order).toEqual(line.map((probe) => probe.id).toSorted())
    expect(JSON.stringify(state)).not.toContain(token)
    expect(JSON.stringify(state)).not.toContain("hidden-probe")
    expect(await HarnessAudit.initialize(input)).toEqual(state)
    await expect(
      HarnessAudit.status(state.auditID, { ...access(contract.sessionID), evaluatorToken: "z".repeat(40) }),
    ).rejects.toThrow("capability was rejected")
    const file = path.join(
      Global.Path.data,
      "harness",
      "audits",
      encodeURIComponent(contract.sessionID),
      `${encodeURIComponent(state.auditID)}.json`,
    )
    const tampered = JSON.parse(await fs.readFile(file, "utf8"))
    tampered.pool["probe-0"].features[0] = 999
    await fs.writeFile(file, JSON.stringify(tampered))
    await expect(HarnessAudit.status(state.auditID, access(contract.sessionID))).rejects.toThrow(
      "failed its commitment",
    )
  })

  test("selects high-leverage probes, decreases uncertainty, and is restart-idempotent", async () => {
    const contract = await bind("audit-performance")
    const state = await HarnessAudit.initialize({
      ...access(contract.sessionID),
      subject: { type: "run", id: contract.runID, artifactSHA256: hash("performance-artifact") },
      probes: line,
    })
    const selected = await HarnessAudit.select(state.auditID, access(contract.sessionID))
    expect(selected.probeID).toBe("probe-2")
    expect(selected.acquisition.varianceReduction).toBeGreaterThan(0)
    expect(await HarnessAudit.select(state.auditID, access(contract.sessionID))).toEqual(selected)

    await expect(
      HarnessAudit.observe(state.auditID, {
        ...access(contract.sessionID),
        probeID: "probe-0",
        loss: 0,
        failure: false,
        evidence: ["receipt://unselected"],
      }),
    ).rejects.toThrow("selected before observation")
    const observed = await HarnessAudit.observe(state.auditID, {
      ...access(contract.sessionID),
      probeID: selected.probeID,
      loss: 0.4,
      failure: false,
      evidence: ["receipt://probe-2"],
    })
    expect(observed.estimate.observed).toBe(1)
    expect(observed.estimate.standardDeviation).toBeLessThan(state.estimate.standardDeviation)
    expect(observed.estimate.abstain).toBe(true)
    expect(observed.pool[selected.probeID]!.observation!.evaluatedAt).toBeGreaterThan(0)
    expect(await HarnessAudit.status(state.auditID, access(contract.sessionID))).toEqual(observed)
  })

  test("uses failure diversity and coverage to leave a discovered neighborhood", async () => {
    const audit = config({ mode: "failure", budget: 4, minSamples: 2, targetFailures: 2, lengthscale: 0.2 })
    const contract = await bind("audit-failure", audit)
    const probes: HarnessAudit.Probe[] = [
      { id: "a-1", commitment: hash("a-1"), features: [0, 0], stratum: "a", weight: 1, priorLoss: 0.95 },
      { id: "a-2", commitment: hash("a-2"), features: [0.05, 0], stratum: "a", weight: 1, priorLoss: 0.9 },
      { id: "b-1", commitment: hash("b-1"), features: [10, 10], stratum: "b", weight: 1, priorLoss: 0.85 },
      { id: "b-2", commitment: hash("b-2"), features: [10.05, 10], stratum: "b", weight: 1, priorLoss: 0.8 },
    ]
    const state = await HarnessAudit.initialize({
      ...access(contract.sessionID),
      subject: { type: "run", id: contract.runID, artifactSHA256: hash("failure-artifact") },
      probes,
    })
    const first = await HarnessAudit.select(state.auditID, access(contract.sessionID))
    expect(first.probeID).toBe("a-1")
    await HarnessAudit.observe(state.auditID, {
      ...access(contract.sessionID),
      probeID: first.probeID,
      loss: 1,
      failure: true,
      evidence: ["receipt://failure-a"],
    })
    const second = await HarnessAudit.select(state.auditID, access(contract.sessionID))
    expect(second.probeID).toBe("b-1")
    expect(second.acquisition.diversity).toBeGreaterThan(0.9)
    const completed = await HarnessAudit.observe(state.auditID, {
      ...access(contract.sessionID),
      probeID: second.probeID,
      loss: 0.9,
      failure: true,
      evidence: ["receipt://failure-b"],
    })
    expect(completed).toMatchObject({
      status: "completed",
      stopReason: "failure_target_reached",
      estimate: { observed: 2, failures: 2, stratumCoverage: 1 },
    })
  })

  test("rejects contradictory and mutable evaluator outcomes", async () => {
    const contract = await bind("audit-outcome")
    const state = await HarnessAudit.initialize({
      ...access(contract.sessionID),
      subject: { type: "run", id: contract.runID, artifactSHA256: hash("outcome-artifact") },
      probes: line,
    })
    const selected = await HarnessAudit.select(state.auditID, access(contract.sessionID))
    await expect(
      HarnessAudit.observe(state.auditID, {
        ...access(contract.sessionID),
        probeID: selected.probeID,
        loss: 0.9,
        failure: false,
        evidence: ["receipt://contradiction"],
      }),
    ).rejects.toThrow("threshold")
    const input: HarnessAudit.Observe = {
      ...access(contract.sessionID),
      probeID: selected.probeID,
      loss: 0.9,
      failure: true,
      evidence: ["receipt://failure"],
    }
    const observed = await HarnessAudit.observe(state.auditID, input)
    const repeated = await HarnessAudit.observe(state.auditID, input)
    expect(repeated).toEqual(observed)
    await expect(HarnessAudit.observe(state.auditID, { ...input, loss: 0.8 })).rejects.toThrow("immutable")
  })

  test("binds candidate audits to the candidate's exact artifact hash", async () => {
    const sessionID = "audit-candidate"
    sessions.add(sessionID)
    const contract = await HarnessAdapter.bind({
      schemaVersion: 1,
      runID: `run-${sessionID}`,
      sessionID,
      benchmark: "mle",
      version: "2026.08",
      taskID: "candidate-audit",
      split: "validation",
      evaluator: { name: "official-evaluator", version: "1", source: "benchmark", token },
      objective: "Optimize and actively audit a frozen candidate",
      audit: config(),
      metric: { name: "score", direction: "maximize" },
      model: { provider: "test", name: "model" },
      tools: [],
      skills: [],
      budget: { steps: 20, candidates: 2 },
      seed: 7,
      intervention: "autonomous",
      contamination: { policy: "hidden probes remain external", hiddenTestsAccessible: false },
      createdAt: Date.now(),
    })
    const search = await HarnessSearch.initialize({ sessionID })
    const recommendation = HarnessSearch.recommend(search)
    const added = await HarnessSearch.add({
      sessionID,
      recommendationID: recommendation.id,
      parentIDs: recommendation.parentIDs,
      inspirationIDs: recommendation.inspirationIDs,
      branch: "baseline",
      proposal: "frozen baseline",
      artifact: { uri: "artifact://candidate", sha256: hash("candidate-artifact") },
    })
    const input: HarnessAudit.Initialize = {
      ...access(sessionID),
      subject: { type: "candidate", id: added.id, artifactSHA256: hash("wrong-artifact") },
      probes: line,
    }
    await expect(HarnessAudit.initialize(input)).rejects.toThrow("does not match")
    const state = await HarnessAudit.initialize({
      ...input,
      subject: { ...input.subject, artifactSHA256: hash("candidate-artifact") },
    })
    expect(state.subject).toEqual({
      type: "candidate",
      id: added.id,
      artifactSHA256: hash("candidate-artifact"),
    })
    expect(state.contractFingerprint).toBe(HarnessContract.fingerprint(contract))
  })

  test("derives score-history priors and keeps calibration selection independent of outcomes", async () => {
    const left = await bind(
      "audit-transfer-left",
      proactive({ transfer: { ...proactive().transfer!, maxCalibrationMAE: 1 } }),
    )
    const right = await bind(
      "audit-transfer-right",
      proactive({ transfer: { ...proactive().transfer!, maxCalibrationMAE: 1 } }),
    )
    const initialize = async (contract: HarnessContract.Info) =>
      HarnessAudit.initialize({
        ...access(contract.sessionID),
        subject: { type: "run", id: contract.runID, artifactSHA256: hash("same-transfer-artifact") },
        probes: history,
      })
    await expect(
      HarnessAudit.initialize({
        ...access(left.sessionID),
        subject: { type: "run", id: left.runID, artifactSHA256: hash("same-transfer-artifact") },
        probes: line,
      }),
    ).rejects.toThrow()
    const leftState = await initialize(left)
    const rightState = await initialize(right)
    expect(leftState.protocolVersion).toBe("proactive-audit-v2")
    expect(leftState.estimate.transfer).toMatchObject({ status: "calibrating", observed: 0, required: 2 })
    const entry = leftState.pool["history-0"]!
    expect(entry.priorLoss).toBeCloseTo(0.2)
    expect(entry.features.reduce((sum, value) => sum + value, 0)).toBeCloseTo(0)
    expect(entry.sourceLosses).toEqual(history[0]!.sourceLosses)
    await expect(
      HarnessAudit.initialize({
        ...access(left.sessionID),
        subject: leftState.subject,
        probes: history.map((probe, index) =>
          index === 0 ? { ...probe, sourceLosses: [0, ...probe.sourceLosses.slice(1)] } : probe,
        ),
      }),
    ).rejects.toThrow("frozen transfer-pool commitment")

    const leftFirst = await HarnessAudit.select(leftState.auditID, access(left.sessionID))
    const rightFirst = await HarnessAudit.select(rightState.auditID, access(right.sessionID))
    expect(leftFirst.probeID).toBe(rightFirst.probeID)
    expect(leftFirst.phase).toBe("calibration")
    await HarnessAudit.observe(leftState.auditID, {
      ...access(left.sessionID),
      probeID: leftFirst.probeID,
      loss: 0,
      failure: false,
      evidence: ["receipt://left-calibration"],
    })
    await HarnessAudit.observe(rightState.auditID, {
      ...access(right.sessionID),
      probeID: rightFirst.probeID,
      loss: 1,
      failure: true,
      evidence: ["receipt://right-calibration"],
    })
    const leftSecond = await HarnessAudit.select(leftState.auditID, access(left.sessionID))
    const rightSecond = await HarnessAudit.select(rightState.auditID, access(right.sessionID))
    expect(leftSecond.probeID).toBe(rightSecond.probeID)
    expect(leftSecond.phase).toBe("calibration")
  })

  test("rejects negative transfer, permanently abstains, and seals an unqualified receipt", async () => {
    const contract = await bind(
      "audit-transfer-reject",
      proactive({ transfer: { ...proactive().transfer!, maxCalibrationMAE: 0.01 } }),
    )
    const state = await HarnessAudit.initialize({
      ...access(contract.sessionID),
      subject: { type: "run", id: contract.runID, artifactSHA256: hash("rejected-transfer-artifact") },
      probes: history,
    })
    await expect(HarnessAudit.seal(state.auditID, access(contract.sessionID))).rejects.toThrow("terminal")
    for (const loss of [1, 1, 1]) {
      const selected = await HarnessAudit.select(state.auditID, access(contract.sessionID))
      const observed = await HarnessAudit.observe(state.auditID, {
        ...access(contract.sessionID),
        probeID: selected.probeID,
        loss,
        failure: true,
        evidence: [`receipt://rejected-${selected.round}`],
      })
      if (selected.round === 2) {
        expect(observed.estimate.transfer.status).toBe("rejected")
        expect(observed.estimate.abstain).toBe(true)
      }
      if (selected.round === 3) expect(selected.phase).toBe("fallback")
    }
    const completed = await HarnessAudit.status(state.auditID, access(contract.sessionID))
    expect(completed).toMatchObject({
      status: "completed",
      stopReason: "budget_exhausted",
      estimate: { abstain: true, transfer: { status: "rejected" } },
    })
    const receipt = await HarnessAudit.seal(state.auditID, access(contract.sessionID))
    receipts.add(receipt.receiptID)
    expect(receipt.qualified).toBe(false)
    expect(await HarnessAudit.seal(state.auditID, access(contract.sessionID))).toEqual(receipt)
    await expect(
      HarnessAudit.assert({
        contract,
        receiptID: receipt.receiptID,
        subject: { type: "run", id: contract.runID },
        evaluatedAt: Date.now(),
        recordedAt: Date.now(),
        requireQualified: true,
      }),
    ).rejects.toThrow("qualified non-abstaining")
    await expect(
      HarnessAudit.assert({
        contract,
        receiptID: receipt.receiptID,
        subject: { type: "run", id: "different-run" },
        evaluatedAt: Date.now(),
        recordedAt: Date.now(),
        requireQualified: false,
      }),
    ).rejects.toThrow("different evaluation subject")
    await expect(
      HarnessAudit.assert({
        contract,
        receiptID: receipt.receiptID,
        subject: { type: "run", id: contract.runID },
        evaluatedAt: receipt.completedAt - 1,
        recordedAt: Date.now(),
        requireQualified: false,
      }),
    ).rejects.toThrow("predates")
    const stateFile = path.join(
      Global.Path.data,
      "harness",
      "audits",
      encodeURIComponent(contract.sessionID),
      `${state.auditID}.json`,
    )
    const original = await fs.readFile(stateFile, "utf8")
    const changed = JSON.parse(original)
    changed.estimate.meanLoss = 0
    await fs.writeFile(stateFile, JSON.stringify(changed))
    expect(await HarnessAudit.readReceipt(receipt.receiptID)).toBeNull()
    await fs.writeFile(stateFile, original)
    const receiptFile = path.join(Global.Path.data, "harness", "audit-receipts", `${receipt.receiptID}.json`)
    const tampered = JSON.parse(await fs.readFile(receiptFile, "utf8"))
    tampered.estimate.meanLoss = 0
    await fs.writeFile(receiptFile, JSON.stringify(tampered))
    expect(await HarnessAudit.readReceipt(receipt.receiptID)).toBeNull()
  })

  test("requires a matching qualified audit receipt before final promotion", async () => {
    const contract = await bind("audit-promotion", proactive({ promotionRequired: true }))
    const state = await HarnessAudit.initialize({
      ...access(contract.sessionID),
      subject: { type: "run", id: contract.runID, artifactSHA256: hash("promoted-transfer-artifact") },
      probes: history,
    })
    for (let round = 0; round < 2; round++) {
      const selected = await HarnessAudit.select(state.auditID, access(contract.sessionID))
      const prior = (await HarnessAudit.status(state.auditID, access(contract.sessionID))).pool[selected.probeID]!
        .priorLoss
      await HarnessAudit.observe(state.auditID, {
        ...access(contract.sessionID),
        probeID: selected.probeID,
        loss: prior,
        failure: false,
        evidence: [`receipt://accepted-${round}`],
      })
    }
    const receipt = await HarnessAudit.seal(state.auditID, access(contract.sessionID))
    receipts.add(receipt.receiptID)
    expect(receipt.qualified).toBe(true)
    const evaluation: HarnessEvaluation.Info = {
      schemaVersion: 1,
      runID: contract.runID,
      sessionID: contract.sessionID,
      evaluator: { name: "official-evaluator", version: "1", source: "benchmark" },
      status: "passed",
      score: 0.2,
      metrics: { loss: 0.2 },
      checks: ["estimand", "assumptions", "effect-size", "uncertainty", "multiplicity", "stat-replay"].map((id) => ({
        id,
        status: "passed" as const,
        blocking: true,
        evidence: [`receipt://${id}`],
      })),
      evidence: ["receipt://official-score"],
      evaluatedAt: Math.max(Date.now(), receipt.sealedAt),
    }
    await expect(HarnessEvaluation.record(evaluation)).rejects.toThrow("qualified active audit receipt")
    const recorded = await HarnessEvaluation.record({ ...evaluation, auditReceiptID: receipt.receiptID })
    expect(recorded.auditReceiptID).toBe(receipt.receiptID)
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { HarnessAdapter } from "../../src/session/harness/adapter"
import { HarnessAudit } from "../../src/session/harness/audit"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessSearch } from "../../src/session/harness/search"

const sessions = new Set<string>()
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
      fs.rm(path.join(Global.Path.data, "harness", "audits", encodeURIComponent(sessionID)), {
        recursive: true,
        force: true,
      }),
    ]),
  )
  sessions.clear()
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
    split: "held_out",
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

function access(sessionID: string): HarnessAudit.Access {
  return { sessionID, evaluatorToken: token }
}

describe("active committed-probe audit", () => {
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
      split: "held_out",
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
    await HarnessSearch.initialize({ sessionID })
    const added = await HarnessSearch.add({
      sessionID,
      parentIDs: [],
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
})

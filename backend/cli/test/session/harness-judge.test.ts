import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { HarnessRoutes } from "../../src/server/routes/harness"
import { HarnessAdapter } from "../../src/session/harness/adapter"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessDomain } from "../../src/session/harness/domain"
import { HarnessJudge } from "../../src/session/harness/judge"

const sessions = new Set<string>()
const receipts = new Set<string>()
const evaluator = "judge-evaluator-capability-token-000000000000000000"
const auditor = "judge-auditor-capability-token-0000000000000000000"
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")

afterEach(async () => {
  await Promise.all(
    [...sessions].flatMap((sessionID) =>
      ["bindings", "contracts", "evaluations", "search"].map((name) =>
        fs.rm(path.join(Global.Path.data, "harness", name, `${encodeURIComponent(sessionID)}.json`), { force: true }),
      ),
    ),
  )
  await Promise.all(
    [...receipts].map((receiptID) =>
      fs.rm(path.join(Global.Path.data, "harness", "judges", `${receiptID}.json`), { force: true }),
    ),
  )
  sessions.clear()
  receipts.clear()
})

function task(sessionID: string, evaluatorVersion = "3"): HarnessAdapter.Task {
  sessions.add(sessionID)
  return HarnessAdapter.Task.parse({
    schemaVersion: 1,
    runID: `run-${sessionID}`,
    sessionID,
    benchmark: "statistics",
    version: "2026.08",
    taskID: "judge-qualification-task",
    split: "validation",
    evaluator: {
      name: "official-scientific-evaluator",
      version: evaluatorVersion,
      source: "benchmark",
      token: evaluator,
    },
    evaluatorAudit: { protocol: protocol(), token: auditor },
    objective: "Require evidence that the evaluator detects realistic scientific failures",
    metric: { name: "score", direction: "maximize" },
    model: { provider: "test", name: "model" },
    tools: ["read", "bash"],
    skills: [],
    budget: { steps: 20 },
    seed: 17,
    intervention: "autonomous",
    contamination: { policy: "hidden evaluator audit cases remain auditor-private", hiddenTestsAccessible: false },
    createdAt: Date.now(),
  })
}

function cases(weak = false): HarnessJudge.Case[] {
  return [
    {
      id: "clean-1",
      commitment: hash("clean-1"),
      kind: "clean",
      decision: "accept",
      failureProbability: 0.05,
      evidence: ["audit:clean-1"],
    },
    {
      id: "clean-2",
      commitment: hash("clean-2"),
      kind: "clean",
      decision: "accept",
      failureProbability: 0.1,
      evidence: ["audit:clean-2"],
    },
    ...[1, 2].map((index) => ({
      id: `wrong-${index}`,
      commitment: hash(`wrong-${index}`),
      kind: "fault" as const,
      fault: "wrong_answer" as const,
      decision: weak ? ("accept" as const) : ("reject" as const),
      failureProbability: weak ? 0.1 : 0.9,
      evidence: [`audit:wrong-${index}`],
    })),
    ...[1, 2].map((index) => ({
      id: `leak-${index}`,
      commitment: hash(`leak-${index}`),
      kind: "fault" as const,
      fault: "data_leakage" as const,
      decision: "reject" as const,
      failureProbability: 0.95,
      evidence: [`audit:leak-${index}`],
    })),
  ]
}

function protocol() {
  return HarnessContract.EvaluatorAudit.parse({
    protocolVersion: "evaluator-audit-v1",
    auditor: { name: "independent-meta-evaluator", version: "2", source: "external" },
    suite: {
      name: "scientific-judge-faults",
      version: "2026.08",
      commitmentSHA256: HarnessJudge.commitment(cases()),
    },
    minCleanCases: 2,
    minCasesPerFault: 2,
    requiredFaults: ["wrong_answer", "data_leakage"],
    minSensitivity: 0.75,
    minSpecificity: 1,
    minBalancedAccuracy: 0.85,
    minFaultRecall: 0.5,
    maxBrierScore: 0.15,
  })
}

function evaluation(contract: HarnessContract.Info, receiptID?: string) {
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
    evaluatorToken: evaluator,
    evaluatorAuditReceiptID: receiptID,
    status: "passed",
    score: 0.91,
    metrics: { score: 0.91 },
    checks,
    evidence: ["official:held-out-score.json"],
    evaluatedAt: Date.now(),
  })
}

async function qualify(contract: HarnessContract.Info, weak = false) {
  const receipt = await HarnessJudge.record(
    { sessionID: contract.sessionID, auditorToken: auditor, cases: cases(weak) },
    await HarnessAdapter.authorizeAuditor(contract.sessionID, auditor),
  )
  receipts.add(receipt.receiptID)
  return receipt
}

describe("independent evaluator qualification", () => {
  test("recomputes a passing hidden-suite audit and gates the final benchmark result", async () => {
    const contract = await HarnessAdapter.bind(task("judge-pass"))
    await expect(HarnessAdapter.ingest(evaluation(contract))).rejects.toThrow("qualified evaluator audit receipt")
    const receipt = await qualify(contract)
    expect(receipt).toMatchObject({
      status: "passed",
      metrics: {
        cases: 6,
        cleanCases: 2,
        faultCases: 4,
        sensitivity: 1,
        specificity: 1,
        balancedAccuracy: 1,
      },
    })
    expect(receipt.metrics.brierScore).toBeLessThan(0.01)
    expect(receipt.metrics.perFault.wrong_answer).toEqual({ cases: 2, detected: 2, recall: 1 })
    expect(JSON.stringify(receipt)).not.toContain(auditor)
    expect(JSON.stringify(receipt)).not.toContain(evaluator)

    const result = await HarnessAdapter.ingest(evaluation(contract, receipt.receiptID))
    expect(result.evaluation).toMatchObject({
      status: "passed",
      evaluatorAuditReceiptID: receipt.receiptID,
    })
  })

  test("keeps a weak but authenticated judge from promoting a passing result", async () => {
    const contract = await HarnessAdapter.bind(task("judge-weak"))
    const receipt = await qualify(contract, true)
    expect(receipt.status).toBe("failed")
    expect(receipt.metrics).toMatchObject({ sensitivity: 0.5, specificity: 1, balancedAccuracy: 0.75 })
    expect(receipt.metrics.perFault.wrong_answer?.recall).toBe(0)
    expect(receipt.failures).toEqual(
      expect.arrayContaining([expect.stringContaining("sensitivity"), expect.stringContaining("wrong_answer recall")]),
    )
    await expect(HarnessAdapter.ingest(evaluation(contract, receipt.receiptID))).rejects.toThrow(
      "requires a passing evaluator audit receipt",
    )
  })

  test("rejects case substitution outside the precommitted hidden suite", async () => {
    const contract = await HarnessAdapter.bind(task("judge-suite-substitution"))
    const changed = cases()
    changed[0] = { ...changed[0]!, commitment: hash("substituted-clean-case") }
    await expect(
      HarnessJudge.record(
        { sessionID: contract.sessionID, auditorToken: auditor, cases: changed },
        await HarnessAdapter.authorizeAuditor(contract.sessionID, auditor),
      ),
    ).rejects.toThrow("precommitted hidden suite")
  })

  test("requires the independent auditor capability and keeps bindings immutable", async () => {
    const input = task("judge-capability")
    const contract = await HarnessAdapter.bind(input)
    await expect(HarnessAdapter.authorizeAuditor(contract.sessionID, evaluator)).rejects.toThrow("rejected")
    await expect(
      HarnessAdapter.bind({
        ...input,
        evaluatorAudit: { ...input.evaluatorAudit!, token: `${auditor}-changed` },
      }),
    ).rejects.toThrow("immutable")
    expect(() =>
      HarnessAdapter.Task.parse({
        ...task("judge-shared-capability"),
        evaluatorAudit: { protocol: protocol(), token: evaluator },
      }),
    ).toThrow("capabilities must differ")
  })

  test("does not reuse a qualification across different evaluator versions", async () => {
    const first = await HarnessAdapter.bind(task("judge-version-3", "3"))
    const receipt = await qualify(first)
    const second = await HarnessAdapter.bind(task("judge-version-4", "4"))
    await expect(HarnessAdapter.ingest(evaluation(second, receipt.receiptID))).rejects.toThrow("different evaluator")
  })

  test("fails closed when an evaluator audit receipt is changed on disk", async () => {
    const contract = await HarnessAdapter.bind(task("judge-tamper"))
    const receipt = await qualify(contract)
    const target = path.join(Global.Path.data, "harness", "judges", `${receipt.receiptID}.json`)
    await Bun.write(target, JSON.stringify({ ...receipt, status: "failed" }))
    expect(await HarnessJudge.read(receipt.receiptID)).toBeNull()
    await expect(HarnessAdapter.ingest(evaluation(contract, receipt.receiptID))).rejects.toThrow("Unknown or corrupt")
  })

  test("exposes qualification only to the bound independent auditor", async () => {
    const contract = await HarnessAdapter.bind(task("judge-route"))
    const app = HarnessRoutes()
    const response = await app.request("/evaluators/qualifications", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: contract.sessionID, auditorToken: auditor, cases: cases() }),
    })
    expect(response.status).toBe(200)
    const receipt = (await response.json()) as HarnessJudge.Receipt
    receipts.add(receipt.receiptID)

    const denied = await app.request(`/evaluators/qualifications/${receipt.receiptID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: contract.sessionID, auditorToken: evaluator }),
    })
    expect(denied.status).not.toBe(200)

    const read = await app.request(`/evaluators/qualifications/${receipt.receiptID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: contract.sessionID, auditorToken: auditor }),
    })
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({ receiptID: receipt.receiptID, status: "passed" })
  })
})

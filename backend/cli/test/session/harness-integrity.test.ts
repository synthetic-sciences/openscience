import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { HarnessRoutes } from "../../src/server/routes/harness"
import { HarnessAdapter } from "../../src/session/harness/adapter"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessDomain } from "../../src/session/harness/domain"
import { HarnessIntegrity } from "../../src/session/harness/integrity"
import { HarnessReport } from "../../src/session/harness/report"
import { HarnessSearch } from "../../src/session/harness/search"

const sessions = new Set<string>()
const token = "integrity-evaluator-capability-token-00000000000000000"
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")

afterEach(async () => {
  await Promise.all(
    [...sessions].flatMap((sessionID) =>
      ["bindings", "contracts", "evaluations", "integrity", "reports", "search"].map((name) =>
        fs.rm(path.join(Global.Path.data, "harness", name, `${encodeURIComponent(sessionID)}.json`), { force: true }),
      ),
    ),
  )
  await fs.rm(path.join(Global.Path.data, "harness", "retrospectives"), { recursive: true, force: true })
  sessions.clear()
})

function protocol() {
  return HarnessContract.Integrity.parse({
    protocolVersion: "benchmark-integrity-v1",
    validatorSHA256: hash("verify-benchmark-integrity.py:v1"),
    traceSchemaSHA256: hash("normalized-trace-schema:v1"),
    minEvents: 4,
    minCoverage: 0.95,
    assignedModel: {
      name: "assigned-base-model",
      baseArtifactSHA256: hash("assigned-base-weights"),
      configSHA256: hash("assigned-base-config"),
    },
    forbiddenModelArtifacts: [hash("forbidden-instruct-model")],
    policy: {
      testItemDerivation: "forbidden",
      unapprovedExternalModels: "forbidden",
      benchmarkLookup: "forbidden",
    },
    auditors: HarnessContract.IntegrityAuditKind.options.map((kind) => ({
      kind,
      name: `${kind}-auditor`,
      version: "2026.08",
      promptSHA256: hash(`${kind}-prompt:v1`),
    })),
    hiddenCanaryManifestSHA256: hash("hidden-canaries:v1"),
    minHiddenCanaries: 2,
  })
}

function task(sessionID: string): HarnessAdapter.Task {
  sessions.add(sessionID)
  return HarnessAdapter.Task.parse({
    schemaVersion: 1,
    runID: `run-${sessionID}`,
    sessionID,
    benchmark: "mle",
    version: "2026.08",
    taskID: "integrity-task-1",
    split: "validation",
    evaluator: { name: "official-integrity-evaluator", version: "5", source: "benchmark", token },
    objective: "Improve the benchmark while proving the execution obeyed its hidden-data and model-use policy",
    integrity: protocol(),
    metric: { name: "score", direction: "maximize" },
    model: { provider: "test", name: "research-agent" },
    tools: ["read", "bash"],
    skills: [],
    budget: { steps: 30, candidates: 2 },
    seed: 41,
    intervention: "autonomous",
    contamination: { policy: "specific test items cannot inform training data", hiddenTestsAccessible: false },
    createdAt: Date.now(),
  })
}

function submit(contract: HarnessContract.Info, subject?: HarnessIntegrity.Submit["subject"]) {
  const integrity = contract.integrity
  if (!integrity) throw new Error("Expected a runtime integrity protocol")
  return HarnessIntegrity.Submit.parse({
    schemaVersion: 1,
    runID: contract.runID,
    sessionID: contract.sessionID,
    evaluatorToken: token,
    protocol: integrity,
    subject: subject ?? {
      type: "run",
      id: contract.runID,
      artifact: { uri: "artifact:run-output", sha256: hash("run-output") },
    },
    trace: {
      artifact: { uri: "artifact:normalized-trace.jsonl", sha256: hash("normalized-trace") },
      schemaSHA256: integrity.traceSchemaSHA256,
      events: 100,
      dropped: 0,
      startedAt: contract.createdAt + 1,
      endedAt: contract.createdAt + 2,
    },
    model: {
      name: integrity.assignedModel.name,
      baseArtifactSHA256: integrity.assignedModel.baseArtifactSHA256,
      configSHA256: integrity.assignedModel.configSHA256,
      outputArtifactSHA256: hash("fine-tuned-output"),
      lineageVerified: true,
    },
    audits: integrity.auditors.map((auditor) => ({
      ...auditor,
      decision: "clean" as const,
      confidence: 0.99,
      evidence: [`artifact:${auditor.kind}-audit.json`],
    })),
    activity: {
      unapprovedExternalModelCalls: 0,
      benchmarkLookupEvents: 0,
      hiddenCanaryManifestSHA256: integrity.hiddenCanaryManifestSHA256,
      hiddenCanariesTested: 3,
      hiddenCanaryViolations: 0,
    },
    validator: {
      name: "verify-benchmark-integrity",
      version: 1,
      scriptSHA256: integrity.validatorSHA256,
    },
    evidence: ["artifact:integrity-report.json"],
    evaluatedAt: contract.createdAt + 3,
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
    integrityReceiptID: receiptID,
    status: "passed",
    score: 0.84,
    metrics: { score: 0.84 },
    checks: checks(contract),
    evidence: ["official:score.json"],
    evaluatedAt: contract.createdAt + 4,
  })
}

describe("trace-backed benchmark runtime integrity", () => {
  test("gates final success on a subject-matched, backend-derived passing receipt", async () => {
    const contract = await HarnessAdapter.bind(task("integrity-gate"))
    await expect(HarnessAdapter.ingest(evaluation(contract))).rejects.toThrow("must reference")

    const receipt = await HarnessIntegrity.record(submit(contract), contract)
    expect(receipt).toMatchObject({
      status: "passed",
      traceCoverage: 1,
      checks: {
        traceCompleteness: true,
        modelIdentity: true,
        testItemContamination: true,
        externalModelUse: true,
        benchmarkLookup: true,
        hiddenCanary: true,
      },
      failures: [],
    })
    expect(JSON.stringify(receipt)).not.toContain(token)
    expect((await HarnessIntegrity.record(submit(contract), contract)).receiptID).toBe(receipt.receiptID)

    const result = await HarnessAdapter.ingest(evaluation(contract, receipt.receiptID))
    expect(result.evaluation).toMatchObject({ status: "passed", integrityReceiptID: receipt.receiptID })
    const report = HarnessReport.compile({ contract, evaluations: [result.evaluation] })
    expect(report.quality.integrityReceiptID).toBe(receipt.receiptID)
    const changed = HarnessContract.Info.parse({
      ...contract,
      integrity: { ...contract.integrity!, minCoverage: 0.99 },
    })
    expect(HarnessReport.compile({ contract: changed, evaluations: [] }).comparisonKey).not.toBe(report.comparisonKey)
  })

  test("derives every integrity failure instead of accepting a candidate verdict", async () => {
    const contract = await HarnessAdapter.bind(task("integrity-failures"))
    const input = submit(contract)
    const receipt = await HarnessIntegrity.record(
      {
        ...input,
        trace: { ...input.trace, schemaSHA256: hash("substituted-schema"), events: 1, dropped: 3 },
        model: {
          ...input.model,
          name: "substituted-model",
          baseArtifactSHA256: hash("substituted-base"),
          configSHA256: hash("substituted-config"),
          outputArtifactSHA256: contract.integrity!.forbiddenModelArtifacts[0]!,
          lineageVerified: false,
        },
        audits: input.audits.map((audit) => ({ ...audit, decision: "flagged" as const })),
        activity: {
          unapprovedExternalModelCalls: 2,
          benchmarkLookupEvents: 1,
          hiddenCanaryManifestSHA256: hash("substituted-canaries"),
          hiddenCanariesTested: 1,
          hiddenCanaryViolations: 1,
        },
      },
      contract,
    )
    expect(receipt.status).toBe("failed")
    expect(receipt.traceCoverage).toBe(0.25)
    expect(receipt.failures.toSorted()).toEqual(HarnessIntegrity.Failure.options.toSorted())
    expect(Object.values(receipt.checks).every((value) => !value)).toBe(true)
    await expect(HarnessAdapter.ingest(evaluation(contract, receipt.receiptID))).rejects.toThrow(
      "requires a passing runtime integrity receipt",
    )
  })

  test("rejects validator, protocol, auditor, and temporal substitution", async () => {
    const contract = await HarnessAdapter.bind(task("integrity-substitution"))
    const input = submit(contract)
    await expect(
      HarnessIntegrity.record(
        { ...input, validator: { ...input.validator, scriptSHA256: hash("substituted-validator") } },
        contract,
      ),
    ).rejects.toThrow("validator does not match")
    await expect(
      HarnessIntegrity.record({ ...input, protocol: { ...input.protocol, minCoverage: 0.9 } }, contract),
    ).rejects.toThrow("immutable harness contract")
    await expect(
      HarnessIntegrity.record(
        {
          ...input,
          audits: input.audits.map((audit) =>
            audit.kind === "benchmark_lookup" ? { ...audit, name: "substituted-auditor" } : audit,
          ),
        },
        contract,
      ),
    ).rejects.toThrow("auditors do not match")
    await expect(HarnessIntegrity.record({ ...input, evaluatedAt: input.trace.endedAt - 1 }, contract)).rejects.toThrow(
      "predates the trace end",
    )
    expect(() =>
      HarnessContract.Integrity.parse({
        ...protocol(),
        auditors: protocol().auditors.map((auditor) => ({
          ...auditor,
          name: "one-auditor",
          version: "one-version",
          promptSHA256: hash("one-prompt"),
        })),
      }),
    ).toThrow("identities must be distinct")
    await expect(
      HarnessAdapter.bind({
        ...task("integrity-score-evaluator-reuse"),
        integrity: {
          ...protocol(),
          auditors: protocol().auditors.map((auditor, index) =>
            index ? auditor : { ...auditor, name: "official-integrity-evaluator", version: "5" },
          ),
        },
      }),
    ).rejects.toThrow("distinct from the score evaluator")
    expect(await HarnessIntegrity.list(contract.sessionID)).toEqual([])
  })

  test("binds candidate receipts to exact artifacts and prevents cross-subject reuse", async () => {
    const contract = await HarnessAdapter.bind(task("integrity-candidate"))
    await HarnessSearch.initialize({ sessionID: contract.sessionID, candidates: 2 })
    const added = await HarnessSearch.add({
      sessionID: contract.sessionID,
      parentIDs: [],
      branch: "lineage-safe",
      proposal: "Use only the assigned base model and public training corpus",
      artifact: { uri: "artifact:candidate", sha256: hash("candidate") },
    })
    const subject = {
      type: "candidate" as const,
      id: added.id,
      artifact: added.state.candidates[added.id]!.artifact,
    }
    await expect(
      HarnessIntegrity.record(
        {
          ...submit(contract, subject),
          subject: { ...subject, artifact: { ...subject.artifact, sha256: hash("other-candidate") } },
        },
        contract,
      ),
    ).rejects.toThrow("does not match the candidate artifact")

    const run = await HarnessIntegrity.record(submit(contract), contract)
    await expect(HarnessAdapter.ingest(evaluation(contract, run.receiptID, added.id))).rejects.toThrow(
      "does not match the evaluated subject",
    )
    const receipt = await HarnessIntegrity.record(submit(contract, subject), contract)
    const result = await HarnessAdapter.ingest(evaluation(contract, receipt.receiptID, added.id))
    expect(result.search?.bestID).toBe(added.id)
  })

  test("protects route access and fails closed when journal outcomes are edited", async () => {
    const contract = await HarnessAdapter.bind(task("integrity-route"))
    const app = HarnessRoutes()
    const recorded = await app.request("/integrity/receipts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(submit(contract)),
    })
    expect(recorded.status).toBe(200)
    const receipt = (await recorded.json()) as HarnessIntegrity.Info

    const denied = await app.request(`/integrity/receipts/${receipt.receiptID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: contract.sessionID, evaluatorToken: "x".repeat(48) }),
    })
    expect(denied.status).not.toBe(200)
    const read = await app.request(`/integrity/receipts/${receipt.receiptID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: contract.sessionID, evaluatorToken: token }),
    })
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({ receiptID: receipt.receiptID, status: "passed" })

    const target = path.join(Global.Path.data, "harness", "integrity", `${encodeURIComponent(contract.sessionID)}.json`)
    const state = (await Bun.file(target).json()) as { items: Record<string, HarnessIntegrity.Info> }
    state.items[receipt.receiptID]!.status = "failed"
    await Bun.write(target, JSON.stringify(state))
    await expect(HarnessIntegrity.list(contract.sessionID)).rejects.toThrow("content hash is invalid")
  })
})

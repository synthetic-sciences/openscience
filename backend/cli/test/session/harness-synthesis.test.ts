import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { HarnessRoutes } from "../../src/server/routes/harness"
import { HarnessAdapter } from "../../src/session/harness/adapter"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessDomain } from "../../src/session/harness/domain"
import { HarnessJudge } from "../../src/session/harness/judge"
import { HarnessSynthesis } from "../../src/session/harness/synthesis"

const sessions = new Set<string>()
const judgeReceipts = new Set<string>()
const evaluator = "scientific-synthesis-evaluator-token-000000000000000"
const auditor = "scientific-synthesis-auditor-token-00000000000000000"
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")
const digest = (value: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex")

const identity = (name: string) => ({
  name,
  version: "1",
  promptSHA256: hash(`${name}-prompt`),
  configSHA256: hash(`${name}-config`),
})

function cases(): HarnessJudge.Case[] {
  return [
    ...[1, 2].map((index) => ({
      id: `clean-${index}`,
      commitment: hash(`clean-${index}`),
      kind: "clean" as const,
      decision: "accept" as const,
      failureProbability: 0.05,
      evidence: [`evidence://clean-${index}`],
    })),
    ...(["wrong_answer", "unsupported_claim", "data_leakage"] as const).flatMap((fault) =>
      [1, 2].map((index) => ({
        id: `${fault}-${index}`,
        commitment: hash(`${fault}-${index}`),
        kind: "fault" as const,
        fault,
        decision: "reject" as const,
        failureProbability: 0.95,
        evidence: [`evidence://${fault}-${index}`],
      })),
    ),
  ]
}

function audit() {
  return HarnessContract.EvaluatorAudit.parse({
    protocolVersion: "evaluator-audit-v1",
    auditor: { name: "independent-synthesis-auditor", version: "1", source: "external" },
    suite: {
      name: "scientific-synthesis-fault-suite",
      version: "1",
      commitmentSHA256: HarnessJudge.commitment(cases()),
    },
    minCleanCases: 2,
    minCasesPerFault: 2,
    requiredFaults: ["wrong_answer", "unsupported_claim", "data_leakage"],
    minSensitivity: 0.9,
    minSpecificity: 0.9,
    minBalancedAccuracy: 0.9,
    minFaultRecall: 0.9,
    maxBrierScore: 0.1,
  })
}

const reference = (): HarnessSynthesis.ReferenceFact[] => [
  { id: "r1", commitment: hash("salted-reference-one"), coverage: "covered", evidence: ["judge://recall-r1"] },
  { id: "r2", commitment: hash("salted-reference-two"), coverage: "missed", evidence: ["judge://recall-r2"] },
]

function protocol(facts = reference()) {
  return HarnessContract.ScientificSynthesis.parse({
    protocolVersion: "scientific-synthesis-v1",
    querySHA256: hash("public-question"),
    referenceSHA256: hash("salted-hidden-reference"),
    referenceFactsSHA256: HarnessSynthesis.referenceManifest(facts),
    referenceFactCount: facts.length,
    cutoff: "2026-01-01",
    tools: ["google_search", "paper_search", "web_browse"],
    traceSchemaSHA256: hash("tool-trace-schema"),
    filterPolicySHA256: hash("clean-room-filter-policy"),
    maxToolEvents: 8,
    decomposer: identity("decomposer"),
    judges: { precision: identity("precision-judge"), recall: identity("recall-judge") },
    minGeneratedFacts: 2,
    minPrecision: 0.4,
    minRecall: 0.5,
    minF1: 0.45,
    cleanRoomRequired: true,
    judgeFailurePolicy: "inconclusive",
  })
}

function task(sessionID: string, synthesis = protocol()): HarnessAdapter.Task {
  sessions.add(sessionID)
  return HarnessAdapter.Task.parse({
    schemaVersion: 1,
    runID: `run-${sessionID}`,
    sessionID,
    benchmark: "statistics",
    version: "2026.08",
    taskID: "scientific-synthesis",
    split: "validation",
    evaluator: { name: "official-synthesis-evaluator", version: "1", source: "benchmark", token: evaluator },
    evaluatorAudit: { protocol: audit(), token: auditor },
    synthesis,
    objective: "Synthesize a correct and comprehensive scientific conclusion without retrieving the answer key",
    metric: { name: "factual_f1", direction: "maximize", target: 0.45 },
    model: { provider: "test", name: "research-agent" },
    tools: ["google_search", "paper_search", "web_browse"],
    skills: [{ name: "run-clean-room-synthesis" }],
    budget: { steps: 40 },
    seed: 31,
    intervention: "autonomous",
    contamination: {
      policy: "reference review and derivative post-cutoff content remain evaluator-private",
      hiddenTestsAccessible: false,
      publicDataCutoff: "2026-01-01",
    },
    createdAt: Date.now(),
  })
}

const generated = (): HarnessSynthesis.GeneratedFact[] => [
  { id: "g1", commitment: hash("generated-one"), verdict: "supported", evidence: ["judge://precision-g1"] },
  { id: "g2", commitment: hash("generated-two"), verdict: "supported", evidence: ["judge://precision-g2"] },
  {
    id: "g3",
    commitment: hash("generated-three"),
    verdict: "contradicted",
    evidence: ["judge://precision-g3"],
  },
]

const trace = () => [
  {
    sequence: 1,
    tool: "google_search" as const,
    requestSHA256: hash("request-one"),
    responseSHA256: hash("response-one"),
    sourceSHA256: hash("source-one"),
    publishedAt: "2025-06-01",
    matches: { forbiddenDomain: false, referenceTitle: false },
    decision: "allowed" as const,
    evidence: ["trace://search-one"],
  },
  {
    sequence: 2,
    tool: "paper_search" as const,
    requestSHA256: hash("request-two"),
    responseSHA256: hash("response-two"),
    sourceSHA256: hash("source-two"),
    publishedAt: "2026-02-01",
    matches: { forbiddenDomain: false, referenceTitle: false },
    decision: "blocked" as const,
    evidence: ["trace://paper-two"],
  },
]

async function qualify(contract: HarnessContract.Info) {
  const receipt = await HarnessJudge.record(
    { sessionID: contract.sessionID, auditorToken: auditor, cases: cases() },
    await HarnessAdapter.authorizeAuditor(contract.sessionID, auditor),
  )
  judgeReceipts.add(receipt.receiptID)
  return receipt
}

function submit(
  contract: HarnessContract.Info,
  qualification: HarnessJudge.Receipt,
  values: Partial<HarnessSynthesis.Submit> = {},
): HarnessSynthesis.Submit {
  if (!contract.synthesis) throw new Error("Expected synthesis protocol")
  return HarnessSynthesis.Submit.parse({
    sessionID: contract.sessionID,
    evaluatorToken: evaluator,
    subject: { type: "run", id: contract.runID },
    conclusionSHA256: hash("candidate-conclusion"),
    evaluatorAuditReceiptID: qualification.receiptID,
    trace: {
      owner: "evaluator_runtime",
      complete: true,
      schemaSHA256: contract.synthesis.traceSchemaSHA256,
      filterPolicySHA256: contract.synthesis.filterPolicySHA256,
      events: trace(),
    },
    decomposition: {
      status: "passed",
      outputSHA256: hash("atomic-decomposition"),
      evidence: ["decomposition://report"],
    },
    generatedFacts: generated(),
    referenceFacts: reference(),
    evaluatedAt: Math.max(Date.now(), contract.createdAt),
    ...values,
  })
}

const checks = (contract: HarnessContract.Info) =>
  HarnessDomain.compose(contract.packs ?? []).map((check) => ({
    id: check.id,
    status: "passed" as const,
    blocking: check.severity === "blocking",
    evidence: [`evidence://${check.id}`],
  }))

function evaluation(
  contract: HarnessContract.Info,
  qualification: HarnessJudge.Receipt,
  receipt?: HarnessSynthesis.Receipt,
  score = receipt?.metrics.f1,
) {
  return HarnessAdapter.Evaluation.parse({
    schemaVersion: 1,
    runID: contract.runID,
    sessionID: contract.sessionID,
    evaluatorToken: evaluator,
    evaluatorAuditReceiptID: qualification.receiptID,
    synthesisReceiptID: receipt?.receiptID,
    status: "passed",
    score,
    metrics: { factual_f1: score ?? 0 },
    checks: checks(contract),
    evidence: ["official://scientific-synthesis-result"],
    evaluatedAt: Math.max(Date.now(), receipt?.evaluatedAt ?? contract.createdAt),
  })
}

afterEach(async () => {
  await Promise.all(
    [...sessions].flatMap((sessionID) => [
      ...["bindings", "contracts", "evaluations", "reports"].map((name) =>
        fs.rm(path.join(Global.Path.data, "harness", name, `${encodeURIComponent(sessionID)}.json`), { force: true }),
      ),
      fs.rm(path.join(Global.Path.data, "harness", "syntheses", "subjects", encodeURIComponent(sessionID)), {
        recursive: true,
        force: true,
      }),
    ]),
  )
  await Promise.all(
    [...judgeReceipts].map((receiptID) =>
      fs.rm(path.join(Global.Path.data, "harness", "judges", `${receiptID}.json`), { force: true }),
    ),
  )
  const receipts = await fs
    .readdir(path.join(Global.Path.data, "harness", "syntheses", "receipts"), { withFileTypes: true })
    .catch(() => [])
  await Promise.all(
    receipts.flatMap((entry) => {
      if (!entry.isFile() || !entry.name.endsWith(".json")) return []
      const file = path.join(Global.Path.data, "harness", "syntheses", "receipts", entry.name)
      return [
        Bun.file(file)
          .json()
          .then((value) => (sessions.has(value.sessionID) ? fs.rm(file, { force: true }) : undefined))
          .catch(() => undefined),
      ]
    }),
  )
  sessions.clear()
  judgeReceipts.clear()
})

describe("clean-room atomic scientific synthesis", () => {
  test("requires a qualified factuality/leakage evaluator and a compatible benchmark objective", async () => {
    const valid = task("synthesis-contract")
    const missing = HarnessAdapter.Task.parse({ ...valid, evaluatorAudit: undefined })
    await expect(HarnessAdapter.bind(missing)).rejects.toThrow("evaluator qualification")
    const metric = HarnessAdapter.Task.parse({ ...valid, metric: { name: "accuracy", direction: "maximize" } })
    await expect(HarnessAdapter.bind(metric)).rejects.toThrow("factual_f1")
    const tools = HarnessAdapter.Task.parse({ ...valid, tools: ["paper_search"] })
    await expect(HarnessAdapter.bind(tools)).rejects.toThrow("run tool allowlist")
    const faults = HarnessAdapter.Task.parse({
      ...valid,
      evaluatorAudit: {
        ...valid.evaluatorAudit!,
        protocol: { ...valid.evaluatorAudit!.protocol, requiredFaults: ["wrong_answer", "data_leakage"] },
      },
    })
    await expect(HarnessAdapter.bind(faults)).rejects.toThrow("unsupported claims")
    const config = protocol()
    expect(() =>
      HarnessContract.ScientificSynthesis.parse({
        ...config,
        judges: {
          ...config.judges,
          precision: {
            ...config.decomposer,
            name: "relabeled-decomposer",
            configSHA256: hash("different-config"),
          },
        },
      }),
    ).toThrow("distinct prompt commitments")
    expect(
      HarnessContract.ScientificSynthesis.parse({
        ...config,
        minPrecision: 0.2,
        minRecall: 0.2,
        minF1: 0.9,
      }).minF1,
    ).toBe(0.9)
  })

  test("derives clean-room decisions and exact factual precision, recall, and F1", async () => {
    const contract = await HarnessAdapter.bind(task("synthesis-pass"))
    const qualification = await qualify(contract)
    const policy = HarnessSynthesis.prompt(contract)
    expect(policy).toContain("2026-01-01")
    expect(policy).toContain("precision>=0.4, recall>=0.5, F1>=0.45")
    expect(policy).not.toContain(contract.synthesis!.referenceSHA256)
    expect(policy).not.toContain(contract.synthesis!.referenceFactsSHA256)
    const receipt = await HarnessSynthesis.record(submit(contract, qualification), contract)
    expect(receipt).toMatchObject({
      status: "passed",
      metrics: {
        toolEvents: 2,
        allowedSources: 1,
        blockedSources: 1,
        generatedFacts: 3,
        supported: 2,
        contradicted: 1,
        referenceFacts: 2,
        covered: 1,
        missed: 1,
        precisionJudgeErrors: 0,
        recallJudgeErrors: 0,
      },
    })
    expect(receipt.metrics.violations.post_cutoff).toBe(1)
    expect(receipt.metrics.precision).toBeCloseTo(4 / 9, 12)
    expect(receipt.metrics.recall).toBe(0.5)
    expect(receipt.metrics.f1).toBeCloseTo(8 / 17, 12)
    expect(JSON.stringify(receipt)).not.toContain(evaluator)
    expect(JSON.stringify(receipt)).not.toContain(auditor)

    await expect(
      HarnessAdapter.ingest(evaluation(contract, qualification, undefined, receipt.metrics.f1)),
    ).rejects.toThrow("scientific synthesis receipt")
    await expect(
      HarnessAdapter.ingest(evaluation(contract, qualification, receipt, receipt.metrics.f1! + 0.01)),
    ).rejects.toThrow("backend-derived factual F1")
    const result = await HarnessAdapter.ingest(evaluation(contract, qualification, receipt))
    expect(result.evaluation).toMatchObject({
      score: receipt.metrics.f1,
      synthesisReceiptID: receipt.receiptID,
    })
  })

  test("rejects hidden-fact substitution, trace laundering, and receipt cherry-picking", async () => {
    const contract = await HarnessAdapter.bind(task("synthesis-tamper"))
    const qualification = await qualify(contract)
    await expect(
      HarnessSynthesis.record(
        submit(contract, qualification, { subject: { type: "candidate", id: "not-created" } }),
        contract,
      ),
    ).rejects.toThrow("candidate does not exist")
    await expect(
      HarnessSynthesis.record(submit(contract, qualification, { evaluatedAt: Date.now() + 60_000 }), contract),
    ).rejects.toThrow("subject interval")
    const changed = reference()
    changed[0] = { ...changed[0]!, commitment: hash("substituted-hidden-fact") }
    await expect(
      HarnessSynthesis.record(submit(contract, qualification, { referenceFacts: changed }), contract),
    ).rejects.toThrow("hidden manifest commitment")

    const laundered: HarnessSynthesis.Submit["trace"]["events"] = trace()
    laundered[1] = { ...laundered[1]!, decision: "allowed" }
    await expect(
      HarnessSynthesis.record(
        submit(contract, qualification, {
          trace: { ...submit(contract, qualification).trace, events: laundered },
        }),
        contract,
      ),
    ).rejects.toThrow("backend-derived clean-room decision")

    const receipt = await HarnessSynthesis.record(submit(contract, qualification), contract)
    await expect(
      HarnessSynthesis.record(
        submit(contract, qualification, { conclusionSHA256: hash("different-conclusion") }),
        contract,
      ),
    ).rejects.toThrow("canonical receipt")
  })

  test("keeps judge failures inconclusive instead of scoring them as unsupported", async () => {
    const contract = await HarnessAdapter.bind(task("synthesis-judge-error"))
    const qualification = await qualify(contract)
    const facts = generated()
    facts[1] = { ...facts[1]!, verdict: "judge_error", evidence: ["judge://provider-error"] }
    const receipt = await HarnessSynthesis.record(submit(contract, qualification, { generatedFacts: facts }), contract)
    expect(receipt.status).toBe("inconclusive")
    expect(receipt.metrics.precisionJudgeErrors).toBe(1)
    expect(receipt.metrics.precision).toBeUndefined()
    expect(receipt.metrics.f1).toBeUndefined()
    expect(receipt.metrics.unsupported).toBe(0)
    await expect(HarnessAdapter.ingest(evaluation(contract, qualification, receipt, 0))).rejects.toThrow(
      "passing scientific synthesis receipt",
    )
  })

  test("exposes canonical receipts only through the evaluator capability and fails closed on disk tampering", async () => {
    const contract = await HarnessAdapter.bind(task("synthesis-route"))
    const qualification = await qualify(contract)
    const app = HarnessRoutes()
    const response = await app.request("/syntheses/receipts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(submit(contract, qualification)),
    })
    expect(response.status).toBe(200)
    const receipt = HarnessSynthesis.Receipt.parse(await response.json())
    const read = await app.request(`/syntheses/receipts/${receipt.receiptID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: contract.sessionID, evaluatorToken: evaluator }),
    })
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({ receiptID: receipt.receiptID })

    const target = path.join(Global.Path.data, "harness", "syntheses", "receipts", `${receipt.receiptID}.json`)
    await Bun.write(target, JSON.stringify({ ...receipt, status: "failed" }))
    expect(await HarnessSynthesis.readReceipt(receipt.receiptID)).toBeNull()

    const forged = structuredClone(receipt) as HarnessSynthesis.Receipt
    forged.metrics.supported += 1
    const stable = structuredClone(forged) as Record<string, unknown>
    delete stable.receiptID
    delete stable.recordedAt
    forged.receiptID = digest(stable)
    const receiptFile = path.join(Global.Path.data, "harness", "syntheses", "receipts", `${forged.receiptID}.json`)
    const subjectFile = path.join(
      Global.Path.data,
      "harness",
      "syntheses",
      "subjects",
      encodeURIComponent(contract.sessionID),
      `${encodeURIComponent(`run:${contract.runID}`)}.json`,
    )
    await Promise.all([Bun.write(receiptFile, JSON.stringify(forged)), Bun.write(subjectFile, JSON.stringify(forged))])
    await expect(HarnessSynthesis.read(forged.receiptID, contract)).rejects.toThrow(
      "backend-derived factuality metrics",
    )
  })
})

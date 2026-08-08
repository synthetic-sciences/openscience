import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { HarnessRoutes } from "../../src/server/routes/harness"
import { HarnessAdapter } from "../../src/session/harness/adapter"
import { HarnessClaims } from "../../src/session/harness/claims"
import { HarnessConfirmation } from "../../src/session/harness/confirmation"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessDomain } from "../../src/session/harness/domain"
import { HarnessMemory } from "../../src/session/harness/memory"
import { HarnessReport } from "../../src/session/harness/report"
import { HarnessSearch } from "../../src/session/harness/search"

const sessions = new Set<string>()
const receipts = new Set<string>()
const evaluatorToken = "optimization-evaluator-capability-000000000000"
const confirmationToken = "claim-evaluator-capability-000000000000000000"
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")
const digest = (value: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex")

afterEach(async () => {
  await Promise.all(
    [...sessions].flatMap((sessionID) =>
      ["bindings", "claims", "contracts", "evaluations", "orchestration", "reports", "search"].map((name) =>
        fs.rm(path.join(Global.Path.data, "harness", name, `${encodeURIComponent(sessionID)}.json`), { force: true }),
      ),
    ),
  )
  await Promise.all(
    [...sessions].map((sessionID) =>
      fs.rm(path.join(Global.Path.data, "harness", "verifications", encodeURIComponent(sessionID)), {
        recursive: true,
        force: true,
      }),
    ),
  )
  await Promise.all(
    [...sessions].flatMap((sessionID) => {
      const base = `statistics\0confirmation-v1\0confirmation-${sessionID}\0optimization-evaluator`
      const sealed = hash(JSON.stringify(protocol()))
      return [
        fs.rm(path.join(Global.Path.data, "harness", "confirmations", "sessions", `${digest(sessionID)}.json`), {
          force: true,
        }),
        fs.rm(path.join(Global.Path.data, "harness", "retrospectives", `${hash(`${base}\0${sealed}`)}.json`), {
          force: true,
        }),
      ]
    }),
  )
  await Promise.all(
    [...receipts].map((receiptID) =>
      fs.rm(path.join(Global.Path.data, "harness", "confirmations", `${receiptID}.json`), { force: true }),
    ),
  )
  sessions.clear()
  receipts.clear()
})

function protocol(input: { target?: number; manifestsEqual?: boolean } = {}) {
  return HarnessContract.Confirmation.parse({
    protocolVersion: "sealed-confirmation-v1",
    optimization: {
      split: "validation",
      manifestSHA256: hash("optimization-manifest"),
    },
    claim: {
      taskID: "official-hidden-confirmation",
      split: "held_out",
      manifestSHA256: hash(input.manifestsEqual ? "optimization-manifest" : "claim-manifest"),
      validatorSHA256: hash("claim-validator"),
      environmentSHA256: hash("claim-environment"),
      evaluator: { name: "claim-evaluator", version: "2", source: "benchmark" },
      metric: "score",
      direction: "maximize",
      target: input.target ?? 0.8,
    },
    selection: { rule: "terminal-verified-best-v1", subjects: 1 },
    exposure: { policy: "terminal-receipt-only", searchFeedback: false, memoryCapture: false },
    failurePolicy: "fail-closed",
  })
}

function task(
  sessionID: string,
  input: {
    protocol?: HarnessContract.Confirmation
    split?: HarnessContract.Split
    evaluatorToken?: string
    confirmationToken?: string
  } = {},
) {
  sessions.add(sessionID)
  const confirmation = input.protocol ?? protocol()
  return HarnessAdapter.Task.parse({
    schemaVersion: 1,
    runID: `run-${sessionID}`,
    sessionID,
    benchmark: "statistics",
    version: "confirmation-v1",
    taskID: `confirmation-${sessionID}`,
    split: input.split ?? "validation",
    evaluator: {
      name: "optimization-evaluator",
      version: "1",
      source: "benchmark",
      token: input.evaluatorToken ?? evaluatorToken,
    },
    confirmation: {
      protocol: confirmation,
      token: input.confirmationToken ?? confirmationToken,
    },
    objective: "Optimize on validation, then confirm exactly one terminal winner on untouched hidden data",
    profile: "optimize",
    metric: { name: "score", direction: "maximize", target: confirmation.claim.target },
    model: { provider: "test", name: "model" },
    tools: ["read", "bash"],
    skills: [],
    budget: { steps: 20, candidates: 2 },
    seed: 19,
    intervention: "autonomous",
    contamination: { policy: "claim split remains evaluator-only", hiddenTestsAccessible: false },
    createdAt: Date.now(),
  })
}

function checks(contract: HarnessContract.Info) {
  return HarnessDomain.compose(contract.packs ?? []).map((check) => ({
    id: check.id,
    status: "passed" as const,
    blocking: check.severity === "blocking",
    evidence: [`optimization:${check.id}.json`],
  }))
}

async function finish(sessionID: string, score = 0.9) {
  const contract = await HarnessAdapter.bind(task(sessionID))
  const state = await HarnessSearch.initialize({ sessionID })
  const recommendation = HarnessSearch.recommend(state)
  const added = await HarnessSearch.add({
    sessionID,
    recommendationID: recommendation.id,
    parentIDs: recommendation.parentIDs,
    inspirationIDs: recommendation.inspirationIDs,
    branch: "candidate",
    proposal: "Candidate selected only from optimization-split evidence",
    artifact: { uri: `candidate://${sessionID}`, sha256: hash(`candidate-${sessionID}`) },
  })
  const result = await HarnessAdapter.ingest({
    schemaVersion: 1,
    runID: contract.runID,
    sessionID,
    evaluatorToken,
    candidateID: added.id,
    status: "passed",
    score,
    metrics: { score },
    checks: checks(contract),
    evidence: ["optimization:official-result.json"],
    evaluatedAt: Date.now(),
  })
  const search = await HarnessSearch.read(sessionID)
  expect(search).toMatchObject({ status: "completed", bestID: added.id, stopReason: "objective_met" })
  return { contract, candidate: search.candidates[added.id]!, evaluation: result.evaluation, search }
}

async function submission(
  contract: HarnessContract.Info,
  input: { score?: number; outcome?: "completed" | "failed" | "inconclusive" } = {},
) {
  const selection = await HarnessConfirmation.select(contract)
  const outcome = input.outcome ?? "completed"
  const score = input.score ?? 0.85
  return HarnessConfirmation.Submit.parse({
    schemaVersion: 1,
    sessionID: contract.sessionID,
    confirmationToken,
    candidateSHA256: selection.candidateArtifact.sha256,
    manifestSHA256: contract.confirmation!.claim.manifestSHA256,
    validatorSHA256: contract.confirmation!.claim.validatorSHA256,
    environmentSHA256: contract.confirmation!.claim.environmentSHA256,
    outcome,
    score: outcome === "completed" ? score : undefined,
    metrics: outcome === "completed" ? { score } : {},
    checks: HarnessDomain.compose(contract.packs ?? []).map((check) => ({
      id: check.id,
      status: "passed" as const,
      blocking: check.severity === "blocking",
      evidence: [`claim:${check.id}.json`],
    })),
    evidence: ["claim:result.json"],
    usage: { wallTimeMs: 500, costUSD: 0.02 },
    outputSHA256: hash(`${contract.sessionID}:${outcome}:${score}`),
    evaluatedAt: Math.max(Date.now(), selection.selectedAt),
  })
}

describe("sealed post-search confirmation", () => {
  test("freezes distinct optimization and claim splits, manifests, identities, and capabilities", async () => {
    expect(() => protocol({ manifestsEqual: true })).toThrow("manifests must be distinct")
    expect(() => task("confirmation-token-alias", { confirmationToken: evaluatorToken })).toThrow(
      "capabilities must differ",
    )
    const drift = task("confirmation-split-drift", { split: "development" })
    await expect(HarnessAdapter.bind(drift)).rejects.toThrow("optimization split must match")
    const same = protocol()
    const identity = {
      ...same,
      claim: {
        ...same.claim,
        evaluator: { name: "optimization-evaluator", version: "1", source: "benchmark" as const },
      },
    }
    await expect(HarnessAdapter.bind(task("confirmation-identity-alias", { protocol: identity }))).rejects.toThrow(
      "evaluator identity distinct",
    )
  })

  test("selects only the backend winner after search is terminal and rejects caller substitution", async () => {
    const contract = await HarnessAdapter.bind(task("confirmation-selection"))
    await HarnessSearch.initialize({ sessionID: contract.sessionID })
    await expect(HarnessConfirmation.select(contract)).rejects.toThrow("terminal search")

    const done = await finish("confirmation-selected")
    const selection = await HarnessConfirmation.select(done.contract)
    expect(selection).toMatchObject({
      candidateID: done.candidate.id,
      candidateArtifact: done.candidate.artifact,
      stopReason: "objective_met",
    })
    const input = await submission(done.contract)
    expect(() => HarnessConfirmation.Submit.parse({ ...input, candidateID: hash("other") })).toThrow()
    await expect(
      HarnessConfirmation.record(
        { ...(await submission(done.contract)), candidateSHA256: hash("alternate-candidate") },
        done.contract,
      ),
    ).rejects.toThrow("server-selected candidate artifact")
    await expect(
      HarnessConfirmation.record(
        { ...(await submission(done.contract)), evaluatedAt: selection.selectedAt - 1 },
        done.contract,
      ),
    ).rejects.toThrow("terminal selection interval")
  })

  test("keeps optimization provisional and makes sealed evidence the sole report quality source", async () => {
    const done = await finish("confirmation-report", 0.99)
    const before = HarnessReport.compile({
      contract: done.contract,
      evaluations: [done.evaluation],
      search: done.search,
      generatedAt: Date.now(),
    })
    expect(before.quality).toMatchObject({
      source: "sealed_confirmation",
      provisional: true,
      targetReached: false,
      evaluator: "claim-evaluator",
    })
    expect(before.quality.status).toBeUndefined()
    expect(before.quality.score).toBeUndefined()
    expect(HarnessReport.frontier([before])).toEqual([])
    expect(() => HarnessReport.compare([before], before.runID)).toThrow("Provisional optimization results")

    const search = await HarnessSearch.read(done.contract.sessionID)
    const memory = await HarnessMemory.retrieve({
      sessionID: done.contract.sessionID,
      query: "Candidate selected only from optimization-split evidence",
    })
    const receipt = await HarnessConfirmation.record(await submission(done.contract, { score: 0.85 }), done.contract)
    receipts.add(receipt.receiptID)
    expect(await HarnessSearch.read(done.contract.sessionID)).toEqual(search)
    expect(
      await HarnessMemory.retrieve({
        sessionID: done.contract.sessionID,
        query: "Candidate selected only from optimization-split evidence",
      }),
    ).toEqual(memory)
    expect(JSON.stringify(receipt)).not.toContain(confirmationToken)

    const report = HarnessReport.compile({
      contract: done.contract,
      evaluations: [done.evaluation],
      search: done.search,
      confirmation: receipt,
      generatedAt: Date.now(),
    })
    expect(report.quality).toMatchObject({
      source: "sealed_confirmation",
      provisional: false,
      status: "passed",
      score: 0.85,
      targetReached: true,
      evaluator: "claim-evaluator",
      evaluatorVersion: "2",
      confirmationReceiptID: receipt.receiptID,
    })
    expect(report.quality.score).not.toBe(done.evaluation.score)
  })

  test("freezes one canonical holdout receipt with exact concurrent retry idempotency", async () => {
    const done = await finish("confirmation-single-shot")
    const input = await submission(done.contract)
    const [first, concurrent] = await Promise.all([
      HarnessConfirmation.record(input, done.contract),
      HarnessConfirmation.record(input, done.contract),
    ])
    receipts.add(first.receiptID)
    receipts.add(concurrent.receiptID)
    expect(concurrent.receiptID).toBe(first.receiptID)
    expect((await HarnessConfirmation.record(input, done.contract)).receiptID).toBe(first.receiptID)
    await expect(
      HarnessConfirmation.record({ ...input, outputSHA256: hash("changed-holdout-output") }, done.contract),
    ).rejects.toThrow("holdout retries are forbidden")
  })

  test("derives the final claim verdict instead of trusting a completed evaluator status", async () => {
    const weak = await finish("confirmation-below-target")
    const failed = await HarnessConfirmation.record(await submission(weak.contract, { score: 0.7 }), weak.contract)
    receipts.add(failed.receiptID)
    expect(failed.status).toBe("failed")
    expect(failed.failures).toContainEqual(expect.stringContaining("does not satisfy"))

    const uncertain = await finish("confirmation-inconclusive")
    const inconclusive = await HarnessConfirmation.record(
      await submission(uncertain.contract, { outcome: "inconclusive" }),
      uncertain.contract,
    )
    receipts.add(inconclusive.receiptID)
    expect(inconclusive.status).toBe("inconclusive")
    expect(inconclusive.score).toBeUndefined()
  })

  test("requires every claim-side domain gate before deriving a pass", async () => {
    const done = await finish("confirmation-domain-gates")
    await expect(
      HarnessConfirmation.record(
        {
          ...(await submission(done.contract)),
          checks: [
            {
              id: "official-claim-gate",
              status: "passed",
              blocking: true,
              evidence: ["claim:gate.json"],
            },
          ],
        },
        done.contract,
      ),
    ).rejects.toThrow("Domain verification pack failed")
  })

  test("prevents provisional optimization evidence from supporting a performance claim", async () => {
    const done = await finish("confirmation-claim-ledger")
    const receipt = await HarnessConfirmation.record(await submission(done.contract), done.contract)
    receipts.add(receipt.receiptID)
    const claim = await HarnessClaims.declare({
      sessionID: done.contract.sessionID,
      actor: "producer",
      text: "The terminal candidate clears the official hidden benchmark target",
      kind: "performance",
      importance: "headline",
      subject: done.candidate.artifact,
    })
    const base = {
      schemaVersion: 1 as const,
      runID: done.contract.runID,
      sessionID: done.contract.sessionID,
      claimID: claim.id,
      mode: "heldout_evaluator" as const,
      producer: { actor: "producer", sessionID: done.contract.sessionID },
      verifier: { actor: "claim-evaluator", sessionID: "claim-evaluator-session" },
      isolation: {
        freshProcess: true,
        cleanWorkspace: true,
        outputWithheld: true,
        codeIndependent: false,
        hiddenTestsAccessible: false as const,
      },
      source: {
        uri: `confirmation://${receipt.receiptID}`,
        evaluator: "claim-evaluator",
        sha256: done.candidate.artifact.sha256,
      },
      status: receipt.status,
      summary: "Canonical sealed confirmation result",
      checks: ["held-out", "baseline", "budget"].map((id) => ({
        id,
        status: "passed" as const,
        blocking: true,
        evidence: [`claim:${id}.json`],
      })),
      evidence: [`confirmation:${receipt.receiptID}`],
      metrics: { score: receipt.score! },
      evaluatedAt: Math.max(Date.now(), receipt.recordedAt),
    }
    await expect(
      HarnessClaims.verify({ ...base, source: { ...base.source, evaluator: "optimization-evaluator" } }),
    ).rejects.toThrow("bound benchmark evaluator")
    await expect(HarnessClaims.verify(base)).rejects.toThrow("canonical claim receipt")
    const forged = HarnessClaims.Verification.parse({ ...base, id: digest(base) })
    const folder = path.join(Global.Path.data, "harness", "verifications", encodeURIComponent(done.contract.sessionID))
    await fs.mkdir(folder, { recursive: true })
    await Bun.write(path.join(folder, `${forged.id}.json`), JSON.stringify(forged))
    await expect(HarnessClaims.reconcile(done.contract.sessionID)).rejects.toThrow("canonical claim receipt")
    await fs.rm(path.join(folder, `${forged.id}.json`))
    const verified = await HarnessClaims.verify({
      ...base,
      source: { ...base.source, confirmationReceiptID: receipt.receiptID },
    })
    expect(verified.claim).toMatchObject({ status: "supported", independentSources: 1 })
  })

  test("exposes selection and receipts only through the claim evaluator capability", async () => {
    const done = await finish("confirmation-route")
    const app = HarnessRoutes()
    const denied = await app.request("/confirmations/selection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: done.contract.sessionID, confirmationToken: evaluatorToken }),
    })
    expect(denied.status).not.toBe(200)
    const selected = await app.request("/confirmations/selection", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: done.contract.sessionID, confirmationToken }),
    })
    expect(selected.status).toBe(200)

    const recorded = await app.request("/confirmations/receipts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(await submission(done.contract)),
    })
    expect(recorded.status).toBe(200)
    const receipt = (await recorded.json()) as HarnessConfirmation.Receipt
    receipts.add(receipt.receiptID)
    const hidden = await app.request(`/confirmations/receipts/${receipt.receiptID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: done.contract.sessionID, confirmationToken: evaluatorToken }),
    })
    expect(hidden.status).not.toBe(200)
    const read = await app.request(`/confirmations/receipts/${receipt.receiptID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: done.contract.sessionID, confirmationToken }),
    })
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({ receiptID: receipt.receiptID, status: "passed" })
  })
})

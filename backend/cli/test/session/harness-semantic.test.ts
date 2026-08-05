import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { HarnessRoutes } from "../../src/server/routes/harness"
import { HarnessAdapter } from "../../src/session/harness/adapter"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessDomain } from "../../src/session/harness/domain"
import { HarnessOrchestrator } from "../../src/session/harness/orchestrator"
import { HarnessReport } from "../../src/session/harness/report"
import { HarnessSearch } from "../../src/session/harness/search"
import { HarnessSemantic } from "../../src/session/harness/semantic"

const sessions = new Set<string>()
const receipts = new Set<string>()
const evaluator = "semantic-evaluator-capability-token-0000000000000000"
const reviewer = "semantic-reviewer-capability-token-00000000000000000"
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")
const digest = (value: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex")
const objective = "Find a non-vacuous new method for the declared scientific problem under the stated constraints"

afterEach(async () => {
  await Promise.all(
    [...sessions].flatMap((sessionID) =>
      ["bindings", "contracts", "evaluations", "orchestration", "reports", "search"].map((name) =>
        fs.rm(path.join(Global.Path.data, "harness", name, `${encodeURIComponent(sessionID)}.json`), { force: true }),
      ),
    ),
  )
  await Promise.all(
    [...receipts].map((receiptID) =>
      fs.rm(path.join(Global.Path.data, "harness", "semantics", `${receiptID}.json`), { force: true }),
    ),
  )
  sessions.clear()
  receipts.clear()
})

function protocol(input = objective) {
  return HarnessContract.SemanticAudit.parse({
    protocolVersion: "semantic-audit-v1",
    reviewer: { name: "independent-domain-panel", version: "2026.08", source: "external" },
    scope: {
      objectiveSHA256: hash(input),
      criteria: [
        { id: "target", requirement: "Address the intended target rather than a weaker surrogate." },
        { id: "constraints", requirement: "Respect every stated scientific constraint." },
      ],
      forbiddenShortcuts: [
        { id: "vacuity", description: "Do not satisfy the statement through an empty or trivial interpretation." },
        { id: "lookup", description: "Do not present a known result as a new result." },
      ],
      literature: { cutoff: "2026-08-01", corpusSHA256: hash("frozen-literature-corpus") },
      noveltyFloor: "minor",
    },
    minReviewers: 2,
    minConfidence: 0.8,
  })
}

function task(sessionID: string): HarnessAdapter.Task {
  sessions.add(sessionID)
  return HarnessAdapter.Task.parse({
    schemaVersion: 1,
    runID: `run-${sessionID}`,
    sessionID,
    benchmark: "statistics",
    version: "2026.08",
    taskID: "semantic-intent-task",
    split: "validation",
    evaluator: {
      name: "official-scientific-evaluator",
      version: "4",
      source: "benchmark",
      token: evaluator,
    },
    semanticAudit: { protocol: protocol(), token: reviewer },
    objective,
    metric: { name: "score", direction: "maximize" },
    model: { provider: "test", name: "model" },
    tools: ["read", "bash"],
    skills: [],
    budget: { steps: 20 },
    seed: 23,
    intervention: "autonomous",
    contamination: { policy: "review corpus and hidden cases remain withheld", hiddenTestsAccessible: false },
    createdAt: Date.now(),
  })
}

function review(
  actor: string,
  sessionID: string,
  overrides: Partial<HarnessSemantic.Review> = {},
): HarnessSemantic.Review {
  return HarnessSemantic.Review.parse({
    actor,
    sessionID,
    correctness: "passed",
    alignment: "intended",
    novelty: "minor",
    vacuous: false,
    confidence: 0.95,
    criteria: [
      { id: "target", status: "passed", evidence: [`artifact:${actor}-target.json`] },
      { id: "constraints", status: "passed", evidence: [`artifact:${actor}-constraints.json`] },
    ],
    shortcuts: [
      { id: "vacuity", observed: false, evidence: [`artifact:${actor}-vacuity.json`] },
      { id: "lookup", observed: false, evidence: [`artifact:${actor}-lookup.json`] },
    ],
    literatureRefs: [`literature:${actor}-search.json`],
    evidence: [`artifact:${actor}-review.json`],
    summary: `${actor} independently found the result correct, intended, substantive, and above the novelty floor.`,
    reviewedAt: Date.now(),
    ...overrides,
  })
}

function panel(overrides: Partial<HarnessSemantic.Review> = {}) {
  return [review("reviewer-a", "semantic-session-a", overrides), review("reviewer-b", "semantic-session-b")]
}

async function audit(contract: HarnessContract.Info, reviews = panel(), subject?: HarnessSemantic.Subject) {
  const receipt = await HarnessSemantic.record(
    {
      sessionID: contract.sessionID,
      reviewerToken: reviewer,
      subject: subject ?? { type: "run", id: contract.runID },
      reviews,
    },
    await HarnessAdapter.authorizeSemantic(contract.sessionID, reviewer),
  )
  receipts.add(receipt.receiptID)
  return receipt
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
    semanticReceiptID: receiptID,
    status: "passed",
    score: 0.91,
    metrics: { score: 0.91 },
    checks,
    evidence: ["official:score.json"],
    evaluatedAt: Date.now(),
  })
}

describe("semantic intent and novelty audit", () => {
  test("injects the complete frozen meaning policy into main and coalition contexts", async () => {
    const contract = await HarnessAdapter.bind(task("semantic-prompt"))
    const prompt = await HarnessSemantic.context(contract.sessionID)
    expect(prompt).toContain("Address the intended target rather than a weaker surrogate.")
    expect(prompt).toContain("Do not satisfy the statement through an empty or trivial interpretation.")
    expect(prompt).toContain("Minimum novelty: minor")
    expect(prompt).not.toContain(reviewer)

    const state = await HarnessOrchestrator.initialize(contract.sessionID)
    const work = HarnessOrchestrator.ready(state)[0]!
    expect(work.prompt).toContain(prompt)
    expect(work.prompt).toContain("Your output is provisional orchestration state")
  })

  test("gates a final result on a meaningful independent review panel", async () => {
    const contract = await HarnessAdapter.bind(task("semantic-pass"))
    await expect(HarnessAdapter.ingest(evaluation(contract))).rejects.toThrow("semantic audit receipt")
    const receipt = await audit(contract)
    expect(receipt).toMatchObject({
      status: "meaningful",
      subject: { type: "run", id: contract.runID },
      reviewer: contract.semanticAudit?.reviewer,
      failures: [],
    })
    expect(receipt.reviews.map((item) => item.actor)).toEqual(["reviewer-a", "reviewer-b"])
    expect(JSON.stringify(receipt)).not.toContain(reviewer)
    expect(JSON.stringify(receipt)).not.toContain(evaluator)

    const result = await HarnessAdapter.ingest(evaluation(contract, receipt.receiptID))
    expect(result.evaluation).toMatchObject({ status: "passed", semanticReceiptID: receipt.receiptID })
    const report = HarnessReport.compile({ contract, evaluations: [result.evaluation], generatedAt: Date.now() })
    expect(report.quality.semanticReceiptID).toBe(receipt.receiptID)
  })

  test("classifies correct loopholes and below-floor rediscoveries as technical only", async () => {
    const cases: Array<[string, Partial<HarnessSemantic.Review>, string]> = [
      ["misinterpreted", { alignment: "misinterpreted" }, "problem_misinterpreted"],
      ["vacuous", { vacuous: true }, "vacuous_solution"],
      ["rediscovered", { novelty: "rediscovery" }, "below_minor"],
      [
        "shortcut",
        {
          shortcuts: [
            { id: "vacuity", observed: true, evidence: ["artifact:vacuity-found.json"] },
            { id: "lookup", observed: false, evidence: ["artifact:lookup-clear.json"] },
          ],
        },
        "shortcut_vacuity_observed",
      ],
    ]
    for (const [name, override, failure] of cases) {
      const contract = await HarnessAdapter.bind(task(`semantic-${name}`))
      const receipt = await audit(contract, panel(override))
      expect(receipt.status).toBe("technical_only")
      expect(receipt.failures).toContainEqual(expect.stringContaining(failure))
      await expect(HarnessAdapter.ingest(evaluation(contract, receipt.receiptID))).rejects.toThrow(
        "meaningful semantic audit receipt",
      )
    }

    const input = task("semantic-not-required-novelty")
    const current = input.semanticAudit!.protocol
    const contract = await HarnessAdapter.bind({
      ...input,
      semanticAudit: {
        token: reviewer,
        protocol: { ...current, scope: { ...current.scope, noveltyFloor: "known" } },
      },
    })
    const receipt = await audit(contract, panel({ novelty: "not_required" }))
    expect(receipt.status).toBe("technical_only")
    expect(receipt.failures).toContainEqual(expect.stringContaining("not_required_below_known"))
  })

  test("preserves uncertainty and incorrectness as distinct backend outcomes", async () => {
    const ambiguous = await HarnessAdapter.bind(task("semantic-ambiguous"))
    const uncertain = await audit(ambiguous, panel({ confidence: 0.7 }))
    expect(uncertain.status).toBe("ambiguous")
    expect(uncertain.failures).toContain("reviewer-a:low_confidence")

    const incorrect = await HarnessAdapter.bind(task("semantic-incorrect"))
    const failed = await audit(incorrect, panel({ correctness: "failed" }))
    expect(failed.status).toBe("failed")
    expect(failed.failures).toContain("reviewer-a:correctness_failed")
  })

  test("requires complete frozen checks and distinct reviewer identities", async () => {
    const contract = await HarnessAdapter.bind(task("semantic-panel"))
    const missing = panel()
    missing[0] = { ...missing[0]!, criteria: missing[0]!.criteria.slice(0, 1) }
    await expect(audit(contract, missing)).rejects.toThrow("frozen problem scope")
    await expect(audit(contract, [review("same", "session-a"), review("same", "session-b")])).rejects.toThrow(
      "distinct actors",
    )
    await expect(
      audit(contract, [review("actor-a", "same-session"), review("actor-b", "same-session")]),
    ).rejects.toThrow("distinct sessions")
  })

  test("does not replay a semantic receipt across runs or subjects", async () => {
    const first = await HarnessAdapter.bind(task("semantic-source"))
    const receipt = await audit(first)
    const second = await HarnessAdapter.bind(task("semantic-target"))
    await expect(HarnessAdapter.ingest(evaluation(second, receipt.receiptID))).rejects.toThrow(
      "different harness session",
    )

    await expect(
      HarnessSemantic.assert({
        contract: first,
        receiptID: receipt.receiptID,
        subject: { type: "candidate", id: hash("candidate") },
        evaluatedAt: Date.now(),
        recordedAt: Date.now(),
        requirePassed: true,
      }),
    ).rejects.toThrow(
      "different evaluation subject",
    )
  })

  test("cannot pre-sign a candidate before its immutable search artifact exists", async () => {
    const sessionID = "semantic-candidate-time"
    const contract = await HarnessAdapter.bind({
      ...task(sessionID),
      profile: "optimize",
      budget: { steps: 20, candidates: 2 },
    })
    const missing = { type: "candidate" as const, id: hash("future-candidate") }
    await expect(audit(contract, panel(), missing)).rejects.toThrow("does not exist in the bound search")

    const state = await HarnessSearch.initialize({ sessionID, candidates: 2 })
    const recommendation = HarnessSearch.recommend(state)
    const added = await HarnessSearch.add({
      sessionID,
      recommendationID: recommendation.id,
      parentIDs: recommendation.parentIDs,
      inspirationIDs: recommendation.inspirationIDs,
      branch: "semantic-candidate",
      proposal: "A concrete candidate reviewed only after its artifact exists",
      artifact: { uri: "candidate://semantic-time", sha256: hash("semantic-candidate-artifact") },
    })
    const candidate = (await HarnessSearch.read(sessionID)).candidates[added.id]!
    await expect(
      audit(contract, panel({ reviewedAt: candidate.createdAt - 1 }), { type: "candidate", id: candidate.id }),
    ).rejects.toThrow("bound subject interval")

    const receipt = await audit(contract, panel(), { type: "candidate", id: candidate.id })
    const result = await HarnessAdapter.ingest({
      ...evaluation(contract, receipt.receiptID),
      candidateID: candidate.id,
    })
    expect(result.evaluation).toMatchObject({
      subject: { type: "candidate", id: candidate.id },
      semanticReceiptID: receipt.receiptID,
      status: "passed",
    })
  })

  test("rejects objective drift, shared capabilities, and receipt tampering", async () => {
    await expect(
      HarnessAdapter.bind({
        ...task("semantic-objective-drift"),
        semanticAudit: { protocol: protocol("different objective"), token: reviewer },
      }),
    ).rejects.toThrow("objective commitment")
    expect(() =>
      HarnessAdapter.Task.parse({
        ...task("semantic-shared-capability"),
        semanticAudit: { protocol: protocol(), token: evaluator },
      }),
    ).toThrow("capabilities must differ")

    const contract = await HarnessAdapter.bind(task("semantic-tamper"))
    const receipt = await audit(contract)
    const target = path.join(Global.Path.data, "harness", "semantics", `${receipt.receiptID}.json`)
    await Bun.write(target, JSON.stringify({ ...receipt, recordedAt: receipt.recordedAt + 1 }))
    expect(await HarnessSemantic.read(receipt.receiptID)).toBeNull()
    await Bun.write(target, JSON.stringify({ ...receipt, status: "technical_only" }))
    expect(await HarnessSemantic.read(receipt.receiptID)).toBeNull()
    await expect(HarnessAdapter.ingest(evaluation(contract, receipt.receiptID))).rejects.toThrow("Unknown or corrupt")
  })

  test("rederives semantic status even after a content-addressed on-disk forgery", async () => {
    const contract = await HarnessAdapter.bind(task("semantic-derived-tamper"))
    const receipt = await audit(contract, panel({ vacuous: true }))
    expect(receipt.status).toBe("technical_only")
    const forged = { ...receipt, status: "meaningful" as const, failures: [] }
    const stable = structuredClone(forged) as Record<string, unknown>
    delete stable.receiptID
    const receiptID = digest(stable)
    receipts.add(receiptID)
    await Bun.write(
      path.join(Global.Path.data, "harness", "semantics", `${receiptID}.json`),
      JSON.stringify({ ...forged, receiptID }),
    )
    expect(await HarnessSemantic.read(receiptID)).not.toBeNull()
    await expect(HarnessAdapter.ingest(evaluation(contract, receiptID))).rejects.toThrow("backend-derived review state")
  })

  test("exposes semantic receipts only to the bound review capability", async () => {
    const contract = await HarnessAdapter.bind(task("semantic-route"))
    const app = HarnessRoutes()
    const response = await app.request("/semantics/receipts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionID: contract.sessionID,
        reviewerToken: reviewer,
        subject: { type: "run", id: contract.runID },
        reviews: panel(),
      }),
    })
    expect(response.status).toBe(200)
    const receipt = (await response.json()) as HarnessSemantic.Receipt
    receipts.add(receipt.receiptID)

    await expect(HarnessAdapter.authorizeSemantic(contract.sessionID, evaluator)).rejects.toThrow("rejected")

    const read = await app.request(`/semantics/receipts/${receipt.receiptID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: contract.sessionID, reviewerToken: reviewer }),
    })
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({ receiptID: receipt.receiptID, status: "meaningful" })
  })
})

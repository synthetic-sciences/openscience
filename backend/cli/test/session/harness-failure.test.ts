import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { HarnessRoutes } from "../../src/server/routes/harness"
import { HarnessAdapter } from "../../src/session/harness/adapter"
import { HarnessAudit } from "../../src/session/harness/audit"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessEvaluation } from "../../src/session/harness/evaluation"
import { HarnessFailure } from "../../src/session/harness/failure"

const sessions = new Set<string>()
const auditReceipts = new Set<string>()
const failureReceipts = new Set<string>()
const token = "topic-aware-failure-evaluator-capability-token-0000000000"
const digest = (value: unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex")

const probes = Array.from(
  { length: 4 },
  (_, index): HarnessAudit.Probe => ({
    id: `probe-${index}`,
    commitment: digest(`hidden-probe-${index}`),
    features: [index - 1.5],
    stratum: index < 2 ? "left" : "right",
    weight: 1,
    priorLoss: 0.5,
  }),
)

const identity = (name: string) => ({
  name,
  version: "1",
  promptSHA256: digest(`${name}-prompt`),
  configSHA256: digest(`${name}-config`),
})

function audit(): HarnessContract.Audit {
  return HarnessContract.Audit.parse({
    mode: "failure",
    budget: 3,
    minSamples: 2,
    noiseVariance: 0.05,
    lengthscale: 0.7,
    beta: 1.96,
    failureThreshold: 0.5,
    tolerance: 0.01,
    maxUncertainty: 0.05,
    estimationWeight: 0.5,
    diversityWeight: 0.2,
    coverageWeight: 0.2,
  })
}

function config(values: Partial<HarnessContract.FailureDiscovery> = {}) {
  return HarnessContract.FailureDiscovery.parse({
    protocolVersion: "topic-aware-failure-v1",
    sourcePoolSHA256: digest(probes),
    topicModel: { kind: "predefined", identity: identity("topic-model") },
    topics: ["alpha", "beta", "gamma"].map((id) => ({ id, commitment: digest(`topic-${id}`) })),
    generator: identity("generator"),
    validators: HarnessContract.FailureValidatorKind.options.map((kind) => ({
      kind,
      identity: identity(`${kind}-validator`),
    })),
    embedding: { identity: identity("embedding-model"), dimensions: 2, regularization: 1e-6 },
    budget: 4,
    anchorsPerAttempt: 2,
    exploration: Math.SQRT2,
    failureThreshold: 0.5,
    ...values,
  })
}

async function bind(sessionID: string, failureDiscovery = config()) {
  sessions.add(sessionID)
  return HarnessAdapter.bind({
    schemaVersion: 1,
    runID: `run-${sessionID}`,
    sessionID,
    benchmark: "statistics",
    version: "2026.08",
    taskID: "topic-aware-failure-discovery",
    split: "validation",
    evaluator: { name: "official-evaluator", version: "1", source: "benchmark", token },
    objective: "Discover diverse validated failures without changing the official score",
    audit: audit(),
    failureDiscovery,
    metric: { name: "loss", direction: "minimize" },
    model: { provider: "test", name: "target-model" },
    tools: [],
    skills: [],
    budget: { steps: 30 },
    seed: 7,
    intervention: "autonomous",
    contamination: { policy: "generated cases stay outside the population estimate", hiddenTestsAccessible: false },
    createdAt: Date.now(),
  })
}

async function source(contract: HarnessContract.Info) {
  const subject = {
    type: "run" as const,
    id: contract.runID,
    artifactSHA256: digest(`${contract.sessionID}-artifact`),
  }
  const state = await HarnessAudit.initialize({
    sessionID: contract.sessionID,
    evaluatorToken: token,
    subject,
    probes,
  })
  for (const index of [0, 1, 2]) {
    const selection = await HarnessAudit.select(state.auditID, {
      sessionID: contract.sessionID,
      evaluatorToken: token,
    })
    await HarnessAudit.observe(state.auditID, {
      sessionID: contract.sessionID,
      evaluatorToken: token,
      probeID: selection.probeID,
      loss: 0.7 + index * 0.1,
      failure: true,
      evidence: [`evidence://audit-failure-${index}`],
    })
  }
  const receipt = await HarnessAudit.seal(state.auditID, {
    sessionID: contract.sessionID,
    evaluatorToken: token,
  })
  auditReceipts.add(receipt.receiptID)
  const stream = await HarnessFailure.initialize({
    sessionID: contract.sessionID,
    evaluatorToken: token,
    subject,
    auditReceiptID: receipt.receiptID,
  })
  return { subject, audit: state, receipt, stream }
}

const validations = (status: "passed" | "failed" | "inconclusive" = "passed") =>
  HarnessContract.FailureValidatorKind.options.map((kind) => ({
    kind,
    status,
    evidence: [`evidence://${kind}`],
  }))

function generated(index: number, embedding: number[] = [1, 0]): HarnessFailure.Generation {
  return {
    status: "generated",
    caseSHA256: digest(`generated-case-${index}`),
    outputSHA256: digest(`generator-output-${index}`),
    embedding,
    evidence: [`evidence://generation-${index}`],
  }
}

function outcome(index: number, failure = true): HarnessFailure.Outcome {
  return {
    loss: failure ? 0.9 : 0.1,
    failure,
    outputSHA256: digest(`target-output-${index}`),
    evidence: [`evidence://target-${index}`],
  }
}

async function record(
  state: HarnessFailure.State,
  index: number,
  options: {
    generation?: HarnessFailure.Generation
    validations?: HarnessFailure.Validation[]
    outcome?: HarnessFailure.Outcome
  } = {},
) {
  const selection = await HarnessFailure.next(state.streamID, {
    sessionID: state.sessionID,
    evaluatorToken: token,
  })
  return HarnessFailure.observe(state.streamID, {
    sessionID: state.sessionID,
    evaluatorToken: token,
    selectionID: selection.selectionID,
    generation: options.generation ?? generated(index),
    validations: options.validations ?? validations(),
    outcome: options.outcome ?? outcome(index),
    evaluatedAt: Math.max(Date.now(), selection.selectedAt),
  })
}

afterEach(async () => {
  await Promise.all(
    [...sessions].flatMap((sessionID) => [
      fs.rm(path.join(Global.Path.data, "harness", "bindings", `${encodeURIComponent(sessionID)}.json`), {
        force: true,
      }),
      fs.rm(path.join(Global.Path.data, "harness", "contracts", `${encodeURIComponent(sessionID)}.json`), {
        force: true,
      }),
      fs.rm(path.join(Global.Path.data, "harness", "evaluations", `${encodeURIComponent(sessionID)}.json`), {
        force: true,
      }),
      fs.rm(path.join(Global.Path.data, "harness", "audits", encodeURIComponent(sessionID)), {
        recursive: true,
        force: true,
      }),
      fs.rm(path.join(Global.Path.data, "harness", "failures", encodeURIComponent(sessionID)), {
        recursive: true,
        force: true,
      }),
    ]),
  )
  await Promise.all(
    [...auditReceipts].map((receiptID) =>
      fs.rm(path.join(Global.Path.data, "harness", "audit-receipts", `${receiptID}.json`), { force: true }),
    ),
  )
  await Promise.all(
    [...failureReceipts].map((receiptID) =>
      fs.rm(path.join(Global.Path.data, "harness", "failure-receipts", `${receiptID}.json`), { force: true }),
    ),
  )
  sessions.clear()
  auditReceipts.clear()
  failureReceipts.clear()
})

describe("topic-aware adversarial failure discovery", () => {
  test("requires canonical independent validators and enough budget to initialize every arm", () => {
    expect(() => config({ budget: 2 })).toThrow("initialize every topic")
    const valid = config()
    expect(() =>
      HarnessContract.FailureDiscovery.parse({
        ...valid,
        topics: [{ ...valid.topics[0]!, id: "__proto__" }, ...valid.topics.slice(1)],
      }),
    ).toThrow()
    expect(() =>
      HarnessContract.FailureDiscovery.parse({ ...valid, validators: valid.validators.toReversed() }),
    ).toThrow("canonical kind order")
    expect(() =>
      HarnessContract.FailureDiscovery.parse({
        ...valid,
        validators: valid.validators.map((item, index) =>
          index ? item : { ...item, identity: { ...valid.generator, name: "relabeled-generator" } },
        ),
      }),
    ).toThrow("distinct prompt/config commitments")
    expect(() =>
      HarnessContract.Info.parse({
        schemaVersion: 1,
        runID: "run",
        sessionID: "session",
        objective: "test",
        benchmark: {
          name: "statistics",
          version: "1",
          taskID: "task",
          split: "validation",
          evaluator: "evaluator",
          evaluatorVersion: "1",
          evaluatorSource: "benchmark",
        },
        profile: "react",
        audit: audit(),
        failureDiscovery: { ...valid, failureThreshold: 0.7 },
        packs: ["statistics"],
        model: { provider: "test", name: "model" },
        tools: [],
        skills: [],
        budget: { steps: 10 },
        seed: 1,
        intervention: "autonomous",
        contamination: { policy: "hidden", hiddenTestsAccessible: false },
        createdAt: Date.now(),
      }),
    ).toThrow("must use the active audit failure threshold")
  })

  test("forces every topic once, then replays UCB1 from validated immutable rewards", async () => {
    const contract = await bind("failure-ucb")
    const initialized = await source(contract)
    const before = await HarnessAudit.status(initialized.audit.auditID, {
      sessionID: contract.sessionID,
      evaluatorToken: token,
    })

    const [alpha, retry] = await Promise.all(
      Array.from({ length: 2 }, () =>
        HarnessFailure.next(initialized.stream.streamID, {
          sessionID: contract.sessionID,
          evaluatorToken: token,
        }),
      ),
    )
    expect(retry).toEqual(alpha)
    expect(alpha.topic.id).toBe("alpha")
    expect(alpha.allocation.phase).toBe("initialization")
    const first = await HarnessFailure.observe(initialized.stream.streamID, {
      sessionID: contract.sessionID,
      evaluatorToken: token,
      selectionID: alpha.selectionID,
      generation: { status: "failed", mode: "generator_error", evidence: ["evidence://generator-error"] },
      validations: [],
      evaluatedAt: Math.max(Date.now(), alpha.selectedAt),
    })
    const beta = await HarnessFailure.next(first.streamID, {
      sessionID: contract.sessionID,
      evaluatorToken: token,
    })
    expect(beta.topic.id).toBe("beta")
    const second = await HarnessFailure.observe(first.streamID, {
      sessionID: contract.sessionID,
      evaluatorToken: token,
      selectionID: beta.selectionID,
      generation: generated(1),
      validations: validations().toReversed(),
      outcome: outcome(1, true),
      evaluatedAt: Math.max(Date.now(), beta.selectedAt),
    })
    const third = await record(second, 2, { outcome: outcome(2, false), generation: generated(2, [0, 1]) })
    expect(third.attempts[2]!.selection.topic.id).toBe("gamma")
    const selected = await HarnessFailure.next(third.streamID, {
      sessionID: contract.sessionID,
      evaluatorToken: token,
    })
    expect(selected.topic.id).toBe("beta")
    expect(selected.allocation).toMatchObject({ phase: "ucb1", pulls: 1, rewards: 1 })
    const completed = await HarnessFailure.observe(third.streamID, {
      sessionID: contract.sessionID,
      evaluatorToken: token,
      selectionID: selected.selectionID,
      generation: generated(3, [Math.SQRT1_2, Math.SQRT1_2]),
      validations: validations(),
      outcome: outcome(3, true),
      evaluatedAt: Math.max(Date.now(), selected.selectedAt),
    })
    expect(completed).toMatchObject({
      status: "completed",
      stopReason: "budget_exhausted",
      statistics: {
        attempts: 4,
        generated: 3,
        admissible: 3,
        failures: 2,
        invalid: 1,
        samplesToFirstFailure: 2,
        failureRate: 2 / 3,
      },
    })
    expect(completed.statistics.topicEntropy).toBe(0)
    expect(completed.statistics.embeddingLogDet).toBeFinite()
    expect(completed.statistics.topics.beta).toEqual({ pulls: 2, rewards: 2, rate: 1 })
    const receipt = await HarnessFailure.seal(completed.streamID, {
      sessionID: contract.sessionID,
      evaluatorToken: token,
    })
    failureReceipts.add(receipt.receiptID)
    expect(
      await HarnessFailure.seal(completed.streamID, {
        sessionID: contract.sessionID,
        evaluatorToken: token,
      }),
    ).toEqual(receipt)
    const after = await HarnessAudit.status(initialized.audit.auditID, {
      sessionID: contract.sessionID,
      evaluatorToken: token,
    })
    expect(after).toEqual(before)

    const evaluation = HarnessEvaluation.Info.parse({
      schemaVersion: 1,
      runID: contract.runID,
      sessionID: contract.sessionID,
      failureDiscoveryReceiptID: receipt.receiptID,
      evaluator: { name: "official-evaluator", version: "1", source: "benchmark" },
      status: "passed",
      score: 0.2,
      metrics: { loss: 0.2 },
      checks: ["estimand", "assumptions", "effect-size", "uncertainty", "multiplicity", "stat-replay"].map((id) => ({
        id,
        status: "passed" as const,
        blocking: true,
        evidence: [`evidence://${id}`],
      })),
      evidence: ["evidence://official-score"],
      evaluatedAt: Math.max(Date.now(), receipt.completedAt),
    })
    const recorded = await HarnessEvaluation.record(evaluation)
    expect(recorded.score).toBe(0.2)
    expect(recorded.metrics).toEqual({ loss: 0.2 })
    expect(recorded.failureDiscoveryReceiptID).toBe(receipt.receiptID)
  })

  test("does not let a low failure target bypass topic initialization", async () => {
    const contract = await bind("failure-target-initialization", config({ targetFailures: 1 }))
    const initialized = await source(contract)
    const first = await record(initialized.stream, 0)
    expect(first).toMatchObject({ status: "active", statistics: { attempts: 1, failures: 1 } })
    expect(first.attempts[0]!.selection.topic.id).toBe("alpha")
    expect(
      await HarnessFailure.initialize({
        sessionID: contract.sessionID,
        evaluatorToken: token,
        subject: initialized.subject,
        auditReceiptID: initialized.receipt.receiptID,
      }),
    ).toEqual(first)
    const second = await record(first, 1, { generation: generated(1, [0, 1]) })
    expect(second).toMatchObject({ status: "active", statistics: { attempts: 2, failures: 2 } })
    expect(second.attempts[1]!.selection.topic.id).toBe("beta")
    const completed = await record(second, 2, {
      generation: generated(2, [Math.SQRT1_2, Math.SQRT1_2]),
    })
    expect(completed).toMatchObject({
      status: "completed",
      stopReason: "failure_target_reached",
      statistics: { attempts: 3, failures: 3 },
    })
    expect(completed.attempts[2]!.selection.topic.id).toBe("gamma")
  })

  test("rejects substituted selections, malformed embeddings, and duplicate reward inflation", async () => {
    const contract = await bind("failure-adversarial")
    const initialized = await source(contract)
    const selection = await HarnessFailure.next(initialized.stream.streamID, {
      sessionID: contract.sessionID,
      evaluatorToken: token,
    })
    await expect(
      HarnessFailure.observe(initialized.stream.streamID, {
        sessionID: contract.sessionID,
        evaluatorToken: token,
        selectionID: digest("attacker-selected-topic"),
        generation: generated(0),
        validations: validations(),
        outcome: outcome(0),
        evaluatedAt: Math.max(Date.now(), selection.selectedAt),
      }),
    ).rejects.toThrow("does not match the server-selected")
    await expect(
      HarnessFailure.observe(initialized.stream.streamID, {
        sessionID: contract.sessionID,
        evaluatorToken: token,
        selectionID: selection.selectionID,
        generation: generated(0, [1, 1]),
        validations: validations(),
        outcome: outcome(0),
        evaluatedAt: Math.max(Date.now(), selection.selectedAt),
      }),
    ).rejects.toThrow("L2-normalized")
    const first = await HarnessFailure.observe(initialized.stream.streamID, {
      sessionID: contract.sessionID,
      evaluatorToken: token,
      selectionID: selection.selectionID,
      generation: generated(0),
      validations: validations(),
      outcome: outcome(0),
      evaluatedAt: Math.max(Date.now(), selection.selectedAt),
    })
    const next = await HarnessFailure.next(first.streamID, {
      sessionID: contract.sessionID,
      evaluatorToken: token,
    })
    await expect(
      HarnessFailure.observe(first.streamID, {
        sessionID: contract.sessionID,
        evaluatorToken: token,
        selectionID: next.selectionID,
        generation: generated(0),
        validations: validations(),
        outcome: outcome(1),
        evaluatedAt: Math.max(Date.now(), next.selectedAt),
      }),
    ).rejects.toThrow("exact duplicate")
    const invalid = validations().map((item) =>
      item.kind === "novelty" ? { ...item, status: "failed" as const } : item,
    )
    const accepted = await HarnessFailure.observe(first.streamID, {
      sessionID: contract.sessionID,
      evaluatorToken: token,
      selectionID: next.selectionID,
      generation: generated(0),
      validations: invalid,
      evaluatedAt: Math.max(Date.now(), next.selectedAt),
    })
    expect(accepted.statistics).toMatchObject({ attempts: 2, admissible: 1, failures: 1, invalid: 1 })
    expect(accepted.attempts[1]).toMatchObject({ admissible: false, reward: 0 })
    await expect(
      HarnessFailure.observe(first.streamID, {
        sessionID: contract.sessionID,
        evaluatorToken: token,
        selectionID: next.selectionID,
        generation: generated(2),
        validations: validations(),
        outcome: outcome(2),
        evaluatedAt: Math.max(Date.now(), next.selectedAt),
      }),
    ).rejects.toThrow("immutable")
  })

  test("invalidates receipts after state or receipt tampering", async () => {
    const contract = await bind("failure-tamper", config({ budget: 3 }))
    const initialized = await source(contract)
    const first = await record(initialized.stream, 0)
    const second = await record(first, 1, { generation: generated(1, [0, 1]) })
    const completed = await record(second, 2, {
      generation: generated(2, [Math.SQRT1_2, Math.SQRT1_2]),
      outcome: outcome(2, false),
    })
    const receipt = await HarnessFailure.seal(completed.streamID, {
      sessionID: contract.sessionID,
      evaluatorToken: token,
    })
    failureReceipts.add(receipt.receiptID)
    const stateFile = path.join(
      Global.Path.data,
      "harness",
      "failures",
      encodeURIComponent(contract.sessionID),
      `${completed.streamID}.json`,
    )
    const original = await fs.readFile(stateFile, "utf8")
    const semantic = JSON.parse(original)
    const attempt = semantic.attempts.at(-1)
    attempt.outcome.loss = 0.1
    attempt.outcome.failure = true
    attempt.attemptID = digest({
      selection: attempt.selection,
      generation: attempt.generation,
      validations: attempt.validations,
      outcome: attempt.outcome,
      admissible: attempt.admissible,
      reward: attempt.reward,
      evaluatedAt: attempt.evaluatedAt,
      recordedAt: attempt.recordedAt,
    })
    await fs.writeFile(stateFile, JSON.stringify(semantic))
    await expect(
      HarnessFailure.status(completed.streamID, {
        sessionID: contract.sessionID,
        evaluatorToken: token,
      }),
    ).rejects.toThrow("cannot be replayed")
    await fs.writeFile(stateFile, original)
    const changed = JSON.parse(original)
    changed.statistics.failures = 0
    await fs.writeFile(stateFile, JSON.stringify(changed))
    expect(await HarnessFailure.readReceipt(receipt.receiptID)).toBeNull()
    await fs.writeFile(stateFile, original)
    const auditFile = path.join(
      Global.Path.data,
      "harness",
      "audits",
      encodeURIComponent(contract.sessionID),
      `${initialized.audit.auditID}.json`,
    )
    const auditState = await fs.readFile(auditFile, "utf8")
    const corruptedAudit = JSON.parse(auditState)
    corruptedAudit.estimate.failures = 0
    await fs.writeFile(auditFile, JSON.stringify(corruptedAudit))
    expect(await HarnessFailure.readReceipt(receipt.receiptID)).toBeNull()
    await fs.writeFile(auditFile, auditState)
    const receiptFile = path.join(Global.Path.data, "harness", "failure-receipts", `${receipt.receiptID}.json`)
    const saved = await fs.readFile(receiptFile, "utf8")
    const forged = JSON.parse(saved)
    forged.statistics.failureRate = 0
    await fs.writeFile(receiptFile, JSON.stringify(forged))
    expect(await HarnessFailure.readReceipt(receipt.receiptID)).toBeNull()
  })

  test("exposes stream initialization and selection only through the evaluator capability", async () => {
    const contract = await bind("failure-route")
    const initialized = await source(contract)
    const app = HarnessRoutes()
    const denied = await app.request("/failure-streams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionID: contract.sessionID,
        evaluatorToken: "wrong-topic-aware-capability-token-0000000000000",
        subject: initialized.subject,
        auditReceiptID: initialized.receipt.receiptID,
      }),
    })
    expect(denied.status).not.toBe(200)
    const response = await app.request("/failure-streams", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionID: contract.sessionID,
        evaluatorToken: token,
        subject: initialized.subject,
        auditReceiptID: initialized.receipt.receiptID,
      }),
    })
    expect(response.status).toBe(200)
    const state = (await response.json()) as HarnessFailure.State
    expect(state.streamID).toBe(initialized.stream.streamID)
    const selected = await app.request(`/failure-streams/${state.streamID}/selection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: contract.sessionID, evaluatorToken: token }),
    })
    expect(selected.status).toBe(200)
    const selection = (await selected.json()) as HarnessFailure.Selection
    expect(selection).toMatchObject({ round: 1, topic: { id: "alpha" } })
    expect(JSON.stringify(selection)).not.toContain("hidden-probe")
    expect(JSON.stringify(selection)).not.toContain(token)
  })
})

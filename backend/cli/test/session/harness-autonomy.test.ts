import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { HarnessRoutes } from "../../src/server/routes/harness"
import { HarnessAdapter } from "../../src/session/harness/adapter"
import { HarnessAutonomy } from "../../src/session/harness/autonomy"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessDomain } from "../../src/session/harness/domain"
import { HarnessReport } from "../../src/session/harness/report"
import { HarnessSearch } from "../../src/session/harness/search"

const sessions = new Set<string>()
const receipts = new Set<string>()
const evaluator = "human-ai-autonomy-evaluator-token-000000000000000"
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")

function protocol(claimedLevel: HarnessContract.AutonomyLevel = "essentially_autonomous") {
  return HarnessContract.HumanAIAutonomy.parse({
    protocolVersion: "human-ai-autonomy-v1",
    claimedLevel,
    recorder: {
      name: "evaluator-interaction-recorder",
      version: "1",
      artifactSHA256: hash("recorder-binary"),
      source: "evaluator_runtime",
    },
    traceSchemaSHA256: hash("interaction-trace-schema"),
    classificationPolicySHA256: hash("contribution-classification-policy"),
    maxEvents: 32,
    rawRetention: "required",
    disclosure: "evaluator_retained",
    completeTraceRequired: true,
    uncertaintyPolicy: "inconclusive",
  })
}

function task(
  sessionID: string,
  claimedLevel: HarnessContract.AutonomyLevel = "essentially_autonomous",
  intervention: "autonomous" | "human_reprompted" = claimedLevel === "essentially_autonomous"
    ? "autonomous"
    : "human_reprompted",
): HarnessAdapter.Task {
  sessions.add(sessionID)
  return HarnessAdapter.Task.parse({
    schemaVersion: 1,
    runID: `run-${sessionID}`,
    sessionID,
    benchmark: "statistics",
    version: "2026.08",
    taskID: "human-ai-autonomy",
    split: "validation",
    evaluator: { name: "official-autonomy-evaluator", version: "1", source: "benchmark", token: evaluator },
    autonomy: protocol(claimedLevel),
    objective: "Solve the scientific task under a predeclared human-AI contribution level",
    metric: { name: "accuracy", direction: "maximize", target: 0.8 },
    model: { provider: "test", name: "research-agent" },
    tools: ["read"],
    skills: [{ name: "record-human-ai-autonomy" }],
    budget: { steps: 20, ...(claimedLevel === "essentially_autonomous" ? {} : { candidates: 2 }) },
    profile: claimedLevel === "essentially_autonomous" ? "react" : "optimize",
    seed: 43,
    intervention,
    contamination: { policy: "hidden benchmark material stays evaluator-private", hiddenTestsAccessible: false },
    createdAt: Date.now(),
  })
}

function events(
  contract: HarnessContract.Info,
  artifactSHA256: string,
  input: {
    human?: HarnessAutonomy.Contribution
    agent?: HarnessAutonomy.Contribution
    humanKind?: HarnessAutonomy.Kind
  } = {},
): HarnessAutonomy.Submit["trace"]["events"] {
  const startedAt = contract.createdAt
  const endedAt = Math.max(Date.now(), startedAt)
  return [
    {
      sequence: 1,
      at: startedAt,
      actor: "benchmark",
      kind: "problem_statement",
      contribution: "problem",
      contentSHA256: hash(`${contract.sessionID}-problem`),
      evidence: ["trace://problem"],
    },
    ...(input.human
      ? [
          {
            sequence: 2,
            at: endedAt,
            actor: "human" as const,
            kind: input.humanKind ?? ("strategy" as const),
            contribution: input.human,
            contentSHA256: hash(`${contract.sessionID}-human`),
            evidence: ["trace://human"],
          },
        ]
      : []),
    {
      sequence: input.human ? 3 : 2,
      at: endedAt,
      actor: "agent",
      kind: "artifact_edit",
      contribution: input.agent ?? "core",
      contentSHA256: hash(`${contract.sessionID}-agent`),
      artifactAfterSHA256: artifactSHA256,
      evidence: ["trace://agent-artifact"],
    },
  ]
}

function submit(
  contract: HarnessContract.Info,
  input: {
    subject?: HarnessAutonomy.Subject
    artifactSHA256?: string
    human?: HarnessAutonomy.Contribution
    agent?: HarnessAutonomy.Contribution
    humanKind?: HarnessAutonomy.Kind
  } = {},
) {
  if (!contract.autonomy) throw new Error("Expected autonomy protocol")
  const artifactSHA256 = input.artifactSHA256 ?? hash(`${contract.sessionID}-artifact`)
  const trace = events(contract, artifactSHA256, input)
  return HarnessAutonomy.Submit.parse({
    sessionID: contract.sessionID,
    evaluatorToken: evaluator,
    subject: input.subject ?? { type: "run", id: contract.runID },
    artifactSHA256,
    trace: {
      owner: "evaluator_runtime",
      complete: true,
      recorderArtifactSHA256: contract.autonomy.recorder.artifactSHA256,
      schemaSHA256: contract.autonomy.traceSchemaSHA256,
      classificationPolicySHA256: contract.autonomy.classificationPolicySHA256,
      rawLogSHA256: hash(`${contract.sessionID}-raw-log`),
      startedAt: contract.createdAt,
      endedAt: trace.at(-1)!.at,
      events: trace,
    },
  })
}

const checks = (contract: HarnessContract.Info) =>
  HarnessDomain.compose(contract.packs ?? []).map((check) => ({
    id: check.id,
    status: "passed" as const,
    blocking: check.severity === "blocking",
    evidence: [`evidence://${check.id}`],
  }))

function evaluation(contract: HarnessContract.Info, receipt?: HarnessAutonomy.Receipt) {
  return HarnessAdapter.Evaluation.parse({
    schemaVersion: 1,
    runID: contract.runID,
    sessionID: contract.sessionID,
    evaluatorToken: evaluator,
    autonomyReceiptID: receipt?.receiptID,
    status: "passed",
    score: 0.9,
    metrics: { accuracy: 0.9 },
    checks: checks(contract),
    evidence: ["official://autonomy-result"],
    evaluatedAt: Math.max(Date.now(), receipt?.endedAt ?? contract.createdAt),
  })
}

afterEach(async () => {
  await Promise.all(
    [...sessions].flatMap((sessionID) => [
      ...["bindings", "contracts", "evaluations", "reports", "search", "retrospectives"].map((name) =>
        fs.rm(path.join(Global.Path.data, "harness", name, `${encodeURIComponent(sessionID)}.json`), { force: true }),
      ),
      fs.rm(path.join(Global.Path.data, "harness", "autonomy", "subjects", encodeURIComponent(sessionID)), {
        recursive: true,
        force: true,
      }),
    ]),
  )
  await Promise.all(
    [...receipts].map((receiptID) =>
      fs.rm(path.join(Global.Path.data, "harness", "autonomy", "receipts", `${receiptID}.json`), { force: true }),
    ),
  )
  sessions.clear()
  receipts.clear()
})

describe("human-AI autonomy receipts", () => {
  test("derives essentially autonomous work and gates the final report", async () => {
    const contract = await HarnessAdapter.bind(task("autonomy-pass"))
    const policy = HarnessAutonomy.prompt(contract)
    expect(policy).toContain("essentially_autonomous")
    expect(policy).not.toContain(contract.autonomy!.traceSchemaSHA256)
    await expect(HarnessAdapter.ingest(evaluation(contract))).rejects.toThrow("human-AI autonomy receipt")

    const receipt = await HarnessAutonomy.record(submit(contract), contract)
    receipts.add(receipt.receiptID)
    expect(receipt).toMatchObject({
      status: "passed",
      claimedLevel: "essentially_autonomous",
      derivedLevel: "essentially_autonomous",
      metrics: { problemEvents: 1, humanSubstantiveEvents: 0, agentSubstantiveEvents: 1 },
    })
    expect(receipt.events[1]?.priorEventID).toBe(receipt.events[0]?.eventID)
    expect(JSON.stringify(receipt)).not.toContain(evaluator)

    await expect(
      HarnessAdapter.ingest({ ...evaluation(contract, receipt), evaluatedAt: receipt.recordedAt - 1 }),
    ).rejects.toThrow("predates")

    const result = await HarnessAdapter.ingest(evaluation(contract, receipt))
    const report = HarnessReport.compile({ contract, evaluations: [result.evaluation], autonomy: receipt })
    expect(report.execution.autonomy).toEqual({
      claimedLevel: "essentially_autonomous",
      derivedLevel: "essentially_autonomous",
      status: "passed",
    })
    expect(report.quality.autonomyReceiptID).toBe(receipt.receiptID)
    const collaborative = HarnessContract.Info.parse({
      ...contract,
      runID: `${contract.runID}-collaborative`,
      sessionID: `${contract.sessionID}-collaborative`,
      intervention: "human_reprompted",
      autonomy: { ...contract.autonomy!, claimedLevel: "human_ai_collaboration" },
    })
    const other = HarnessReport.compile({ contract: collaborative, evaluations: [] })
    expect(report.comparisonKey).not.toBe(other.comparisonKey)
  })

  test("downgrades essential human help while preserving auxiliary problem and exposition work", async () => {
    const autonomous = await HarnessAdapter.bind(
      task("autonomy-laundered", "essentially_autonomous", "human_reprompted"),
    )
    const laundered = await HarnessAutonomy.record(
      submit(autonomous, { human: "essential", humanKind: "strategy" }),
      autonomous,
    )
    receipts.add(laundered.receiptID)
    expect(laundered).toMatchObject({ status: "failed", derivedLevel: "human_ai_collaboration" })
    await expect(HarnessAdapter.ingest(evaluation(autonomous, laundered))).rejects.toThrow(
      "passing human-AI autonomy receipt",
    )

    const auxiliary = await HarnessAdapter.bind(
      task("autonomy-auxiliary", "essentially_autonomous", "human_reprompted"),
    )
    const retained = await HarnessAutonomy.record(
      submit(auxiliary, { human: "auxiliary", humanKind: "exposition" }),
      auxiliary,
    )
    receipts.add(retained.receiptID)
    expect(retained).toMatchObject({ status: "passed", derivedLevel: "essentially_autonomous" })

    const edited = await HarnessAdapter.bind(task("autonomy-post-edit"))
    const post = submit(edited)
    const final = post.artifactSHA256
    post.trace.events.push({
      sequence: 3,
      at: post.trace.endedAt,
      actor: "agent",
      kind: "artifact_edit",
      contribution: "auxiliary",
      contentSHA256: hash("post-final-edit"),
      artifactBeforeSHA256: final,
      artifactAfterSHA256: hash("unbound-post-final-artifact"),
      evidence: ["trace://post-final-edit"],
    })
    const changed = await HarnessAutonomy.record(post, edited)
    receipts.add(changed.receiptID)
    expect(changed.status).toBe("failed")
    expect(changed.failures).toContain("last interaction artifact transition does not bind the final artifact")

    const collaborative = await HarnessAdapter.bind(task("autonomy-collaboration", "human_ai_collaboration"))
    const collaboration = await HarnessAutonomy.record(submit(collaborative, { human: "essential" }), collaborative)
    receipts.add(collaboration.receiptID)
    expect(collaboration).toMatchObject({ status: "passed", derivedLevel: "human_ai_collaboration" })

    const primarily = await HarnessAdapter.bind(task("autonomy-human", "primarily_human"))
    const human = await HarnessAutonomy.record(
      submit(primarily, { human: "core", agent: "auxiliary", humanKind: "artifact_edit" }),
      primarily,
    )
    receipts.add(human.receiptID)
    expect(human).toMatchObject({ status: "passed", derivedLevel: "primarily_human" })

    await expect(
      HarnessAdapter.bind(task("autonomy-invalid-label", "human_ai_collaboration", "autonomous")),
    ).rejects.toThrow("human_reprompted")
  })

  test("makes ambiguous classifications inconclusive and rejects trace or candidate laundering", async () => {
    const contract = await HarnessAdapter.bind(task("autonomy-adversarial"))
    const uncertain = await HarnessAutonomy.record(
      submit(contract, { human: "unclear", humanKind: "technical_correction" }),
      contract,
    )
    receipts.add(uncertain.receiptID)
    expect(uncertain.status).toBe("inconclusive")
    expect(uncertain.derivedLevel).toBeUndefined()

    const changed = task("autonomy-trace-drift")
    changed.profile = "optimize"
    changed.budget = { ...changed.budget, candidates: 2 }
    const searchContract = await HarnessAdapter.bind(changed)
    await HarnessSearch.initialize({ sessionID: searchContract.sessionID })
    const recommendation = HarnessSearch.recommend(await HarnessSearch.read(searchContract.sessionID))
    const artifactSHA256 = hash("registered-candidate-artifact")
    const candidate = await HarnessSearch.add({
      sessionID: searchContract.sessionID,
      recommendationID: recommendation.id,
      parentIDs: recommendation.parentIDs,
      inspirationIDs: recommendation.inspirationIDs,
      branch: "autonomy",
      proposal: "candidate with an evaluator-owned interaction trace",
      artifact: { uri: "candidate://autonomy", sha256: artifactSHA256 },
    })
    await expect(
      HarnessAutonomy.record(
        submit(searchContract, {
          subject: { type: "candidate", id: candidate.id },
          artifactSHA256: hash("substituted-candidate-artifact"),
        }),
        searchContract,
      ),
    ).rejects.toThrow("changed the candidate artifact")

    const valid = submit(searchContract, {
      subject: { type: "candidate", id: candidate.id },
      artifactSHA256,
    })
    const gap = structuredClone(valid)
    gap.trace.events[1]!.sequence = 3
    await expect(HarnessAutonomy.record(gap, searchContract)).rejects.toThrow("contiguous")
    const late = structuredClone(valid)
    late.trace.startedAt += 1
    late.trace.events[0]!.at = late.trace.startedAt
    await expect(HarnessAutonomy.record(late, searchContract)).rejects.toThrow("run interval")
    const future = structuredClone(valid)
    future.trace.endedAt = Date.now() + 60_000
    future.trace.events[1]!.at = future.trace.endedAt
    await expect(HarnessAutonomy.record(future, searchContract)).rejects.toThrow("run interval")

    const receipt = await HarnessAutonomy.record(valid, searchContract)
    receipts.add(receipt.receiptID)
    const replacement = structuredClone(valid)
    replacement.trace.rawLogSHA256 = hash("replacement-log")
    await expect(HarnessAutonomy.record(replacement, searchContract)).rejects.toThrow("canonical receipt")
  })

  test("protects receipt routes with the evaluator capability and fails closed on disk tampering", async () => {
    const contract = await HarnessAdapter.bind(task("autonomy-route"))
    const app = HarnessRoutes()
    const response = await app.request("/autonomy/receipts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(submit(contract)),
    })
    expect(response.status).toBe(200)
    const receipt = HarnessAutonomy.Receipt.parse(await response.json())
    receipts.add(receipt.receiptID)

    await expect(
      HarnessAdapter.authorize(contract.sessionID, "wrong-human-ai-autonomy-token-000000000000000"),
    ).rejects.toThrow("capability was rejected")
    const read = await app.request(`/autonomy/receipts/${receipt.receiptID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: contract.sessionID, evaluatorToken: evaluator }),
    })
    expect(read.status).toBe(200)

    const file = path.join(Global.Path.data, "harness", "autonomy", "receipts", `${receipt.receiptID}.json`)
    await Bun.write(file, JSON.stringify({ ...receipt, derivedLevel: "primarily_human" }))
    expect(await HarnessAutonomy.readReceipt(receipt.receiptID)).toBeNull()
  })
})

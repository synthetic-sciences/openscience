import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { HarnessRoutes } from "../../src/server/routes/harness"
import { HarnessAdapter } from "../../src/session/harness/adapter"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessDomain } from "../../src/session/harness/domain"
import { HarnessEvolution } from "../../src/session/harness/evolution"
import { HarnessReport } from "../../src/session/harness/report"
import { HarnessSearch } from "../../src/session/harness/search"

const sessions = new Set<string>()
const token = "evolution-evaluator-capability-token-00000000000000000"
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")

afterEach(async () => {
  await Promise.all(
    [...sessions].flatMap((sessionID) =>
      ["bindings", "contracts", "evaluations", "evolution", "reports", "search"].map((name) =>
        fs.rm(path.join(Global.Path.data, "harness", name, `${encodeURIComponent(sessionID)}.json`), { force: true }),
      ),
    ),
  )
  await fs.rm(path.join(Global.Path.data, "harness", "retrospectives"), { recursive: true, force: true })
  sessions.clear()
})

function protocol() {
  return HarnessContract.Evolution.parse({
    protocolVersion: "evolution-trace-v1",
    validatorSHA256: hash("trace-evolutionary-candidate.py:v1"),
    manifestSchemaSHA256: hash("evolution-source-manifest:v1"),
    lineAlgorithm: "sha256-exact-line-v1",
    roots: ["src"],
    extensions: [".ts"],
    exclude: ["src/generated"],
    maxFiles: 100,
    maxFileBytes: 100_000,
    maxTotalBytes: 1_000_000,
    maxSourceLines: 10_000,
    maxChangedLines: 1_000,
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
    taskID: "evolution-task-1",
    split: "validation",
    evaluator: { name: "official-evolution-evaluator", version: "7", source: "benchmark", token },
    objective: "Improve the official score while retaining evaluator-owned replayable source lineage",
    evolution: protocol(),
    metric: { name: "score", direction: "maximize" },
    model: { provider: "test", name: "research-agent" },
    tools: ["read", "bash"],
    skills: [{ name: "trace-evolutionary-candidate", version: "1", sha256: protocol().validatorSHA256 }],
    budget: { steps: 40, candidates: 4 },
    seed: 43,
    intervention: "autonomous",
    contamination: { policy: "hidden tests remain outside the candidate process", hiddenTestsAccessible: false },
    createdAt: Date.now(),
  })
}

const checks = (contract: HarnessContract.Info) =>
  HarnessDomain.compose(contract.packs ?? []).map((check) => ({
    id: check.id,
    status: "passed" as const,
    blocking: check.severity === "blocking",
    evidence: [`receipt:${check.id}`],
  }))

function snapshot(contract: HarnessContract.Info, name: string, content: string) {
  const evolution = contract.evolution
  if (!evolution) throw new Error("Expected an evolution trace protocol")
  const bytes = new TextEncoder().encode(content)
  const files = HarnessEvolution.Files.parse([
    {
      path: "src/main.ts",
      sha256: hash(content),
      bytes: bytes.byteLength,
      lineHashes: content.split("\n").flatMap((line) => (line ? [hash(line)] : [])),
    },
  ])
  return HarnessEvolution.Snapshot.parse({
    artifact: { uri: `artifact:${name}.manifest.json`, sha256: HarnessEvolution.manifestSHA256(evolution, files) },
    schemaSHA256: evolution.manifestSchemaSHA256,
    files,
  })
}

function submit(
  contract: HarnessContract.Info,
  candidate: HarnessSearch.Candidate,
  source: ReturnType<typeof snapshot>,
  parents: HarnessEvolution.Info[] = [],
) {
  const evolution = contract.evolution
  if (!evolution) throw new Error("Expected an evolution trace protocol")
  const subject = { type: "candidate" as const, id: candidate.id, artifact: candidate.artifact }
  const evaluatedAt = Math.max(candidate.createdAt, ...parents.map((parent) => parent.evaluatedAt), Date.now()) + 1
  return HarnessEvolution.Submit.parse({
    schemaVersion: 1,
    runID: contract.runID,
    sessionID: contract.sessionID,
    evaluatorToken: token,
    protocol: evolution,
    subject,
    snapshot: source,
    parents: parents
      .map((parent) => ({
        id: parent.subject.id,
        artifact: parent.subject.artifact,
        receiptID: parent.receiptID,
        snapshotSHA256: parent.snapshot.artifact.sha256,
        delta: {
          uri: `artifact:${candidate.id}-${parent.subject.id}.delta.json`,
          sha256: HarnessEvolution.deltaSHA256({ subject, snapshot: source, parent }),
        },
      }))
      .toSorted((left, right) => left.id.localeCompare(right.id)),
    validator: {
      name: "trace-evolutionary-candidate",
      version: 1,
      scriptSHA256: evolution.validatorSHA256,
    },
    evidence: [`artifact:${candidate.id}-trace-report.json`],
    evaluatedAt,
  })
}

function evaluation(contract: HarnessContract.Info, candidateID: string, receiptID?: string, score = 0.8) {
  return HarnessAdapter.Evaluation.parse({
    schemaVersion: 1,
    runID: contract.runID,
    sessionID: contract.sessionID,
    evaluatorToken: token,
    candidateID,
    evolutionReceiptID: receiptID,
    status: "passed",
    score,
    metrics: { score },
    checks: checks(contract),
    evidence: ["official:score.json"],
    evaluatedAt: Date.now() + 10,
  })
}

async function add(contract: HarnessContract.Info, branch: string, artifact: string) {
  const state = await HarnessSearch.read(contract.sessionID)
  const recommendation = HarnessSearch.recommend(state)
  const result = await HarnessSearch.add({
    sessionID: contract.sessionID,
    recommendationID: recommendation.id,
    parentIDs: recommendation.parentIDs,
    inspirationIDs: recommendation.inspirationIDs,
    branch,
    proposal: `Evaluate ${branch} without trusting producer-authored lineage`,
    artifact: { uri: `artifact:${artifact}`, sha256: hash(artifact) },
  })
  return result.state.candidates[result.id]!
}

describe("evaluator-owned evolutionary provenance", () => {
  test("derives ancestral source reintroductions while leaving fitness under evaluator authority", async () => {
    const contract = await HarnessAdapter.bind(task("evolution-cycle"))
    await HarnessSearch.initialize({ sessionID: contract.sessionID, candidates: 4 })

    const root = await add(contract, "root", "root-artifact")
    const rootTrace = await HarnessEvolution.record(
      submit(contract, root, snapshot(contract, "root", "alpha\nold\n")),
      contract,
    )
    expect(rootTrace.diagnostics).toMatchObject({ depth: 0, ancestors: 0, addedLines: 0, cycleDetected: false })
    expect((await HarnessSearch.read(contract.sessionID)).candidates[root.id]!.result).toBeUndefined()
    await expect(HarnessAdapter.ingest(evaluation(contract, root.id))).rejects.toThrow("must reference")
    await HarnessAdapter.ingest(evaluation(contract, root.id, rootTrace.receiptID, 0.7))

    const scout = await add(contract, "independent-scout", "scout-artifact")
    const scoutTrace = await HarnessEvolution.record(
      submit(contract, scout, snapshot(contract, "scout", "alpha\nscout\n")),
      contract,
    )
    await HarnessAdapter.ingest(evaluation(contract, scout.id, scoutTrace.receiptID, 0.6))

    const child = await add(contract, "replace-old", "child-artifact")
    const childTrace = await HarnessEvolution.record(
      submit(contract, child, snapshot(contract, "child", "alpha\nnew\n"), [rootTrace]),
      contract,
    )
    expect(childTrace.diagnostics).toMatchObject({
      depth: 1,
      ancestors: 1,
      addedLines: 1,
      deletedLines: 1,
      reintroducedLines: 0,
      cycleDetected: false,
    })
    await expect(HarnessAdapter.ingest(evaluation(contract, child.id, rootTrace.receiptID, 0.75))).rejects.toThrow(
      "does not match the evaluated candidate",
    )
    await HarnessAdapter.ingest(evaluation(contract, child.id, childTrace.receiptID, 0.75))

    const grandchild = await add(contract, "reintroduce-old", "grandchild-artifact")
    const grandchildTrace = await HarnessEvolution.record(
      submit(contract, grandchild, snapshot(contract, "grandchild", "alpha\nold\nfresh\n"), [childTrace]),
      contract,
    )
    expect(grandchildTrace.diagnostics).toMatchObject({
      depth: 2,
      ancestors: 2,
      addedLines: 2,
      deletedLines: 1,
      ancestralDeletedLines: 1,
      reintroducedLines: 1,
      reintroducedHashes: 1,
      reintroducedFraction: 0.5,
      novelLines: 1,
      sourceChanged: true,
      cycleDetected: true,
    })
    const result = await HarnessAdapter.ingest(evaluation(contract, grandchild.id, grandchildTrace.receiptID, 0.9))
    expect(result.search?.candidates[grandchild.id]!.result?.evolution).toMatchObject({
      receiptID: grandchildTrace.receiptID,
      reintroducedLines: 1,
      cycleDetected: true,
    })
    expect(result.search?.bestID).toBe(grandchild.id)
    const report = HarnessReport.compile({ contract, evaluations: [result.evaluation], search: result.search })
    expect(report.quality.evolutionReceiptID).toBe(grandchildTrace.receiptID)
  })

  test("rejects candidate, parent, validator, protocol, delta, and temporal substitution", async () => {
    const contract = await HarnessAdapter.bind(task("evolution-substitution"))
    await HarnessSearch.initialize({ sessionID: contract.sessionID, candidates: 3 })
    const root = await add(contract, "root", "substitution-root")
    const rootInput = submit(contract, root, snapshot(contract, "substitution-root", "alpha\nold\n"))
    await expect(
      HarnessEvolution.record(
        {
          ...rootInput,
          subject: { ...rootInput.subject, artifact: { ...rootInput.subject.artifact, sha256: hash("x") } },
        },
        contract,
      ),
    ).rejects.toThrow("artifact does not match")
    await expect(
      HarnessEvolution.record(
        { ...rootInput, validator: { ...rootInput.validator, scriptSHA256: hash("substituted-validator") } },
        contract,
      ),
    ).rejects.toThrow("validator does not match")
    await expect(
      HarnessEvolution.record({ ...rootInput, protocol: { ...rootInput.protocol, maxChangedLines: 999 } }, contract),
    ).rejects.toThrow("immutable harness contract")
    await expect(HarnessEvolution.record({ ...rootInput, evaluatedAt: root.createdAt - 1 }, contract)).rejects.toThrow(
      "predates the candidate",
    )

    const rootTrace = await HarnessEvolution.record(rootInput, contract)
    await HarnessAdapter.ingest(evaluation(contract, root.id, rootTrace.receiptID, 0.7))
    const scout = await add(contract, "scout", "substitution-scout")
    const scoutTrace = await HarnessEvolution.record(
      submit(contract, scout, snapshot(contract, "substitution-scout", "alpha\nscout\n")),
      contract,
    )
    await HarnessAdapter.ingest(evaluation(contract, scout.id, scoutTrace.receiptID, 0.6))
    const child = await add(contract, "child", "substitution-child")
    const childInput = submit(contract, child, snapshot(contract, "substitution-child", "alpha\nnew\n"), [rootTrace])
    await expect(
      HarnessEvolution.record(
        {
          ...childInput,
          parents: childInput.parents.map((parent) => ({
            ...parent,
            delta: { ...parent.delta, sha256: hash("substituted-delta") },
          })),
        },
        contract,
      ),
    ).rejects.toThrow("delta content hash is invalid")
    await expect(
      HarnessEvolution.record(
        {
          ...childInput,
          parents: childInput.parents.map((parent) => ({ ...parent, receiptID: hash("missing-receipt") })),
        },
        contract,
      ),
    ).rejects.toThrow("does not exist")
    await expect(
      HarnessEvolution.record(
        { ...childInput, parents: childInput.parents.map((parent) => ({ ...parent, id: hash("other-parent") })) },
        contract,
      ),
    ).rejects.toThrow("do not match the candidate lineage")
    const childTrace = await HarnessEvolution.record(childInput, contract)
    await expect(
      HarnessEvolution.record({ ...childInput, evidence: ["artifact:different-report.json"] }, contract),
    ).rejects.toThrow("immutable once recorded")
    expect(childTrace.parents[0]!.receiptID).toBe(rootTrace.receiptID)
  })

  test("derives fusion novelty against the union of both exact parent snapshots", async () => {
    const contract = await HarnessAdapter.bind(task("evolution-fusion"))
    await HarnessSearch.initialize({ sessionID: contract.sessionID, candidates: 3, stall: 1 })
    const left = await add(contract, "left-root", "left-artifact")
    const leftTrace = await HarnessEvolution.record(
      submit(contract, left, snapshot(contract, "left", "common\nleft\nold\n")),
      contract,
    )
    await HarnessAdapter.ingest(evaluation(contract, left.id, leftTrace.receiptID, 0.8))
    const right = await add(contract, "right-root", "right-artifact")
    const rightTrace = await HarnessEvolution.record(
      submit(contract, right, snapshot(contract, "right", "common\nright\nold\n")),
      contract,
    )
    await HarnessAdapter.ingest(evaluation(contract, right.id, rightTrace.receiptID, 0.7))

    const fused = await add(contract, "fusion", "fused-artifact")
    expect(fused.parentIDs.toSorted()).toEqual([left.id, right.id].toSorted())
    const trace = await HarnessEvolution.record(
      submit(contract, fused, snapshot(contract, "fused", "common\nleft\nright\n"), [leftTrace, rightTrace]),
      contract,
    )
    expect(trace.diagnostics).toMatchObject({
      depth: 1,
      ancestors: 2,
      addedLines: 0,
      deletedLines: 1,
      reintroducedLines: 0,
      reintroducedFraction: 0,
      novelLines: 0,
      sourceChanged: true,
      cycleDetected: false,
    })
    expect(trace.diagnostics.parents).toEqual([
      expect.objectContaining({ addedLines: 1, deletedLines: 1, filesChanged: 1 }),
      expect.objectContaining({ addedLines: 1, deletedLines: 1, filesChanged: 1 }),
    ])
  })

  test("protects receipt routes and fails closed when derived diagnostics are edited", async () => {
    const contract = await HarnessAdapter.bind(task("evolution-route"))
    await HarnessSearch.initialize({ sessionID: contract.sessionID, candidates: 1 })
    const root = await add(contract, "route-root", "route-root")
    const input = submit(contract, root, snapshot(contract, "route-root", "alpha\n"))
    const app = HarnessRoutes()
    const recorded = await app.request("/evolution/receipts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    })
    expect(recorded.status).toBe(200)
    const receipt = (await recorded.json()) as HarnessEvolution.Info
    expect(JSON.stringify(receipt)).not.toContain(token)

    const denied = await app.request(`/evolution/receipts/${receipt.receiptID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: contract.sessionID, evaluatorToken: "x".repeat(48) }),
    })
    expect(denied.status).not.toBe(200)
    const read = await app.request(`/evolution/receipts/${receipt.receiptID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: contract.sessionID, evaluatorToken: token }),
    })
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({ receiptID: receipt.receiptID, subject: { id: root.id } })

    const target = path.join(Global.Path.data, "harness", "evolution", `${encodeURIComponent(contract.sessionID)}.json`)
    const state = (await Bun.file(target).json()) as { items: Record<string, HarnessEvolution.Info> }
    state.items[receipt.receiptID]!.diagnostics.cycleDetected = true
    await Bun.write(target, JSON.stringify(state))
    await expect(HarnessEvolution.list(contract.sessionID)).rejects.toThrow("content hash is invalid")
  })

  test("keeps the protocol optional and restricts it to authenticated optimization", async () => {
    const legacy = task("evolution-legacy")
    delete legacy.evolution
    expect((await HarnessAdapter.bind(legacy)).evolution).toBeUndefined()
    const external = await HarnessAdapter.bind({
      ...task("evolution-external"),
      evaluator: { name: "external-evaluator", version: "1", source: "external", token },
    })
    expect(() => HarnessContract.Info.parse({ ...external, profile: "theory" })).toThrow("optimize profile")
    expect(() =>
      HarnessContract.Info.parse({
        ...external,
        benchmark: { ...external.benchmark, evaluator: "human", evaluatorSource: "human" },
      }),
    ).toThrow("capability-authenticated")
  })
})

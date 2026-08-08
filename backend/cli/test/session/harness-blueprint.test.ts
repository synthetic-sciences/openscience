import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { HarnessRoutes } from "../../src/server/routes/harness"
import { HarnessAdapter } from "../../src/session/harness/adapter"
import { HarnessBlueprint } from "../../src/session/harness/blueprint"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessReport } from "../../src/session/harness/report"

const sessions = new Set<string>()
const evaluator = "proof-blueprint-evaluator-token-000000000000000000"
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")

function protocol(input: { attempts?: number; refinements?: number; parallel?: number; leaseMs?: number } = {}) {
  const kernel = hash("blueprint-lean-kernel")
  return HarnessContract.FormalProof.parse({
    protocolVersion: "formal-proof-v1",
    language: "lean4",
    tier: "kernel",
    relation: "exact_proof",
    challengeSHA256: hash("blueprint-challenge"),
    statementSHA256: hash("blueprint-root-statement"),
    declaration: "OpenScience.root",
    module: "OpenScience.Blueprint",
    leanVersion: "4.33.0",
    leanToolchainSHA256: hash("blueprint-toolchain"),
    lakeManifestSHA256: hash("blueprint-lake-manifest"),
    dependencyTreeSHA256: hash("blueprint-dependency-tree"),
    verifiers: [
      { role: "lean_kernel", name: "lean", version: "4.33.0", artifactSHA256: kernel },
      { role: "source_auditor", name: "source", version: "1", artifactSHA256: hash("blueprint-source") },
      { role: "axiom_auditor", name: "axioms", version: "1", artifactSHA256: hash("blueprint-axioms") },
    ],
    forbiddenConstructs: HarnessContract.FormalForbidden.options,
    allowedAxioms: ["Classical.choice"],
    maxFiles: 32,
    completeManifestRequired: true,
    warningPolicy: "fail",
    semanticPolicy: "formal_statement_only",
    blueprint: {
      protocolVersion: "proof-blueprint-v1",
      graphSchemaSHA256: hash("proof-blueprint-schema-v1"),
      compilerArtifactSHA256: kernel,
      sketchValidatorArtifactSHA256: hash("blueprint-sketch-validator"),
      reviewerArtifactSHA256: hash("blueprint-reviewer"),
      reviewerPromptSHA256: hash("blueprint-review-rubric"),
      nodePolicy: "and-or-monotone-v1",
      failurePolicy: "preserve-and-refine",
      memoization: "goal-sha256",
      finalAuthority: "formal-proof-v1",
      directAttemptFirst: true,
      verifiedSketchRequired: true,
      completeFailureHistoryRequired: true,
      maxNodes: 16,
      maxDepth: 4,
      maxParallel: input.parallel ?? 4,
      maxAttemptsPerGoal: input.attempts ?? 2,
      maxRefinementsPerGoal: input.refinements ?? 1,
      leaseDurationMs: input.leaseMs ?? 60_000,
    },
  })
}

function task(
  sessionID: string,
  input: { attempts?: number; refinements?: number; parallel?: number; leaseMs?: number } = {},
) {
  sessions.add(sessionID)
  return HarnessAdapter.Task.parse({
    schemaVersion: 1,
    runID: `run-${sessionID}`,
    sessionID,
    benchmark: "statistics",
    version: "2026.08",
    taskID: "proof-blueprint",
    split: "validation",
    evaluator: { name: "official-blueprint-evaluator", version: "1", source: "benchmark", token: evaluator },
    formalProof: protocol(input),
    objective: "Prove the exact frozen Lean declaration",
    metric: { name: "accuracy", direction: "maximize", target: 0.8 },
    model: { provider: "test", name: "blueprint-agent" },
    tools: ["read", "bash"],
    skills: [{ name: "operate-proof-blueprint" }],
    budget: { steps: 20 },
    profile: "react",
    seed: 71,
    intervention: "autonomous",
    contamination: { policy: "trusted challenge remains evaluator-owned", hiddenTestsAccessible: false },
    createdAt: Date.now(),
  })
}

const child = (name: string) => ({
  statementSHA256: hash(`statement-${name}`),
  declaration: `OpenScience.${name}`,
  module: "OpenScience.Blueprint",
})

function verification(contract: HarnessContract.Info, lease: HarnessBlueprint.Lease, name: string, exitCode = 0) {
  return {
    compilerArtifactSHA256: contract.formalProof!.blueprint!.compilerArtifactSHA256,
    statementMatched: true,
    exitCode,
    warnings: 0,
    transcriptSHA256: hash(`compiler-${name}`),
    feedbackSHA256: hash(`feedback-${name}`),
    startedAt: lease.issuedAt,
    endedAt: Date.now(),
  }
}

function direct(
  contract: HarnessContract.Info,
  lease: HarnessBlueprint.Lease,
  name: string,
  input: { claim?: "proof" | "refutation" | "failure"; exitCode?: number } = {},
) {
  return HarnessBlueprint.DirectSubmit.parse({
    sessionID: contract.sessionID,
    evaluatorToken: evaluator,
    kind: "direct",
    leaseID: lease.id,
    artifactSHA256: hash(`artifact-${name}`),
    claim: input.claim ?? "proof",
    verification: verification(contract, lease, name, input.exitCode),
  })
}

function decompose(
  contract: HarnessContract.Info,
  lease: HarnessBlueprint.Lease,
  name: string,
  children: HarnessBlueprint.GoalSpec[],
  review: { relevant?: boolean; easier?: boolean; plausible?: boolean } = {},
) {
  const blueprint = contract.formalProof!.blueprint!
  return HarnessBlueprint.DecompositionSubmit.parse({
    sessionID: contract.sessionID,
    evaluatorToken: evaluator,
    kind: "decomposition",
    leaseID: lease.id,
    informalPlanSHA256: hash(`plan-${name}`),
    artifactSHA256: hash(`sketch-${name}`),
    children,
    verification: {
      ...verification(contract, lease, name),
      validatorArtifactSHA256: blueprint.sketchValidatorArtifactSHA256,
      placeholderDeclarations: children.map((item) => item.declaration).toSorted((a, b) => a.localeCompare(b)),
      validatorTranscriptSHA256: hash(`validator-${name}`),
    },
    review: {
      reviewerArtifactSHA256: blueprint.reviewerArtifactSHA256,
      promptSHA256: blueprint.reviewerPromptSHA256,
      relevant: review.relevant ?? true,
      easier: review.easier ?? true,
      plausible: review.plausible ?? true,
      transcriptSHA256: hash(`review-${name}`),
    },
  })
}

afterEach(async () => {
  await Promise.all(
    [...sessions].flatMap((sessionID) =>
      ["bindings", "contracts", "evaluations", "reports", "blueprints"].map((name) =>
        fs.rm(path.join(Global.Path.data, "harness", name, `${encodeURIComponent(sessionID)}.json`), {
          force: true,
        }),
      ),
    ),
  )
  sessions.clear()
})

describe("formal proof blueprints", () => {
  test("closes a compiler-grounded AND branch while formal receipt authority stays separate", async () => {
    const contract = await HarnessAdapter.bind(task("blueprint-close"))
    const initial = await HarnessBlueprint.initialize(contract)
    expect(initial).toMatchObject({ summary: { status: "open", goals: 1, attempts: 0 } })
    expect(await HarnessBlueprint.initialize(contract)).toEqual(initial)

    const root = (await HarnessBlueprint.lease(contract, 1)).leases[0]!
    await expect(
      HarnessBlueprint.record(decompose(contract, root, "premature", [child("left")]), contract),
    ).rejects.toThrow("direct proof attempt")
    const failed = await HarnessBlueprint.record(direct(contract, root, "root-fail", { exitCode: 1 }), contract)
    expect(failed.state.attempts[0]).toMatchObject({
      result: "failed",
      failures: ["Lean compiler rejected the artifact"],
    })

    const decompositionLease = (await HarnessBlueprint.lease(contract, 1)).leases[0]!
    const branch = await HarnessBlueprint.record(
      decompose(contract, decompositionLease, "root-split", [child("left"), child("right")]),
      contract,
    )
    expect(branch.state).toMatchObject({
      summary: { status: "open", goals: 3, decompositions: 1, attempts: 2 },
    })
    expect(branch.decompositionID).toMatch(/^[a-f0-9]{64}$/)

    const work = (await HarnessBlueprint.lease(contract, 4)).leases
    expect(work).toHaveLength(2)
    expect(new Set(work.map((item) => item.goalID)).size).toBe(2)
    const closed = await Promise.all(
      work.map((lease, index) => HarnessBlueprint.record(direct(contract, lease, `child-${index}`), contract)),
    )
    expect(closed.at(-1)!.state.summary).toMatchObject({ status: "proved", proved: 3, goals: 3 })

    const report = HarnessReport.compile({
      contract,
      evaluations: [],
      blueprint: closed.at(-1)!.state.summary,
    })
    expect(report.execution.formal?.blueprint?.status).toBe("proved")
    expect(report.execution.formal?.status).toBeUndefined()
    const foreign = HarnessContract.Info.parse({
      ...contract,
      runID: `${contract.runID}-foreign`,
      sessionID: `${contract.sessionID}-foreign`,
    })
    expect(() =>
      HarnessReport.compile({ contract: foreign, evaluations: [], blueprint: closed.at(-1)!.state.summary }),
    ).toThrow("different harness contract")
    expect(await HarnessBlueprint.context(contract.sessionID)).toContain(
      "never replaces the canonical formal-proof-v1 receipt",
    )
  })

  test("retains rejected decompositions and derives exhaustion from frozen budgets", async () => {
    const contract = await HarnessAdapter.bind(task("blueprint-reject", { attempts: 1, refinements: 0 }))
    await HarnessBlueprint.initialize(contract)
    const root = (await HarnessBlueprint.lease(contract, 1)).leases[0]!
    await HarnessBlueprint.record(direct(contract, root, "root-fail", { claim: "failure" }), contract)
    const lease = (await HarnessBlueprint.lease(contract, 1)).leases[0]!
    const placeholders = decompose(contract, lease, "wrong-placeholders", [child("harder")])
    placeholders.verification.placeholderDeclarations = ["OpenScience.substituted"]
    await expect(HarnessBlueprint.record(placeholders, contract)).rejects.toThrow("exactly equal")
    const rejected = await HarnessBlueprint.record(
      decompose(contract, lease, "bad-split", [child("harder")], { easier: false }),
      contract,
    )
    expect(rejected.decompositionID).toBeUndefined()
    expect(rejected.state).toMatchObject({
      summary: { status: "exhausted", attempts: 2, rejected: 2, decompositions: 0 },
    })
    expect(rejected.state.attempts[1]).toMatchObject({
      result: "rejected",
      failures: ["reviewer rejected decomposition difficulty reduction"],
    })
    expect((await HarnessBlueprint.lease(contract, 1)).leases).toHaveLength(0)
  })

  test("reuses shared goals and refines a blocked branch without mutating it", async () => {
    const contract = await HarnessAdapter.bind(task("blueprint-refine", { attempts: 1, refinements: 1 }))
    await HarnessBlueprint.initialize(contract)
    const root = (await HarnessBlueprint.lease(contract, 1)).leases[0]!
    await HarnessBlueprint.record(direct(contract, root, "root-fail", { claim: "failure" }), contract)
    const firstLease = (await HarnessBlueprint.lease(contract, 1)).leases[0]!
    const first = await HarnessBlueprint.record(
      decompose(contract, firstLease, "first-branch", [child("shared"), child("false-helper")]),
      contract,
    )
    const work = (await HarnessBlueprint.lease(contract, 4)).leases
    const falseID = first.state.goals.find((item) => item.declaration === "OpenScience.false-helper")!.id
    const sharedID = first.state.goals.find((item) => item.declaration === "OpenScience.shared")!.id
    const falseLease = work.find((item) => item.goalID === falseID)!
    const sharedLease = work.find((item) => item.goalID === sharedID)!
    await HarnessBlueprint.record(direct(contract, falseLease, "false-helper", { claim: "refutation" }), contract)

    const refineLease = (await HarnessBlueprint.lease(contract, 1)).leases[0]!
    const refined = await HarnessBlueprint.record(
      decompose(contract, refineLease, "second-branch", [child("shared"), child("good-helper")]),
      contract,
    )
    expect(refined.state.summary).toMatchObject({ goals: 4, decompositions: 2, refinements: 1 })
    const uses = refined.state.decompositions.filter((item) => item.childIDs.includes(sharedID))
    expect(uses).toHaveLength(2)

    const goodLease = (await HarnessBlueprint.lease(contract, 4)).leases[0]!
    await Promise.all([
      HarnessBlueprint.record(direct(contract, sharedLease, "shared"), contract),
      HarnessBlueprint.record(direct(contract, goodLease, "good-helper"), contract),
    ])
    const closed = await HarnessBlueprint.read(contract.sessionID)
    expect(closed.summary).toMatchObject({ status: "proved", goals: 4, proved: 3, refuted: 1, refinements: 1 })
    expect(closed.decompositions.map((item) => item.status).toSorted()).toEqual(["blocked", "closed"])
  })

  test("rejects cycles, substituted verifiers, consumed leases, and persisted tampering", async () => {
    const contract = await HarnessAdapter.bind(task("blueprint-adversarial", { attempts: 1, refinements: 1 }))
    await HarnessBlueprint.initialize(contract)
    const root = (await HarnessBlueprint.lease(contract, 1)).leases[0]!
    const changed = direct(contract, root, "changed-compiler", { claim: "failure" })
    changed.verification.compilerArtifactSHA256 = hash("substituted-compiler")
    await expect(HarnessBlueprint.record(changed, contract)).rejects.toThrow("frozen Lean compiler")
    await HarnessBlueprint.record(direct(contract, root, "root-fail", { claim: "failure" }), contract)
    await expect(HarnessBlueprint.record(direct(contract, root, "replay"), contract)).rejects.toThrow("consumed")

    const split = (await HarnessBlueprint.lease(contract, 1)).leases[0]!
    await HarnessBlueprint.record(decompose(contract, split, "root-child", [child("cycle")]), contract)
    const cycle = (await HarnessBlueprint.lease(contract, 1)).leases[0]!
    await HarnessBlueprint.record(direct(contract, cycle, "cycle-fail", { claim: "failure" }), contract)
    const cycleLease = (await HarnessBlueprint.lease(contract, 1)).leases[0]!
    const rootSpec = {
      statementSHA256: contract.formalProof!.statementSHA256,
      declaration: contract.formalProof!.declaration,
      module: contract.formalProof!.module,
    }
    const rejected = await HarnessBlueprint.record(decompose(contract, cycleLease, "cycle-root", [rootSpec]), contract)
    expect(rejected.decompositionID).toBeUndefined()
    expect(rejected.state.attempts.at(-1)).toMatchObject({
      result: "rejected",
      failures: ["decomposition would make the proof blueprint cyclic"],
    })

    const current = await HarnessBlueprint.state(contract.sessionID)
    const attempt = Object.values(current.attempts)[0]!
    const file = path.join(Global.Path.data, "harness", "blueprints", `${encodeURIComponent(contract.sessionID)}.json`)
    await Bun.write(
      file,
      JSON.stringify({
        ...current,
        attempts: { ...current.attempts, [attempt.id]: { ...attempt, artifactSHA256: hash("tampered-artifact") } },
      }),
    )
    await expect(HarnessBlueprint.read(contract.sessionID)).rejects.toThrow("attempt identity")

    expect(() =>
      HarnessContract.FormalProof.parse({
        ...protocol(),
        blueprint: { ...protocol().blueprint!, compilerArtifactSHA256: hash("another-compiler") },
      }),
    ).toThrow("frozen Lean kernel")
  })

  test("serializes competing leases and protects the blueprint API with evaluator capability", async () => {
    const contract = await HarnessAdapter.bind(task("blueprint-routes", { parallel: 2 }))
    const app = HarnessRoutes()
    const init = await app.request("/proofs/blueprints", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: contract.sessionID, evaluatorToken: evaluator }),
    })
    expect(init.status).toBe(200)
    expect(HarnessBlueprint.View.parse(await init.json()).summary.goals).toBe(1)

    const competing = await Promise.all(Array.from({ length: 6 }, () => HarnessBlueprint.lease(contract, 2)))
    const leases = competing.flatMap((item) => item.leases)
    expect(leases).toHaveLength(1)
    expect(new Set(leases.map((item) => item.id)).size).toBe(1)
    await expect(
      HarnessAdapter.authorize(contract.sessionID, "wrong-blueprint-evaluator-token-00000000000000"),
    ).rejects.toThrow("capability was rejected")

    const status = await app.request("/proofs/blueprints/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: contract.sessionID, evaluatorToken: evaluator }),
    })
    expect(status.status).toBe(200)
    expect(HarnessBlueprint.View.parse(await status.json()).summary.openLeases).toBe(1)
  })

  test("expires abandoned work and issues a fresh revision-bound lease", async () => {
    const contract = await HarnessAdapter.bind(task("blueprint-expiry", { leaseMs: 1_000 }))
    await HarnessBlueprint.initialize(contract)
    const stale = (await HarnessBlueprint.lease(contract, 1)).leases[0]!
    await Bun.sleep(1_050)
    await expect(HarnessBlueprint.record(direct(contract, stale, "too-late"), contract)).rejects.toThrow("expired")
    const fresh = (await HarnessBlueprint.lease(contract, 1)).leases[0]!
    expect(fresh.id).not.toBe(stale.id)
    const state = await HarnessBlueprint.read(contract.sessionID)
    expect(state.leases.map((item) => item.status)).toEqual(["expired", "open"])
  })
})

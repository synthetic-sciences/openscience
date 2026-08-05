import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { HarnessBenchmark } from "../../src/session/harness/benchmark"
import { HarnessDomain } from "../../src/session/harness/domain"
import { HarnessOrchestrator } from "../../src/session/harness/orchestrator"
import { HarnessRoutes } from "../../src/server/routes/harness"

const sessionID = "route-harness-adapter"
const token = "route-evaluator-capability-token-000000000000000000"
const skill = "route-harness-skill"
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")

afterEach(async () => {
  await Promise.all(
    ["bindings", "contracts", "evaluations", "orchestration"].map((name) =>
      fs.rm(path.join(Global.Path.data, "harness", name, `${encodeURIComponent(sessionID)}.json`), { force: true }),
    ),
  )
  await fs.rm(path.join(Global.Path.data, "harness", "audits", encodeURIComponent(sessionID)), {
    recursive: true,
    force: true,
  })
  await Promise.all(
    ["learned-skill-proposals", "learned-skills"].map((name) =>
      fs.rm(path.join(Global.Path.data, name, skill), { recursive: true, force: true }),
    ),
  )
})

describe("/harness routes", () => {
  test("lists adapters, binds a run, and ingests an authenticated result", async () => {
    const app = HarnessRoutes()
    const benchmarks = await app.request("/benchmarks")
    expect(benchmarks.status).toBe(200)
    const catalog = (await benchmarks.json()) as HarnessBenchmark.Manifest[]
    expect(catalog).toHaveLength(HarnessBenchmark.Id.options.length)
    expect(catalog.find((item) => item.id === "mle")?.source).toMatchObject({
      status: "official_open",
      repository: "https://github.com/openai/mle-bench",
      revision: "507f92e1138bb6e40dac5c6ee7a6758e6424bf97",
    })
    expect(catalog.find((item) => item.id === "mle")?.recipe).toEqual({
      status: "source_verified",
      id: "mlebench-official-v1",
      schemaVersion: 1,
      checkedAt: "2026-08-05",
    })
    expect(catalog.find((item) => item.id === "genebench")?.source).toMatchObject({
      status: "official_subset",
      publicTasks: 10,
      totalTasks: 129,
    })

    const recipe = await app.request("/benchmarks/mle/recipe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipeID: "mlebench-official-v1",
        bindings: {
          competitionList: "fixtures/competitions.txt",
          dataDir: "fixtures/data",
          submissionManifest: "fixtures/submissions.jsonl",
          outputDir: "fixtures/results",
        },
      }),
    })
    expect(recipe.status).toBe(200)
    expect(await recipe.json()).toMatchObject({
      benchmark: "mle",
      recipeID: "mlebench-official-v1",
      entrypoint: "mlebench/cli.py",
      stages: [{ id: "prepare" }, { id: "grade" }],
    })

    const bound = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        runID: "route-run",
        sessionID,
        benchmark: "stats",
        version: "1",
        taskID: "chi-square-1",
        split: "validation",
        evaluator: { name: "route-evaluator", version: "1", source: "benchmark", token },
        objective: "Run and verify a chi-square analysis",
        audit: { mode: "hybrid", budget: 2, minSamples: 2 },
        metric: { name: "score", direction: "maximize" },
        model: { provider: "test", name: "model" },
        budget: { steps: 10 },
        seed: 4,
        intervention: "autonomous",
        contamination: { policy: "hidden", hiddenTestsAccessible: false },
        createdAt: Date.now(),
      }),
    })
    expect(bound.status).toBe(200)
    const contract = (await bound.json()) as {
      runID: string
      packs: Array<"statistics">
      benchmark: { name: string }
    }
    expect(contract).toMatchObject({ packs: ["statistics"], benchmark: { name: "statistics" } })
    expect(JSON.stringify(contract)).not.toContain(token)

    const started = await app.request(`/runs/${sessionID}/orchestration`, { method: "POST" })
    expect(started.status).toBe(200)
    expect(await started.json()).toMatchObject({ protocolVersion: "coalition-v1", revision: 0, status: "active" })
    const orchestration = await app.request(`/runs/${sessionID}/orchestration`)
    expect(orchestration.status).toBe(200)
    expect(await orchestration.json()).toMatchObject({ protocolVersion: "coalition-v1", revision: 0 })

    const audit = await app.request("/audits", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionID,
        evaluatorToken: token,
        subject: { type: "run", id: contract.runID, artifactSHA256: hash("route-artifact") },
        probes: [
          {
            id: "probe-a",
            commitment: hash("hidden-a"),
            features: [0],
            stratum: "a",
            weight: 1,
            priorLoss: 0.5,
          },
          {
            id: "probe-b",
            commitment: hash("hidden-b"),
            features: [1],
            stratum: "b",
            weight: 1,
            priorLoss: 0.5,
          },
        ],
      }),
    })
    expect(audit.status).toBe(200)
    const auditState = (await audit.json()) as { auditID: string }
    const selected = await app.request(`/audits/${auditState.auditID}/selection`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID, evaluatorToken: token }),
    })
    expect(selected.status).toBe(200)
    const probe = (await selected.json()) as { probeID: string }
    const observed = await app.request(`/audits/${auditState.auditID}/observations`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionID,
        evaluatorToken: token,
        probeID: probe.probeID,
        loss: 0.2,
        failure: false,
        evidence: ["route:probe-receipt"],
      }),
    })
    expect(observed.status).toBe(200)
    expect(await observed.json()).toMatchObject({ estimate: { observed: 1 }, revision: 2 })

    const checks = HarnessDomain.compose(contract.packs).map((check) => ({
      id: check.id,
      status: "passed",
      blocking: check.severity === "blocking",
      evidence: [`receipt:${check.id}`],
    }))
    const evaluated = await app.request("/evaluations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        runID: "route-run",
        sessionID,
        evaluatorToken: token,
        status: "passed",
        score: 1,
        metrics: { score: 1 },
        checks,
        evidence: ["official:receipt"],
        evaluatedAt: Date.now(),
      }),
    })
    expect(evaluated.status).toBe(200)
    expect(await evaluated.json()).toMatchObject({ evaluation: { status: "passed", score: 1 } })

    const stored = await app.request(`/runs/${sessionID}/evaluations`)
    expect(stored.status).toBe(200)
    expect((await stored.json()) as unknown[]).toHaveLength(1)
    const read = await app.request(`/runs/${sessionID}/contract`)
    expect(await read.json()).toMatchObject({ runID: "route-run" })
  })

  test("creates and lists an inactive learned skill proposal", async () => {
    const app = HarnessRoutes()
    const description = "Use when a held-out route workflow has been qualified."
    const proposed = await app.request("/skills", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: skill,
        description,
        content: `---\nname: ${skill}\ndescription: ${description}\n---\n\n# Route workflow\n`,
        origin: "conversation",
      }),
    })
    expect(proposed.status).toBe(200)
    expect(await proposed.json()).toMatchObject({ name: skill, status: "pending" })

    const listed = await app.request("/skills")
    expect(listed.status).toBe(200)
    expect(await listed.json()).toContainEqual(expect.objectContaining({ name: skill, status: "pending" }))
  })

  test("authenticates external marginal-utility checkpoints before unlocking evolution", async () => {
    const app = HarnessRoutes()
    const bound = await app.request("/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        schemaVersion: 1,
        runID: "route-adaptive-run",
        sessionID,
        benchmark: "stats",
        version: "1",
        taskID: "adaptive-1",
        split: "validation",
        evaluator: { name: "route-evaluator", version: "1", source: "benchmark", token },
        objective: "Evolve a robust statistical method",
        orchestration: {
          topology: "evolution",
          maxWorkers: 2,
          maxRounds: 2,
          minIndependentVerifiers: 2,
          adaptive: {
            protocolVersion: "marginal-utility-v1",
            minRounds: 1,
            patience: 1,
            minUtilityGain: 0.05,
            maxUncertainty: 0.05,
          },
        },
        metric: { name: "score", direction: "maximize" },
        model: { provider: "test", name: "model" },
        budget: { steps: 100 },
        seed: 4,
        intervention: "autonomous",
        contamination: { policy: "hidden", hiddenTestsAccessible: false },
        createdAt: Date.now(),
      }),
    })
    expect(bound.status).toBe(200)
    const initial = await HarnessOrchestrator.initialize(sessionID)
    const advance = async (state: HarnessOrchestrator.State): Promise<HarnessOrchestrator.State> => {
      if (state.status === "awaiting_checkpoint") return state
      const work = HarnessOrchestrator.ready(state)[0]!
      const next = await HarnessOrchestrator.complete({
        sessionID,
        workID: work.id,
        workerSessionID: `route-worker-${state.revision}`,
        result: {
          summary: work.label,
          artifactRefs: [`artifact://${work.label}`],
          evidenceRefs: [`evidence://${work.label}`],
          usage: { steps: 1 },
        },
      })
      return advance(next)
    }
    const waiting = await advance(initial)
    expect(waiting.status).toBe("awaiting_checkpoint")

    const request = (evaluatorToken: string) =>
      app.request(`/runs/${sessionID}/orchestration/checkpoints`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          evaluatorToken,
          round: 1,
          utility: 0.5,
          uncertainty: 0.01,
          evidenceRefs: ["evidence://official-round-1"],
          evaluatedAt: Date.now(),
        }),
      })
    expect((await request("wrong-evaluator-capability-token-0000000000000000000")).status).not.toBe(200)
    const checkpoint = await request(token)
    expect(checkpoint.status).toBe(200)
    const state = await checkpoint.json()
    expect(state).toMatchObject({
      status: "active",
      adaptive: { phase: "searching", checkpoints: [{ round: 1, qualified: true }] },
    })
    expect(JSON.stringify(state)).not.toContain(token)
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { HarnessDomain } from "../../src/session/harness/domain"
import { HarnessRoutes } from "../../src/server/routes/harness"

const sessionID = "route-harness-adapter"
const token = "route-evaluator-capability-token-000000000000000000"

afterEach(async () => {
  await Promise.all(
    ["bindings", "contracts", "evaluations"].map((name) =>
      fs.rm(path.join(Global.Path.data, "harness", name, `${encodeURIComponent(sessionID)}.json`), { force: true }),
    ),
  )
})

describe("/harness routes", () => {
  test("lists adapters, binds a run, and ingests an authenticated result", async () => {
    const app = HarnessRoutes()
    const benchmarks = await app.request("/benchmarks")
    expect(benchmarks.status).toBe(200)
    expect((await benchmarks.json()) as unknown[]).toHaveLength(14)

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
        split: "held_out",
        evaluator: { name: "route-evaluator", version: "1", source: "benchmark", token },
        objective: "Run and verify a chi-square analysis",
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
    const contract = (await bound.json()) as { packs: Array<"statistics">; benchmark: { name: string } }
    expect(contract).toMatchObject({ packs: ["statistics"], benchmark: { name: "statistics" } })
    expect(JSON.stringify(contract)).not.toContain(token)

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
})

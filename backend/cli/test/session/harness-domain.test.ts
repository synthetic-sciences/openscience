import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessDomain } from "../../src/session/harness/domain"
import { HarnessEvaluation } from "../../src/session/harness/evaluation"
import { HarnessPack } from "../../src/session/harness/pack"

const sessions = new Set<string>()

afterEach(async () => {
  await Promise.all(
    [...sessions].flatMap((sessionID) =>
      ["contracts", "evaluations"].map((name) =>
        fs.rm(path.join(Global.Path.data, "harness", name, `${encodeURIComponent(sessionID)}.json`), { force: true }),
      ),
    ),
  )
  sessions.clear()
})

async function bind(sessionID: string, packs?: HarnessPack.Id[]) {
  sessions.add(sessionID)
  return HarnessContract.bind({
    schemaVersion: 1,
    runID: `run-${sessionID}`,
    sessionID,
    objective: "Pass a domain benchmark without skipping methodology",
    benchmark: {
      name: "domain-test",
      version: "1",
      taskID: sessionID,
      split: "held_out",
      evaluator: "official-evaluator",
      metric: "score",
      direction: "maximize",
    },
    profile: "optimize",
    packs,
    model: { provider: "test", name: "model" },
    tools: [],
    skills: [],
    budget: { steps: 10 },
    seed: 1,
    intervention: "autonomous",
    contamination: { policy: "hidden tests stay hidden", hiddenTestsAccessible: false },
    createdAt: Date.now(),
  })
}

const checks = (packs: HarnessPack.Id[]): HarnessDomain.Actual[] =>
  HarnessDomain.compose(packs).map((check) => ({
    id: check.id,
    status: "passed" as const,
    blocking: check.severity === "blocking",
    evidence: [`evidence:${check.id}`],
  }))

function evaluation(
  sessionID: string,
  input: { status?: HarnessEvaluation.Status; checks: HarnessEvaluation.Check[] },
): HarnessEvaluation.Info {
  const status = input.status ?? "passed"
  return {
    schemaVersion: 1,
    runID: `run-${sessionID}`,
    sessionID,
    evaluator: { name: "official-evaluator", version: "1", source: "benchmark" },
    status,
    score: status === "passed" ? 1 : 0,
    metrics: { score: status === "passed" ? 1 : 0 },
    checks: input.checks,
    evidence: ["report:domain"],
    evaluatedAt: Date.now(),
  }
}

describe("domain verification packs", () => {
  test("publishes exactly the seven typed domain packs", () => {
    expect(Object.keys(HarnessDomain.catalog).toSorted()).toEqual(HarnessPack.Id.options.toSorted())
    for (const pack of Object.values(HarnessDomain.catalog)) expect(HarnessDomain.Info.parse(pack)).toEqual(pack)
  })

  test("gives every pack at least one blocking methodology gate", () => {
    for (const pack of Object.values(HarnessDomain.catalog)) {
      expect(pack.checks.some((check) => check.severity === "blocking")).toBe(true)
    }
  })

  test("composes shared ML and forecast gates without collisions", () => {
    const combined = HarnessDomain.compose(["ml", "forecast"])
    expect(combined.filter((check) => check.id === "held-out")).toHaveLength(1)
    expect(combined.filter((check) => check.id === "baseline")).toHaveLength(1)
    expect(new Set(combined.map((check) => check.id)).size).toBe(combined.length)
  })

  test("reports every missing blocking check", () => {
    const audit = HarnessDomain.audit(["statistics"], [])
    expect(audit.missing.map((check) => check.id)).toEqual(
      expect.arrayContaining(["estimand", "assumptions", "effect-size", "uncertainty", "multiplicity", "stat-replay"]),
    )
    expect(audit.advisory.map((check) => check.id)).toEqual(["sensitivity"])
  })

  test("rejects present checks that fail or remain inconclusive", () => {
    const actual = checks(["pde"])
    actual.find((check) => check.id === "pde-convergence")!.status = "failed"
    expect(HarnessDomain.audit(["pde"], actual).failed).toEqual([
      expect.objectContaining({ reason: "status:failed", check: expect.objectContaining({ id: "pde-convergence" }) }),
    ])
  })

  test("requires evidence and blocking posture for contract gates", () => {
    const actual = checks(["chemistry"])
    actual.find((check) => check.id === "chem-identity")!.evidence = []
    actual.find((check) => check.id === "chem-valence")!.blocking = false
    expect(HarnessDomain.audit(["chemistry"], actual).failed.map((item) => item.reason)).toEqual(
      expect.arrayContaining(["missing-evidence", "not-marked-blocking"]),
    )
  })

  test("fails closed on duplicate evaluator check IDs", () => {
    const actual = checks(["physics"])
    actual.push(structuredClone(actual[0]!))
    expect(() => HarnessDomain.assert(["physics"], actual)).toThrow("duplicate")
  })

  test("passes a complete evidence-backed composed portfolio", () => {
    const actual = checks(["biology", "statistics"])
    const audit = HarnessDomain.assert(["biology", "statistics"], actual)
    expect(audit.missing).toEqual([])
    expect(audit.failed).toEqual([])
  })

  test("rejects a passed external evaluation with an omitted domain gate", async () => {
    await bind("domain-eval-missing", ["ml"])
    const actual = checks(["ml"]).filter((check) => check.id !== "ml-leakage")
    await expect(HarnessEvaluation.record(evaluation("domain-eval-missing", { checks: actual }))).rejects.toThrow(
      "ml-leakage:missing",
    )
  })

  test("records failed evaluations even when the run stopped before every gate", async () => {
    await bind("domain-eval-failed", ["pde"])
    const result = await HarnessEvaluation.record(
      evaluation("domain-eval-failed", {
        status: "failed",
        checks: [{ id: "pde-stability", status: "failed", blocking: true, evidence: ["solver:diverged"] }],
      }),
    )
    expect(result.status).toBe("failed")
  })

  test("keeps contracts without packs backward compatible", async () => {
    await bind("domain-eval-generic")
    const result = await HarnessEvaluation.record(
      evaluation("domain-eval-generic", {
        checks: [{ id: "generic", status: "passed", blocking: true, evidence: ["report:generic"] }],
      }),
    )
    expect(result.status).toBe("passed")
  })

  test.each([
    ["research", "react", "Compute a chi-square test and effect size for this table.", ["statistics"]],
    ["biology", "react", "Analyze this gene expression cohort and compare groups.", ["biology"]],
    ["physics", "theory", "Derive the theoretical field equations.", ["physics"]],
    ["physics", "numerical", "Simulate this PDE with finite elements.", ["physics", "pde"]],
    ["research", "react", "Model molecular properties for these compounds.", ["chemistry"]],
    ["ml", "training", "Train this model with SFT.", ["ml"]],
    ["ml", "forecast", "Evaluate this weather forecast model.", ["ml", "forecast"]],
  ] as const)("recommends bounded packs for %s/%s", (agent, profile, text, expected) => {
    expect(HarnessDomain.recommend({ agent, profile, text })).toEqual([...expected])
  })

  test("does not turn simple definitions or lookups into methodology workflows", () => {
    expect(
      HarnessDomain.recommend({ agent: "research", profile: "react", text: "What is a chi-square test?" }),
    ).toEqual([])
    expect(HarnessDomain.recommend({ agent: "biology", profile: "react", text: "Look up TP53." })).toEqual([])
  })

  test("uses immutable contract packs instead of heuristic recommendations", async () => {
    await bind("domain-contract-route", ["chemistry"])
    expect(
      await HarnessDomain.resolve({
        sessionID: "domain-contract-route",
        agent: "ml",
        profile: "forecast",
        text: "Evaluate a weather forecast model.",
      }),
    ).toEqual({ ids: ["chemistry"], source: "contract" })
  })

  test("renders a complete bounded checklist with stable IDs", () => {
    const prompt = HarnessDomain.prompt({ ids: HarnessPack.Id.options, source: "contract" })
    expect(prompt.length).toBeLessThan(12_000)
    expect(prompt).toContain("pde-convergence")
    expect(prompt).toContain("chem-split")
    expect(prompt).toContain("forecast-leads")
    expect(prompt.endsWith("</domain-verification>")).toBe(true)
  })

  test("rejects duplicate packs in the immutable contract", async () => {
    await expect(bind("domain-duplicate-pack", ["ml", "ml"])).rejects.toThrow("packs must be unique")
  })
})

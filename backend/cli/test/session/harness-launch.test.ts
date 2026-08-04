import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { HarnessRoutes } from "../../src/server/routes/harness"
import { HarnessAdapter } from "../../src/session/harness/adapter"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessDomain } from "../../src/session/harness/domain"
import { HarnessLaunch } from "../../src/session/harness/launch"
import { HarnessOrchestrator } from "../../src/session/harness/orchestrator"
import { HarnessReport } from "../../src/session/harness/report"
import { HarnessSearch } from "../../src/session/harness/search"
import { launchProtocol, launchSubmit } from "../fixture/harness"

const sessions = new Set<string>()
const token = "launch-evaluator-capability-token-00000000000000000"

afterEach(async () => {
  await Promise.all(
    [...sessions].flatMap((sessionID) =>
      ["bindings", "contracts", "evaluations", "launches", "orchestration", "search"].map((name) =>
        fs.rm(path.join(Global.Path.data, "harness", name, `${encodeURIComponent(sessionID)}.json`), { force: true }),
      ),
    ),
  )
  await fs.rm(path.join(Global.Path.data, "harness", "retrospectives"), { recursive: true, force: true })
  sessions.clear()
})

function task(sessionID: string): HarnessAdapter.Task {
  sessions.add(sessionID)
  return HarnessAdapter.Task.parse({
    schemaVersion: 1,
    runID: `run-${sessionID}`,
    sessionID,
    benchmark: "mle",
    version: "2026.08",
    taskID: "official-task-1",
    split: "held_out",
    evaluator: { name: "official-runner", version: "3", source: "benchmark", token },
    objective: "Improve the exact official benchmark without weakening its evaluator",
    launch: launchProtocol("mle"),
    metric: { name: "score", direction: "maximize" },
    model: { provider: "test", name: "model" },
    tools: ["read", "bash"],
    skills: [],
    budget: { steps: 30, candidates: 2 },
    seed: 29,
    intervention: "autonomous",
    contamination: { policy: "hidden evaluator remains external", hiddenTestsAccessible: false },
    createdAt: Date.now(),
  })
}

function evaluation(contract: HarnessContract.Info, receiptID?: string) {
  const checks = HarnessDomain.compose(contract.packs ?? []).map((check) => ({
    id: check.id,
    status: "passed" as const,
    blocking: check.severity === "blocking",
    evidence: [`evidence:${check.id}`],
  }))
  return HarnessAdapter.Evaluation.parse({
    schemaVersion: 1,
    runID: contract.runID,
    sessionID: contract.sessionID,
    evaluatorToken: token,
    launchReceiptID: receiptID,
    status: "passed",
    score: 0.8,
    metrics: { score: 0.8 },
    checks,
    evidence: ["official:held-out-score.json"],
    evaluatedAt: Date.now(),
  })
}

describe("official benchmark launch readiness", () => {
  test("distinguishes methodology adapters from runnable held-out integrations", () => {
    const input = task("launch-required")
    delete input.launch
    expect(() => HarnessAdapter.Task.parse(input)).toThrow("pinned official benchmark launch protocol")
    expect(() =>
      HarnessContract.Launch.parse({
        ...launchProtocol("unpinned"),
        runner: { ...launchProtocol("unpinned").runner, revision: "main" },
      }),
    ).toThrow()
  })

  test("blocks search and orchestration until the complete launch suite passes", async () => {
    const contract = await HarnessAdapter.bind(task("launch-gate"))
    await expect(HarnessSearch.initialize({ sessionID: contract.sessionID })).rejects.toThrow("launch readiness")
    await expect(HarnessOrchestrator.initialize(contract.sessionID)).rejects.toThrow("launch readiness")

    const input = launchSubmit(contract, token)
    const failed = await HarnessLaunch.record(
      {
        ...input,
        checks: input.checks.map((check) =>
          check.id === "hidden_boundary" ? { ...check, status: "failed" as const } : check,
        ),
      },
      contract,
    )
    expect(failed.status).toBe("failed")
    expect(failed.failures).toContain("launch-check:hidden_boundary")
    await expect(HarnessSearch.initialize({ sessionID: contract.sessionID })).rejects.toThrow("launch readiness")

    const receipt = await HarnessLaunch.record(input, contract)
    expect(receipt).toMatchObject({ status: "passed", baselineDelta: 0 })
    expect(receipt.validator).toEqual(input.validator)
    expect(receipt.checks.map((check) => check.id).toSorted()).toEqual(HarnessContract.LaunchCheck.options.toSorted())
    expect(JSON.stringify(receipt)).not.toContain(token)
    expect((await HarnessLaunch.record(input, contract)).receiptID).toBe(receipt.receiptID)
    expect((await HarnessSearch.initialize({ sessionID: contract.sessionID })).status).toBe("active")
    expect((await HarnessOrchestrator.initialize(contract.sessionID)).status).toBe("active")
  })

  test("derives baseline replay failure and gates final benchmark success", async () => {
    const contract = await HarnessAdapter.bind(task("launch-evaluation"))
    const failed = await HarnessLaunch.record({ ...launchSubmit(contract, token), baselineScore: 0.7 }, contract)
    expect(failed).toMatchObject({ status: "failed", baselineDelta: 0.19999999999999996 })
    await expect(HarnessAdapter.ingest(evaluation(contract))).rejects.toThrow("must reference")
    await expect(HarnessAdapter.ingest(evaluation(contract, failed.receiptID))).rejects.toThrow("passing launch")

    const receipt = await HarnessLaunch.record(launchSubmit(contract, token), contract)
    const result = await HarnessAdapter.ingest(evaluation(contract, receipt.receiptID))
    expect(result.evaluation).toMatchObject({ status: "passed", launchReceiptID: receipt.receiptID })
    const report = HarnessReport.compile({ contract, evaluations: [result.evaluation] })
    const changed = HarnessContract.Info.parse({
      ...contract,
      launch: {
        ...contract.launch!,
        runner: { ...contract.launch!.runner, revision: "f".repeat(40) },
      },
    })
    expect(report.quality.launchReceiptID).toBe(receipt.receiptID)
    expect(HarnessReport.compile({ contract: changed, evaluations: [] }).comparisonKey).not.toBe(report.comparisonKey)
  })

  test("rejects protocol substitution, future claims, and post-hoc receipt timing", async () => {
    const contract = await HarnessAdapter.bind(task("launch-substitution"))
    const input = launchSubmit(contract, token)
    await expect(
      HarnessLaunch.record(
        {
          ...input,
          protocol: {
            ...input.protocol,
            runner: { ...input.protocol.runner, commandSHA256: "f".repeat(64) },
          },
        },
        contract,
      ),
    ).rejects.toThrow("immutable harness contract")
    await expect(
      HarnessLaunch.record(
        {
          ...input,
          validator: { ...input.validator, scriptSHA256: "f".repeat(64) },
        },
        contract,
      ),
    ).rejects.toThrow("validator does not match")
    await expect(HarnessLaunch.record({ ...input, evaluatedAt: Date.now() + 600_000 }, contract)).rejects.toThrow(
      "future-dated",
    )
    const receipt = await HarnessLaunch.record(input, contract)
    await expect(
      HarnessAdapter.ingest({ ...evaluation(contract, receipt.receiptID), evaluatedAt: receipt.evaluatedAt - 1 }),
    ).rejects.toThrow("predates its referenced launch receipt")
  })

  test("fails closed on storage tampering and protects receipt reads with the evaluator capability", async () => {
    const contract = await HarnessAdapter.bind(task("launch-route"))
    const app = HarnessRoutes()
    const recorded = await app.request("/launches/receipts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(launchSubmit(contract, token)),
    })
    expect(recorded.status).toBe(200)
    const receipt = (await recorded.json()) as HarnessLaunch.Info

    const denied = await app.request(`/launches/receipts/${receipt.receiptID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: contract.sessionID, evaluatorToken: "x".repeat(48) }),
    })
    expect(denied.status).not.toBe(200)
    const read = await app.request(`/launches/receipts/${receipt.receiptID}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionID: contract.sessionID, evaluatorToken: token }),
    })
    expect(read.status).toBe(200)
    expect(await read.json()).toMatchObject({ receiptID: receipt.receiptID, status: "passed" })

    const target = path.join(Global.Path.data, "harness", "launches", `${encodeURIComponent(contract.sessionID)}.json`)
    const state = (await Bun.file(target).json()) as {
      items: Record<string, HarnessLaunch.Info>
      order: string[]
    }
    const forged = { ...receipt, status: "failed" as const }
    const payload = structuredClone(forged) as Record<string, unknown>
    delete payload.receiptID
    const receiptID = new Bun.CryptoHasher("sha256").update(JSON.stringify(payload)).digest("hex")
    state.items = { [receiptID]: { ...forged, receiptID } }
    state.order = [receiptID]
    await Bun.write(target, JSON.stringify(state))
    await expect(HarnessLaunch.list(contract.sessionID)).rejects.toThrow("outcome derivation drifted")
  })
})

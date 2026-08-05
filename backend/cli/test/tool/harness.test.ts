import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessEvaluation } from "../../src/session/harness/evaluation"
import { HarnessMemory } from "../../src/session/harness/memory"
import { HarnessSearch } from "../../src/session/harness/search"
import { HarnessTool } from "../../src/tool/harness"

const sessionID = "harness-tool-session"
const hash = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex")
const context = {
  sessionID,
  messageID: "message",
  callID: "call",
  agent: "research",
  abort: new AbortController().signal,
  messages: [],
  metadata() {},
  async ask() {},
}

afterEach(async () => {
  await Promise.all(
    ["contracts", "evaluations", "search", "orchestration"].map((name) =>
      fs.rm(path.join(Global.Path.data, "harness", name, `${encodeURIComponent(sessionID)}.json`), { force: true }),
    ),
  )
  await fs.rm(path.join(Global.Path.data, "harness", "retrospectives"), { recursive: true, force: true })
})

async function bind() {
  return HarnessContract.bind({
    schemaVersion: 1,
    runID: "run-harness-tool",
    sessionID,
    objective: "Maximize the official score",
    benchmark: {
      name: "pde",
      version: "1",
      taskID: "task",
      split: "held_out",
      evaluator: "official-evaluator",
      metric: "score",
      direction: "maximize",
      target: 0.9,
    },
    profile: "optimize",
    model: { provider: "test", name: "model" },
    tools: ["harness"],
    skills: [],
    budget: { candidates: 2, wallTimeMs: 60_000 },
    seed: 3,
    intervention: "autonomous",
    contamination: { policy: "hidden tests stay hidden", hiddenTestsAccessible: false },
    createdAt: Date.now(),
  })
}

describe("harness tool", () => {
  test("exposes persisted provisional coalition work without evaluator authority", async () => {
    await bind()
    const tool = await HarnessTool.init()
    const started = await tool.execute({ action: "coalition_start" }, context)
    const state = JSON.parse(started.output)
    expect(state).toMatchObject({ status: "active", minIndependentVerifiers: 1, revision: 0 })
    expect(state.ready.length).toBeGreaterThan(0)
    expect(state.ready.length).toBeLessThanOrEqual(state.maxWorkers)

    const work = state.ready[0]
    const completed = await tool.execute(
      {
        action: "coalition_complete",
        work_id: work.id,
        worker_session_id: "fresh-child-session",
        result_summary: "produced a bounded proposal",
        artifact_refs: ["artifact://proposal"],
        evidence_refs: ["evidence://trace"],
      },
      context,
    )
    expect(completed.metadata).toMatchObject({ workID: work.id, provisional: true, revision: 1 })
    expect(JSON.parse(completed.output).revision).toBe(1)
    expect(tool.parameters.safeParse({ action: "coalition_verify", work_id: work.id }).success).toBe(false)
  })

  test("exposes resumable candidate control without an agent verification action", async () => {
    await bind()
    const tool = await HarnessTool.init()
    const started = await tool.execute({ action: "start", stall: 2 }, context)
    expect(JSON.parse(started.output)).toMatchObject({
      status: "active",
      budget: { candidates: 2, wallTimeMs: 60_000, stall: 2 },
      used: 0,
    })

    const proposed = await tool.execute(
      {
        action: "propose",
        branch: "baseline",
        proposal: "baseline candidate",
        artifact_uri: "artifact://baseline",
        artifact_sha256: hash("baseline"),
      },
      context,
    )
    const candidateID = proposed.metadata.candidateID as string
    expect(proposed.metadata).toMatchObject({ accepted: true, candidateID })

    const duplicate = await tool.execute(
      {
        action: "propose",
        parent_ids: [hash("fabricated-parent")],
        inspiration_ids: [hash("fabricated-inspiration")],
        branch: "renamed",
        proposal: "same bytes under a different wrapper",
        artifact_uri: "artifact://baseline-mirror",
        artifact_sha256: hash("baseline"),
      },
      context,
    )
    expect(duplicate.metadata).toMatchObject({ accepted: true, deduplicated: true, candidateID })

    const observed = await tool.execute(
      {
        action: "observe",
        candidate_id: candidateID,
        status: "passed",
        score: 999,
        metrics: { proxy: 999 },
        feedback: "provisional feedback stays visibly unverified",
      },
      context,
    )
    expect(observed.title).toBe("Unverified observation recorded")
    expect(observed.metadata).toMatchObject({ verified: false })
    expect("bestID" in JSON.parse(observed.output)).toBe(false)
    expect(tool.parameters.safeParse({ action: "verify", candidate_id: candidateID }).success).toBe(false)

    const checkpoint = await tool.execute({ action: "status" }, context)
    expect(JSON.parse(checkpoint.output)).toMatchObject({
      revision: 2,
      candidates: [
        {
          id: candidateID,
          proposal: "baseline candidate",
          artifact: { uri: "artifact://baseline", sha256: hash("baseline") },
          source: "observed",
          score: 999,
          metrics: { proxy: 999 },
          feedback: "provisional feedback stays visibly unverified",
        },
      ],
    })
  })

  test("surfaces external hindsight only after backend verification", async () => {
    await bind()
    const tool = await HarnessTool.init()
    await tool.execute({ action: "start" }, context)
    const proposed = await tool.execute(
      {
        action: "propose",
        branch: "stable",
        proposal: "conservative spectral step",
        artifact_uri: "artifact://spectral",
        artifact_sha256: hash("spectral"),
      },
      context,
    )
    const candidateID = proposed.metadata.candidateID as string
    await HarnessEvaluation.record({
      schemaVersion: 1,
      runID: "run-harness-tool",
      sessionID,
      subject: { type: "candidate", id: candidateID },
      evaluator: { name: "official-evaluator", version: "1", source: "benchmark" },
      status: "passed",
      score: 0.91,
      metrics: { score: 0.91 },
      checks: [{ id: "official", status: "passed", blocking: true, evidence: ["metric:score"] }],
      evidence: ["report:official"],
      evaluatedAt: Date.now(),
      notes: "passed the held-out stability gate",
    })
    const state = await HarnessSearch.verify({ sessionID, candidateID })
    expect(state).toMatchObject({ status: "completed", stopReason: "objective_met", bestID: candidateID })
    await HarnessMemory.capture({ sessionID, candidateID, stage: "evaluation" })

    const hindsight = await tool.execute(
      { action: "hindsight", query: "spectral stability", stage: "planning" },
      context,
    )
    expect(hindsight.title).toBe("Verified hindsight")
    expect(hindsight.output).toContain("conservative spectral step")
    expect(hindsight.output).toContain("passed the held-out stability gate")
  })
})

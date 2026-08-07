import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessEvaluation } from "../../src/session/harness/evaluation"
import { HarnessMemory } from "../../src/session/harness/memory"
import { HarnessOrchestrator } from "../../src/session/harness/orchestrator"
import { HarnessSearch } from "../../src/session/harness/search"
import { HarnessTool } from "../../src/tool/harness"
import { TaskParameters } from "../../src/tool/task"

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
    ["contracts", "evaluations", "search", "orchestration", "worlds"].map((name) =>
      fs.rm(path.join(Global.Path.data, "harness", name, `${encodeURIComponent(sessionID)}.json`), { force: true }),
    ),
  )
  await fs.rm(path.join(Global.Path.data, "harness", "retrospectives"), { recursive: true, force: true })
})

async function bind(orchestration?: HarnessContract.Orchestration) {
  return HarnessContract.bind({
    schemaVersion: 1,
    runID: "run-harness-tool",
    sessionID,
    objective: "Maximize the official score",
    benchmark: {
      name: "pde",
      title: "PDE evaluation",
      family: "physics",
      task: "Improve and verify a numerical PDE solution",
      version: "1",
      taskID: "task",
      split: "held_out",
      evaluator: "official-evaluator",
      metric: "score",
      direction: "maximize",
      target: 0.9,
    },
    profile: "optimize",
    ...(orchestration ? { orchestration } : {}),
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

const turns: string[] = []
const attest = async (
  work: { id: string; agent: HarnessOrchestrator.WorkerReceipt["agent"]; prompt: string },
  worker: string,
) => {
  const state = await HarnessOrchestrator.read(sessionID)
  const completedAt = Date.now()
  return HarnessOrchestrator.attest({
    sessionID,
    workID: work.id,
    workerSessionID: worker,
    turnID: `harness-tool-turn-${turns.push(work.id)}`,
    agent: work.agent,
    prompt: `Execute:\n${work.prompt}`,
    outcome: "completed",
    usage: { steps: 1, tokens: 100, costUSD: 0.01, wallTimeMs: 10 },
    toolCalls: 1,
    failedToolCalls: 0,
    startedAt: Math.max(state.createdAt, completedAt - 10),
    completedAt,
  })
}

describe("harness tool", () => {
  test("exposes persisted provisional coalition work without evaluator authority", async () => {
    await bind()
    const tool = await HarnessTool.init()
    const started = await tool.execute({ action: "coalition_start" }, context)
    const state = JSON.parse(started.output)
    expect(state).toMatchObject({
      status: "active",
      workerPolicy: "task-attested-v1",
      minIndependentVerifiers: 1,
      revision: 0,
    })
    expect(state.ready.length).toBeGreaterThan(0)
    expect(state.ready.length).toBeLessThanOrEqual(state.maxWorkers)

    const work = state.ready[0]
    await attest(work, "fresh-child-session")
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
    expect(completed.metadata).toMatchObject({ workID: work.id, provisional: true, revision: 2 })
    expect(JSON.parse(completed.output).revision).toBe(2)
    expect(tool.parameters.safeParse({ action: "coalition_verify", work_id: work.id }).success).toBe(false)

    expect(
      TaskParameters.safeParse({
        description: "Execute coalition work",
        prompt: work.prompt,
        subagent_type: work.agent,
        harness_work_id: work.id,
      }).success,
    ).toBe(true)
    expect(
      TaskParameters.safeParse({
        description: "Execute coalition work",
        prompt: work.prompt,
        subagent_type: work.agent,
        harness_work_id: "fabricated",
      }).success,
    ).toBe(false)
  })

  test("carries verifier severity through the tool and exposes backend-owned repair routing", async () => {
    await bind({
      topology: "verifier_loop",
      maxWorkers: 2,
      maxRounds: 1,
      minIndependentVerifiers: 2,
      repair: { protocolVersion: "verifier-routed-v1", minConfidence: 0.7 },
    })
    const tool = await HarnessTool.init()
    const started = JSON.parse((await tool.execute({ action: "coalition_start" }, context)).output)
    expect(started).toMatchObject({
      protocolVersion: "coalition-v3",
      topology: "verifier_loop",
      repair: { protocolVersion: "verifier-routed-v1", phase: "producing", routes: [] },
    })
    const author = started.ready[0]
    await attest(author, "repair-tool-author")
    const proposed = JSON.parse(
      (
        await tool.execute(
          {
            action: "coalition_complete",
            work_id: author.id,
            worker_session_id: "repair-tool-author",
            result_summary: "candidate",
            artifact_refs: ["artifact://candidate"],
          },
          context,
        )
      ).output,
    )
    expect(proposed.repair).toMatchObject({ phase: "verifying" })
    expect(proposed.ready).toHaveLength(2)

    const verify = async (work: (typeof proposed.ready)[number], worker: string) => {
      await attest(work, worker)
      return JSON.parse(
        (
          await tool.execute(
            {
              action: "coalition_complete",
              work_id: work.id,
              worker_session_id: worker,
              result_summary: "independent support",
              evidence_refs: [`evidence://${worker}`],
              verdict: "support",
              verdict_severity: "none",
              verdict_confidence: 0.9,
              verdict_checks: [
                { id: "observable-check", status: "passed", evidence_refs: [`evidence://${worker}/check`] },
              ],
            },
            context,
          )
        ).output,
      )
    }
    const first = await verify(proposed.ready[0], "repair-tool-verifier-a")
    const settled = await verify(first.ready[0], "repair-tool-verifier-b")
    expect(settled).toMatchObject({
      status: "completed",
      repair: { phase: "completed", stopReason: "accepted", routes: [{ decision: "accept" }] },
      consensus: { status: "supported", verifierCount: 2, support: 2 },
    })
  })

  test("publishes the exact Task session contract for persistent producer lanes", async () => {
    await bind({ topology: "evolution", maxWorkers: 2, maxRounds: 1, minIndependentVerifiers: 1 })
    const tool = await HarnessTool.init()
    const started = JSON.parse((await tool.execute({ action: "coalition_start" }, context)).output)
    expect(started).toMatchObject({ sessionPolicy: "producer-lanes-v1", topology: "evolution" })
    expect(
      started.ready.map((work: { lane?: string; resumeSessionID?: string }) => [work.lane, work.resumeSessionID]),
    ).toEqual([
      ["producer-a", undefined],
      ["producer-b", undefined],
    ])

    const complete = async (
      state: {
        ready: Array<{
          id: string
          label: string
          agent: HarnessOrchestrator.WorkerReceipt["agent"]
          prompt: string
        }>
      },
      worker: string,
    ) => {
      await attest(state.ready[0]!, worker)
      return JSON.parse(
        (
          await tool.execute(
            {
              action: "coalition_complete",
              work_id: state.ready[0]!.id,
              worker_session_id: worker,
              result_summary: state.ready[0]!.label,
              artifact_refs: [`artifact://${state.ready[0]!.label}`],
              evidence_refs: [`evidence://${state.ready[0]!.label}`],
            },
            context,
          )
        ).output,
      )
    }
    const seededA = await complete(started, "lane-a-session")
    const seededB = await complete(seededA, "lane-b-session")
    const mapped = await complete(seededB, "fresh-map")
    const reflected = await complete(mapped, "fresh-reflection")
    const ranked = await complete(reflected, "fresh-ranking")
    expect(
      ranked.ready.map((work: { lane: string; resumeSessionID: string }) => [work.lane, work.resumeSessionID]),
    ).toEqual([
      ["producer-a", "lane-a-session"],
      ["producer-b", "lane-b-session"],
    ])
  })

  test("exposes resumable candidate control without an agent verification action", async () => {
    await bind()
    const tool = await HarnessTool.init()
    const started = await tool.execute({ action: "start", stall: 2 }, context)
    const snapshot = JSON.parse(started.output)
    expect(snapshot).toMatchObject({
      status: "active",
      proposalPolicy: "leased-v3",
      budget: { candidates: 2, wallTimeMs: 60_000, stall: 2 },
      used: 0,
      recommendation: { strategy: "seed", mode: "single-pass", contextIDs: [] },
      recommendationContext: [],
    })

    const invalid = await tool.execute(
      {
        action: "propose",
        branch: "baseline",
        proposal: "proposal without a lease",
        artifact_uri: "artifact://invalid",
        artifact_sha256: hash("invalid"),
      },
      context,
    )
    expect(invalid.title).toBe("Invalid proposal")

    const proposed = await tool.execute(
      {
        action: "propose",
        recommendation_id: snapshot.recommendation.id,
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
        recommendation_id: snapshot.recommendation.id,
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
          lease: { id: snapshot.recommendation.id, mode: "single-pass", contextIDs: [] },
        },
      ],
    })
  })

  test("returns exact verified trajectory payloads with an adaptive recommendation", async () => {
    await bind()
    const tool = await HarnessTool.init()
    const started = JSON.parse((await tool.execute({ action: "start" }, context)).output)
    const proposed = await tool.execute(
      {
        action: "propose",
        recommendation_id: started.recommendation.id,
        branch: "baseline",
        proposal: "candidate retained for focused refinement",
        artifact_uri: "artifact://trajectory",
        artifact_sha256: hash("trajectory"),
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
      score: 0.8,
      metrics: { score: 0.8, stability: 0.7 },
      checks: [{ id: "official", status: "passed", blocking: true, evidence: ["metric:score"] }],
      evidence: ["report:trajectory"],
      evaluatedAt: Date.now(),
      notes: "improve the boundary residual",
    })
    await HarnessSearch.verify({ sessionID, candidateID })
    const checkpoint = JSON.parse((await tool.execute({ action: "status" }, context)).output)
    expect(checkpoint.recommendation).toMatchObject({
      strategy: "exploit",
      mode: "diff",
      parentIDs: [candidateID],
      contextIDs: [candidateID],
    })
    expect(checkpoint.recommendationContext).toEqual([
      expect.objectContaining({
        id: candidateID,
        artifact: { uri: "artifact://trajectory", sha256: hash("trajectory") },
        score: 0.8,
        metrics: { score: 0.8, stability: 0.7 },
        feedback: "improve the boundary residual",
      }),
    ])
  })

  test("dispatches, releases, and consumes budget-backed parallel variations", async () => {
    await bind()
    const tool = await HarnessTool.init()
    const started = JSON.parse((await tool.execute({ action: "start" }, context)).output)
    const dispatched = await tool.execute({ action: "dispatch", count: 8 }, context)
    expect(dispatched.metadata).toMatchObject({ issued: 2 })
    const batch = JSON.parse(dispatched.output)
    expect(batch.reservations).toMatchObject({ open: 2, consumed: 0, released: 0 })
    const [first, second] = batch.reservations.ready
    expect(first.mandate).toMatchObject({ protocol: "agentic-variation-v1", operator: "architectural-change" })
    expect(second.mandate).toMatchObject({ protocol: "agentic-variation-v1", operator: "composition" })
    expect(first.mandate.id).not.toBe(second.mandate.id)

    const invalid = await tool.execute(
      {
        action: "propose",
        recommendation_id: started.recommendation.id,
        reservation_id: second.id,
        branch: "invalid",
        proposal: "two admission capabilities",
        artifact_uri: "artifact://invalid-admission",
        artifact_sha256: hash("invalid-admission"),
      },
      context,
    )
    expect(invalid.title).toBe("Invalid proposal")

    const released = await tool.execute({ action: "release", reservation_id: first.id }, context)
    expect(JSON.parse(released.output).reservations).toMatchObject({ open: 1, consumed: 0, released: 1 })
    const proposed = await tool.execute(
      {
        action: "propose",
        reservation_id: second.id,
        parent_ids: second.parentIDs,
        inspiration_ids: second.inspirationIDs,
        branch: "parallel",
        proposal: "consume one reserved sibling",
        artifact_uri: "artifact://parallel",
        artifact_sha256: hash("parallel"),
      },
      context,
    )
    expect(proposed.metadata.accepted).toBe(true)
    const state = JSON.parse(proposed.output)
    expect(state.reservations).toMatchObject({ open: 0, consumed: 1, released: 1 })
    expect(state.candidates[0]).toMatchObject({
      reservationID: second.id,
      lease: second.lease,
      mandate: second.mandate,
    })
  })

  test("exposes revision-safe continual state without allowing self-certified confidence", async () => {
    await bind()
    const tool = await HarnessTool.init()
    const initial = await tool.execute({ action: "world_status" }, context)
    expect(initial.metadata).toMatchObject({ revision: 0, contextEpoch: 0, refinementRecommended: false })

    const failure = await tool.execute(
      {
        action: "world_event",
        event_type: "failure",
        event_summary: "The independent residual check failed",
        evidence: ["tool:residual.json"],
        state_changed: true,
      },
      context,
    )
    expect(failure.metadata).toMatchObject({ revision: 1, contextEpoch: 1, refinementRecommended: true })

    const refined = await tool.execute(
      {
        action: "world_refine",
        expected_revision: 1,
        world_reason: "failure",
        world_patches: [
          {
            op: "upsert",
            key: "residual-failure",
            kind: "observation",
            content: "The current discretization violates the residual tolerance",
            confidence: 3,
            evidenceRefs: ["tool:residual.json"],
          },
        ],
      },
      context,
    )
    expect(refined.metadata).toMatchObject({ revision: 2, contextEpoch: 2 })
    expect(JSON.parse(refined.output).entries).toContainEqual(
      expect.objectContaining({ key: "residual-failure", confidence: 3 }),
    )
    expect(
      tool.parameters.safeParse({
        action: "world_refine",
        expected_revision: 2,
        world_reason: "manual",
        world_patches: [
          {
            op: "upsert",
            key: "self-certified",
            kind: "hypothesis",
            content: "Unverified claim",
            confidence: 5,
            evidenceRefs: ["self:claim"],
          },
        ],
      }).success,
    ).toBe(false)

    const rolledBack = await tool.execute(
      { action: "world_rollback", expected_revision: 2, target_revision: 1 },
      context,
    )
    expect(rolledBack.metadata).toMatchObject({ revision: 3, contextEpoch: 3 })
    expect(JSON.parse(rolledBack.output).entries).toEqual([])
  })

  test("surfaces external hindsight only after backend verification", async () => {
    await bind()
    const tool = await HarnessTool.init()
    const started = await tool.execute({ action: "start" }, context)
    const recommendation = JSON.parse(started.output).recommendation
    const proposed = await tool.execute(
      {
        action: "propose",
        recommendation_id: recommendation.id,
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

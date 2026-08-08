import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { HarnessContract } from "../../src/session/harness/contract"
import { HarnessWorld } from "../../src/session/harness/world"

const sessions = new Set<string>()

afterEach(async () => {
  await Promise.all(
    [...sessions].flatMap((sessionID) =>
      ["contracts", "worlds"].map((name) =>
        fs.rm(path.join(Global.Path.data, "harness", name, `${encodeURIComponent(sessionID)}.json`), {
          force: true,
        }),
      ),
    ),
  )
  sessions.clear()
})

async function bind(sessionID: string) {
  sessions.add(sessionID)
  return HarnessContract.bind({
    schemaVersion: 1,
    runID: `run-${sessionID}`,
    sessionID,
    objective: "Discover a testable mechanism and preserve calibrated uncertainty",
    benchmark: {
      name: "local-discovery-suite",
      title: "Local discovery evaluation",
      family: "custom",
      task: "Generate and verify a novel scientific hypothesis",
      version: "1",
      taskID: "case-1",
      split: "validation",
      evaluator: "local-evaluator",
      evaluatorVersion: "1",
      evaluatorSource: "external",
      metric: "score",
      direction: "maximize",
    },
    profile: "optimize",
    search: HarnessContract.adaptiveSearch,
    packs: [],
    model: { provider: "test", name: "model" },
    tools: [],
    skills: [],
    budget: { steps: 20, candidates: 4 },
    seed: 11,
    intervention: "autonomous",
    contamination: { policy: "External evaluator state is unavailable", hiddenTestsAccessible: false },
    createdAt: Date.now(),
  })
}

describe("continual harness world model", () => {
  test("anchors state to the immutable contract and preserves analysis context", async () => {
    const contract = await bind("world-analysis")
    const initial = await HarnessWorld.read(contract.sessionID)
    expect(initial).toMatchObject({ revision: 0, contextEpoch: 0, entries: {} })

    const analysis = await HarnessWorld.event({
      sessionID: contract.sessionID,
      type: "analysis",
      summary: "Compared two candidate mechanisms",
      changed: false,
    })
    expect(analysis.contextEpoch).toBe(0)
    expect(analysis.eventsSinceRefine).toBe(1)

    await expect(
      HarnessWorld.event({
        sessionID: contract.sessionID,
        type: "analysis",
        summary: "Invalid analysis mutation",
        changed: true,
      }),
    ).rejects.toThrow("cannot advance the context epoch")
  })

  test("recommends reset-free refinement at failures, milestones, stagnation, and periodic boundaries", async () => {
    const contract = await bind("world-events")
    const failed = await HarnessWorld.event({
      sessionID: contract.sessionID,
      type: "failure",
      summary: "Independent check contradicted the mechanism",
      evidenceRefs: ["local:failure.json"],
      changed: true,
    })
    expect(failed).toMatchObject({
      revision: 1,
      contextEpoch: 1,
      refinement: { recommended: true, trigger: "failure" },
    })
    const followup = await HarnessWorld.event({
      sessionID: contract.sessionID,
      type: "tool",
      summary: "Collected a diagnostic after the failure",
      changed: true,
    })
    expect(followup.refinement).toEqual({ recommended: true, trigger: "failure" })

    const periodicID = "world-periodic"
    const periodic = await bind(periodicID)
    for (const index of [1, 2, 3, 4, 5, 6]) {
      await HarnessWorld.event({
        sessionID: periodic.sessionID,
        type: "tool",
        summary: `Tool result ${index}`,
        changed: true,
      })
    }
    expect((await HarnessWorld.read(periodic.sessionID)).refinement).toEqual({
      recommended: true,
      trigger: "periodic",
    })
  })

  test("caps agent confidence and requires provenance for stronger beliefs", async () => {
    const contract = await bind("world-confidence")
    await expect(
      HarnessWorld.refine({
        sessionID: contract.sessionID,
        expectedRevision: 0,
        reason: "manual",
        actor: "agent",
        patches: [
          {
            op: "upsert",
            key: "mechanism",
            kind: "hypothesis",
            content: "A specific perturbation controls the response.",
            confidence: 4,
            evidence: [{ ref: "claimed:evaluator", authority: "evaluator" }],
          },
        ],
      }),
    ).rejects.toThrow("self-attributed evidence")

    await expect(
      HarnessWorld.refine({
        sessionID: contract.sessionID,
        expectedRevision: 0,
        reason: "manual",
        actor: "evaluator",
        patches: [
          {
            op: "upsert",
            key: "mechanism",
            kind: "hypothesis",
            content: "A specific perturbation controls the response.",
            confidence: 5,
            evidence: [{ ref: "local:evaluation.json", authority: "evaluator" }],
          },
        ],
      }),
    ).rejects.toThrow("two non-self references")
  })

  test("applies small evidence-backed refinements and escapes prompt content", async () => {
    const contract = await bind("world-refine")
    const state = await HarnessWorld.refine({
      sessionID: contract.sessionID,
      expectedRevision: 0,
      reason: "milestone",
      actor: "evaluator",
      patches: [
        {
          op: "upsert",
          key: "verified-mechanism",
          kind: "hypothesis",
          content: "<candidate> survives the intervention",
          confidence: 5,
          evidence: [
            { ref: "local:evaluation.json", authority: "evaluator" },
            { ref: "local:replication.json", authority: "tool" },
          ],
        },
        {
          op: "upsert",
          key: "next-probe",
          kind: "strategy",
          content: "Test the strongest disconfirming intervention next",
          confidence: 3,
          evidence: [{ ref: "local:analysis.md", authority: "self" }],
        },
      ],
    })
    expect(state).toMatchObject({
      revision: 1,
      contextEpoch: 1,
      eventsSinceRefine: 0,
      refinement: { recommended: false },
    })
    const prompt = await HarnessWorld.prompt(contract.sessionID)
    expect(prompt).toContain('base-prompt="immutable"')
    expect(prompt).toContain("&lt;candidate&gt; survives")
    expect(prompt).not.toContain("<candidate>")
    await expect(
      HarnessWorld.agentRefine({
        sessionID: contract.sessionID,
        expectedRevision: 0,
        reason: "manual",
        patches: [
          {
            op: "upsert",
            key: "stale",
            kind: "memory",
            content: "This update is stale",
            confidence: 2,
            evidenceRefs: [],
          },
        ],
      }),
    ).rejects.toThrow("Expected world-model revision 0, found 1")
  })

  test("rolls back mutable entries without changing the immutable base prompt", async () => {
    const contract = await bind("world-rollback")
    const first = await HarnessWorld.agentRefine({
      sessionID: contract.sessionID,
      expectedRevision: 0,
      reason: "manual",
      patches: [
        {
          op: "upsert",
          key: "strategy",
          kind: "strategy",
          content: "Start with an intervention",
          confidence: 2,
          evidenceRefs: ["self:plan"],
        },
      ],
    })
    const second = await HarnessWorld.agentRefine({
      sessionID: contract.sessionID,
      expectedRevision: first.revision,
      reason: "stagnation",
      patches: [
        {
          op: "upsert",
          key: "strategy",
          kind: "strategy",
          content: "Switch to an observational shortcut",
          confidence: 1,
          evidenceRefs: [],
        },
      ],
    })
    const restored = await HarnessWorld.rollback({
      sessionID: contract.sessionID,
      expectedRevision: second.revision,
      targetRevision: first.revision,
    })
    expect(restored.entries.strategy?.content).toBe("Start with an intervention")
    expect(restored.basePromptSHA256).toBe(first.basePromptSHA256)
    expect(restored.revision).toBe(3)
    expect(restored.contextEpoch).toBe(3)
  })
})

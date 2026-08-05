import z from "zod"
import { HarnessMemory } from "@/session/harness/memory"
import { HarnessOrchestrator } from "@/session/harness/orchestrator"
import { HarnessSearch } from "@/session/harness/search"
import { Tool } from "./tool"
import DESCRIPTION from "./harness.txt"

const Parameters = z.object({
  action: z.enum([
    "start",
    "status",
    "propose",
    "observe",
    "hindsight",
    "coalition_start",
    "coalition_status",
    "coalition_complete",
    "coalition_fail",
  ]),
  stall: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("For start: evaluations without improvement before fusion"),
  parent_ids: z
    .array(z.string().regex(/^[a-f0-9]{64}$/))
    .max(2)
    .optional()
    .describe("For propose: verified parents"),
  inspiration_ids: z
    .array(z.string().regex(/^[a-f0-9]{64}$/))
    .max(2)
    .optional()
    .describe("For propose: verified inspirations returned by a migration recommendation"),
  branch: z.string().min(1).max(120).optional().describe("For propose: stable diversity branch label"),
  proposal: z.string().min(1).max(4_000).optional().describe("For propose: concise description of the change"),
  artifact_uri: z.string().min(1).max(2_048).optional().describe("For propose: immutable candidate artifact reference"),
  artifact_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional()
    .describe("For propose: SHA-256 of the exact candidate artifact"),
  candidate_id: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional()
    .describe("For observe: candidate identity"),
  status: z.enum(["passed", "failed", "inconclusive"]).optional().describe("For observe: provisional status"),
  score: z.number().finite().optional().describe("For observe: provisional primary score"),
  metrics: z
    .record(z.string().max(200), z.number().finite())
    .refine((value) => Object.keys(value).length <= 128, "At most 128 provisional metrics")
    .optional()
    .describe("For observe: provisional metric values"),
  evidence: z.array(z.string().min(1).max(500)).max(12).optional().describe("For observe: provisional references"),
  feedback: z.string().max(4_000).optional().describe("For observe: provisional evaluator or process feedback"),
  query: z.string().min(1).max(2_000).optional().describe("For hindsight: current problem or failure query"),
  stage: HarnessMemory.Stage.optional().describe("For hindsight: current search stage"),
  limit: z.number().int().min(1).max(6).optional().describe("For hindsight: maximum precedents"),
  work_id: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional()
    .describe("For coalition_complete/coalition_fail: orchestration work identity"),
  worker_session_id: z
    .string()
    .min(1)
    .optional()
    .describe(
      "For coalition_complete/coalition_fail: exact ready.resumeSessionID for a resumed producer lane, otherwise a fresh Task child session identity",
    ),
  result_summary: z.string().min(1).max(8_000).optional().describe("For coalition_complete: concise result"),
  artifact_refs: z
    .array(z.string().min(1).max(2_048))
    .max(32)
    .optional()
    .describe("For coalition_complete: immutable artifact references"),
  evidence_refs: z
    .array(z.string().min(1).max(2_048))
    .max(32)
    .optional()
    .describe("For coalition_complete: observable evidence references"),
  usage: z
    .object({
      steps: z.number().int().nonnegative().optional(),
      tokens: z.number().int().nonnegative().optional(),
      costUSD: z.number().nonnegative().optional(),
      wallTimeMs: z.number().int().nonnegative().optional(),
    })
    .strict()
    .optional()
    .describe("For coalition_complete: actual resource use"),
  failure: z.string().min(1).max(4_000).optional().describe("For coalition_fail: failure reason"),
  verdict: z
    .enum(["support", "reject", "abstain"])
    .optional()
    .describe("For verification coalition_complete: blinded structured verdict"),
  verdict_confidence: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe("For verification coalition_complete: calibrated verdict confidence"),
  verdict_checks: z
    .array(
      z
        .object({
          id: z.string().min(1).max(200),
          status: z.enum(["passed", "failed", "inconclusive"]),
          evidence_refs: z.array(z.string().min(1).max(2_048)).min(1).max(16),
        })
        .strict(),
    )
    .min(1)
    .max(64)
    .optional()
    .describe("For verification coalition_complete: evidence-backed checks"),
})

const result = (title: string, output: unknown, metadata: Record<string, unknown> = {}) => ({
  title,
  output: typeof output === "string" ? output : JSON.stringify(output, null, 2),
  metadata,
})

const summary = (state: HarnessSearch.State) => ({
  runID: state.runID,
  status: state.status,
  stopReason: state.stopReason,
  metric: state.metric,
  direction: state.direction,
  target: state.target,
  population: state.population,
  budget: state.budget,
  used: Object.keys(state.candidates).length,
  bestID: state.bestID,
  archiveIDs: state.archiveIDs,
  stalled: state.stalled,
  revision: state.revision,
  recommendation: state.status === "active" ? HarnessSearch.recommend(state) : undefined,
  candidates: Object.values(state.candidates)
    .toSorted((a, b) => b.createdAt - a.createdAt)
    .slice(0, 20)
    .map((candidate) => ({
      id: candidate.id,
      parentIDs: candidate.parentIDs,
      inspirationIDs: candidate.inspirationIDs,
      branch: candidate.branch,
      generation: candidate.generation,
      island: candidate.island,
      ordinal: candidate.ordinal,
      proposal: candidate.proposal.slice(0, 1_000),
      artifact: candidate.artifact,
      source: candidate.result?.source,
      status: candidate.result?.status,
      score: candidate.result?.score,
      metrics: candidate.result?.metrics,
      feedback: candidate.result?.feedback?.slice(0, 2_000),
    })),
})

const coalition = (state: HarnessOrchestrator.State) => ({
  runID: state.runID,
  status: state.status,
  protocolVersion: state.protocolVersion,
  sessionPolicy: state.sessionPolicy,
  topology: state.selection.topology,
  selectionSource: state.selection.source,
  selectionReasons: state.selection.reasons,
  traits: state.selection.traits,
  maxWorkers: state.maxWorkers,
  maxRounds: state.maxRounds,
  minIndependentVerifiers: state.minIndependentVerifiers,
  adaptive: state.adaptive,
  consensus: state.consensus,
  revision: state.revision,
  progress: Object.fromEntries(
    ["pending", "completed", "failed", "cancelled"].map((status) => [
      status,
      Object.values(state.work).filter((item) => item.status === status).length,
    ]),
  ),
  ready: HarnessOrchestrator.ready(state)
    .slice(0, state.maxWorkers)
    .map((work) => ({
      id: work.id,
      role: work.role,
      label: work.label,
      round: work.round,
      agent: work.agent,
      lane: work.lane,
      resumeSessionID: work.resumeSessionID,
      prompt: work.prompt,
      allocation: work.allocation,
      context: work.context,
    })),
})

export const HarnessTool = Tool.define("harness", {
  description: DESCRIPTION,
  parameters: Parameters,
  async execute(params, ctx) {
    if (params.action === "coalition_start") {
      const state = await HarnessOrchestrator.initialize(ctx.sessionID)
      return result("Scientific coalition initialized", coalition(state), {
        runID: state.runID,
        topology: state.selection.topology,
        revision: state.revision,
      })
    }

    if (params.action === "coalition_status") {
      const state = await HarnessOrchestrator.read(ctx.sessionID)
      return result("Scientific coalition checkpoint", coalition(state), {
        runID: state.runID,
        topology: state.selection.topology,
        revision: state.revision,
      })
    }

    if (params.action === "coalition_complete") {
      if (!params.work_id || !params.worker_session_id || !params.result_summary) {
        return result(
          "Invalid coalition completion",
          "coalition_complete requires work_id, worker_session_id, and result_summary",
        )
      }
      const verdict = [params.verdict, params.verdict_confidence, params.verdict_checks]
      if (verdict.some((value) => value !== undefined) && verdict.some((value) => value === undefined)) {
        return result(
          "Invalid coalition completion",
          "verification completion requires verdict, verdict_confidence, and verdict_checks together",
        )
      }
      const state = await HarnessOrchestrator.complete({
        sessionID: ctx.sessionID,
        workID: params.work_id,
        workerSessionID: params.worker_session_id,
        result: {
          summary: params.result_summary,
          artifactRefs: params.artifact_refs ?? [],
          evidenceRefs: params.evidence_refs ?? [],
          usage: params.usage,
          verdict:
            params.verdict && params.verdict_confidence !== undefined && params.verdict_checks
              ? {
                  decision: params.verdict,
                  confidence: params.verdict_confidence,
                  checks: params.verdict_checks.map((check) => ({
                    id: check.id,
                    status: check.status,
                    evidenceRefs: check.evidence_refs,
                  })),
                }
              : undefined,
        },
      })
      return result("Coalition work completed", coalition(state), {
        workID: params.work_id,
        provisional: true,
        revision: state.revision,
      })
    }

    if (params.action === "coalition_fail") {
      if (!params.work_id || !params.worker_session_id || !params.failure) {
        return result("Invalid coalition failure", "coalition_fail requires work_id, worker_session_id, and failure")
      }
      const state = await HarnessOrchestrator.fail({
        sessionID: ctx.sessionID,
        workID: params.work_id,
        workerSessionID: params.worker_session_id,
        failure: params.failure,
      })
      return result("Coalition work failed", coalition(state), {
        workID: params.work_id,
        provisional: true,
        revision: state.revision,
      })
    }

    if (params.action === "start") {
      const state = await HarnessSearch.initialize({ sessionID: ctx.sessionID, stall: params.stall })
      return result("Optimization search started", summary(state), { runID: state.runID, revision: state.revision })
    }

    if (params.action === "status") {
      const state = await HarnessSearch.read(ctx.sessionID)
      return result("Optimization search checkpoint", summary(state), {
        runID: state.runID,
        revision: state.revision,
        bestID: state.bestID,
      })
    }

    if (params.action === "propose") {
      if (!params.branch || !params.proposal || !params.artifact_uri || !params.artifact_sha256) {
        return result("Invalid proposal", "propose requires branch, proposal, artifact_uri, and artifact_sha256")
      }
      const added = await HarnessSearch.add({
        sessionID: ctx.sessionID,
        parentIDs: params.parent_ids ?? [],
        inspirationIDs: params.inspiration_ids ?? [],
        branch: params.branch,
        proposal: params.proposal,
        artifact: { uri: params.artifact_uri, sha256: params.artifact_sha256 },
      })
      return result(added.accepted ? "Candidate registered" : "Candidate rejected", summary(added.state), {
        candidateID: added.id,
        accepted: added.accepted,
        deduplicated: added.deduplicated,
        revision: added.state.revision,
      })
    }

    if (params.action === "observe") {
      if (!params.candidate_id || !params.status) {
        return result("Invalid observation", "observe requires candidate_id and status")
      }
      const state = await HarnessSearch.observe({
        sessionID: ctx.sessionID,
        candidateID: params.candidate_id,
        status: params.status,
        score: params.score,
        metrics: params.metrics,
        evidence: params.evidence,
        feedback: params.feedback,
      })
      return result("Unverified observation recorded", summary(state), {
        candidateID: params.candidate_id,
        verified: false,
        revision: state.revision,
      })
    }

    if (!params.query) return result("Invalid hindsight query", "hindsight requires query")
    const prompt = await HarnessMemory.prompt({
      sessionID: ctx.sessionID,
      query: params.query,
      stage: params.stage,
      limit: params.limit,
    })
    return result(
      prompt ? "Verified hindsight" : "No verified hindsight",
      prompt || "No relevant verified precedents.",
      {
        found: !!prompt,
      },
    )
  },
})

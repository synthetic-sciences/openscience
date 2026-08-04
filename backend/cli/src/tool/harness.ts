import z from "zod"
import { HarnessMemory } from "@/session/harness/memory"
import { HarnessSearch } from "@/session/harness/search"
import { Tool } from "./tool"
import DESCRIPTION from "./harness.txt"

const Parameters = z.object({
  action: z.enum(["start", "status", "propose", "observe", "hindsight"]),
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
  budget: state.budget,
  used: Object.keys(state.candidates).length,
  bestID: state.bestID,
  stalled: state.stalled,
  revision: state.revision,
  recommendation: state.status === "active" ? HarnessSearch.recommend(state) : undefined,
  candidates: Object.values(state.candidates)
    .toSorted((a, b) => b.createdAt - a.createdAt)
    .slice(0, 20)
    .map((candidate) => ({
      id: candidate.id,
      parentIDs: candidate.parentIDs,
      branch: candidate.branch,
      generation: candidate.generation,
      source: candidate.result?.source,
      status: candidate.result?.status,
      score: candidate.result?.score,
    })),
})

export const HarnessTool = Tool.define("harness", {
  description: DESCRIPTION,
  parameters: Parameters,
  async execute(params, ctx) {
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
        branch: params.branch,
        proposal: params.proposal,
        artifact: { uri: params.artifact_uri, sha256: params.artifact_sha256 },
      })
      return result(added.accepted ? "Candidate registered" : "Candidate rejected", summary(added.state), {
        candidateID: added.id,
        accepted: added.accepted,
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

import z from "zod"
import { HarnessClaims } from "@/session/harness/claims"
import { Tool } from "./tool"
import DESCRIPTION from "./claim.txt"

const Parameters = z.object({
  action: z.enum(["declare", "observe", "status"]),
  claim_id: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional()
    .describe("For observe/status: claim identity"),
  text: z.string().min(1).max(4_000).optional().describe("For declare: exact scientific claim"),
  kind: HarnessClaims.Kind.optional().describe("For declare: epistemic claim kind"),
  importance: z.enum(["supporting", "headline"]).optional().describe("For declare: role in the final conclusion"),
  subject_uri: z
    .string()
    .min(1)
    .max(2_048)
    .optional()
    .describe("For declare: exact artifact, output, or report subject"),
  subject_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional()
    .describe("For declare: immutable subject digest"),
  provenance_id: z.string().min(1).max(200).optional().describe("For declare: local provenance node"),
  independent_sources: z.number().int().min(1).max(5).optional().describe("For declare: strengthen source count"),
  required_checks: z
    .array(z.string().min(1).max(100))
    .max(24)
    .optional()
    .describe("For declare: extra required checks"),
  evidence_kind: z
    .enum(["observation", "measurement", "statistical_test", "citation", "artifact", "review"])
    .optional()
    .describe("For observe: provisional evidence kind"),
  stance: z.enum(["supports", "refutes", "inconclusive"]).optional().describe("For observe: provisional relation"),
  summary: z.string().min(1).max(2_000).optional().describe("For observe: what was observed"),
  source_uri: z.string().min(1).max(2_048).optional().describe("For observe: exact source reference"),
  source_sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional()
    .describe("For observe: source digest"),
  evidence: z.array(z.string().min(1).max(1_000)).max(32).optional().describe("For observe: evidence references"),
  metrics: z
    .record(z.string().max(200), z.number().finite())
    .refine((value) => Object.keys(value).length <= 128, "At most 128 measured values")
    .optional()
    .describe("For observe: measured values"),
})

const result = (title: string, output: unknown, metadata: Record<string, unknown> = {}) => ({
  title,
  output: typeof output === "string" ? output : JSON.stringify(output, null, 2),
  metadata,
})

const summary = (claim: HarnessClaims.View) => ({
  id: claim.id,
  text: claim.text,
  kind: claim.kind,
  importance: claim.importance,
  status: claim.status,
  requirements: claim.requirements,
  independentSources: claim.independentSources,
  passedChecks: claim.passedChecks,
  missingChecks: claim.missingChecks,
  evidence: claim.evidence.map((item) => ({
    id: item.id,
    origin: item.origin,
    stance: item.stance,
    kind: item.kind,
    summary: item.summary,
    actor: item.source.actor,
  })),
})

export const ClaimTool = Tool.define("claim", {
  description: DESCRIPTION,
  parameters: Parameters,
  async execute(params, ctx) {
    if (params.action === "declare") {
      if (!params.text || !params.kind || !params.importance || !params.subject_uri) {
        return result("Invalid claim", "declare requires text, kind, importance, and subject_uri")
      }
      const claim = await HarnessClaims.declare({
        sessionID: ctx.sessionID,
        actor: ctx.agent,
        messageID: ctx.messageID,
        text: params.text,
        kind: params.kind,
        importance: params.importance,
        subject: {
          uri: params.subject_uri,
          sha256: params.subject_sha256,
          provenanceID: params.provenance_id,
        },
        requirements: {
          independentSources: params.independent_sources,
          checks: params.required_checks,
        },
      })
      const view = await HarnessClaims.get(ctx.sessionID, claim.id)
      return result("Scientific claim declared", summary(view!), { claimID: claim.id, status: view!.status })
    }

    if (params.action === "observe") {
      if (!params.claim_id || !params.evidence_kind || !params.stance || !params.summary || !params.source_uri) {
        return result(
          "Invalid claim evidence",
          "observe requires claim_id, evidence_kind, stance, summary, and source_uri",
        )
      }
      const evidence = await HarnessClaims.observe({
        sessionID: ctx.sessionID,
        claimID: params.claim_id,
        actor: ctx.agent,
        kind: params.evidence_kind,
        stance: params.stance,
        summary: params.summary,
        source: { uri: params.source_uri, sha256: params.source_sha256 },
        evidence: params.evidence,
        metrics: params.metrics,
      })
      const view = await HarnessClaims.get(ctx.sessionID, params.claim_id)
      return result("Provisional claim evidence recorded", summary(view!), {
        claimID: params.claim_id,
        evidenceID: evidence.id,
        origin: "observed",
        status: view!.status,
      })
    }

    if (params.claim_id) {
      const claim = await HarnessClaims.get(ctx.sessionID, params.claim_id)
      if (!claim) return result("Claim not found", `No claim ${params.claim_id}.`, { found: false })
      return result("Scientific claim status", summary(claim), { claimID: claim.id, status: claim.status })
    }
    const claims = await HarnessClaims.list(ctx.sessionID)
    return result("Scientific claim ledger", claims.map(summary), { count: claims.length })
  },
})

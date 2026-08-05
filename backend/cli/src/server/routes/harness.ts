import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { lazy } from "@/util/lazy"
import { HarnessAblation } from "@/session/harness/ablation"
import { HarnessAdapter } from "@/session/harness/adapter"
import { HarnessAudit } from "@/session/harness/audit"
import { HarnessBenchmark } from "@/session/harness/benchmark"
import { HarnessContract } from "@/session/harness/contract"
import { HarnessEvaluation } from "@/session/harness/evaluation"
import { HarnessEvolution } from "@/session/harness/evolution"
import { HarnessJudge } from "@/session/harness/judge"
import { HarnessLaunch } from "@/session/harness/launch"
import { HarnessIntegrity } from "@/session/harness/integrity"
import { HarnessIntervention } from "@/session/harness/intervention"
import { HarnessOrchestrator } from "@/session/harness/orchestrator"
import { HarnessReport } from "@/session/harness/report"
import { HarnessRecipe } from "@/session/harness/recipe"
import { HarnessSimulation } from "@/session/harness/simulation"
import { HarnessSemantic } from "@/session/harness/semantic"
import { HarnessSkill } from "@/session/harness/skill"
import { errors } from "../error"

const SessionID = z.object({ sessionID: z.string().min(1) })
const Compare = z
  .object({
    sessionIDs: z.array(z.string().min(1)).min(2).max(100),
    baselineRunID: z.string().min(1),
  })
  .strict()

export const HarnessRoutes = lazy(() =>
  new Hono()
    .get(
      "/benchmarks",
      describeRoute({
        summary: "List scientific benchmark adapters",
        description:
          "Lists version-agnostic adapter manifests, exact official source pins or subset limitations, and required verification packs.",
        operationId: "harness.benchmarks",
        responses: {
          200: {
            description: "Benchmark adapter manifests",
            content: { "application/json": { schema: resolver(z.array(HarnessBenchmark.Manifest)) } },
          },
        },
      }),
      (c) => c.json(Object.values(HarnessBenchmark.catalog)),
    )
    .post(
      "/benchmarks/:benchmark/recipe",
      describeRoute({
        summary: "Materialize a source-verified benchmark execution recipe",
        description:
          "Resolves typed bindings into the pinned benchmark's native stages, artifacts, metrics, and launch-driver commitments without executing the external repository.",
        operationId: "harness.benchmark.recipe",
        responses: {
          200: {
            description: "Immutable source-verified benchmark recipe",
            content: { "application/json": { schema: resolver(HarnessRecipe.Materialized) } },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ benchmark: z.string().min(1).max(120) })),
      validator("json", HarnessRecipe.Selection),
      (c) => c.json(HarnessRecipe.materialize(c.req.valid("param").benchmark, c.req.valid("json"))),
    )
    .post(
      "/audits",
      describeRoute({
        summary: "Initialize an evaluator-owned active audit",
        description:
          "Commits an opaque probe pool and binds uncertainty-aware selection to the evaluator capability and audited artifact.",
        operationId: "harness.audit.initialize",
        responses: {
          200: {
            description: "Active audit state",
            content: { "application/json": { schema: resolver(HarnessAudit.State) } },
          },
          ...errors(400, 403, 409),
        },
      }),
      validator("json", HarnessAudit.Initialize),
      async (c) => c.json(await HarnessAudit.initialize(c.req.valid("json"))),
    )
    .post(
      "/audits/:auditID/status",
      describeRoute({
        summary: "Read a capability-protected active audit",
        operationId: "harness.audit.status",
        responses: {
          200: {
            description: "Active audit state",
            content: { "application/json": { schema: resolver(HarnessAudit.State) } },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator("param", z.object({ auditID: z.string().regex(/^[a-f0-9]{64}$/) })),
      validator("json", HarnessAudit.Access),
      async (c) => c.json(await HarnessAudit.status(c.req.valid("param").auditID, c.req.valid("json"))),
    )
    .post(
      "/audits/:auditID/selection",
      describeRoute({
        summary: "Select the next opaque active-audit probe",
        description:
          "Combines weighted integral-variance reduction, failure UCB, failure-region diversity, and stratum coverage.",
        operationId: "harness.audit.select",
        responses: { 200: { description: "Selected opaque probe commitment" }, ...errors(400, 403, 404, 409) },
      }),
      validator("param", z.object({ auditID: z.string().regex(/^[a-f0-9]{64}$/) })),
      validator("json", HarnessAudit.Access),
      async (c) => c.json(await HarnessAudit.select(c.req.valid("param").auditID, c.req.valid("json"))),
    )
    .post(
      "/audits/:auditID/observations",
      describeRoute({
        summary: "Record an evaluator-authenticated probe outcome",
        description:
          "Updates the GP posterior and stopping rule without promoting the audit estimate into benchmark evidence.",
        operationId: "harness.audit.observe",
        responses: {
          200: {
            description: "Updated active audit state",
            content: { "application/json": { schema: resolver(HarnessAudit.State) } },
          },
          ...errors(400, 403, 404, 409),
        },
      }),
      validator("param", z.object({ auditID: z.string().regex(/^[a-f0-9]{64}$/) })),
      validator("json", HarnessAudit.Observe),
      async (c) => c.json(await HarnessAudit.observe(c.req.valid("param").auditID, c.req.valid("json"))),
    )
    .post(
      "/ablations",
      describeRoute({
        summary: "Freeze a matched scientific ablation plan",
        description:
          "Binds at least three evaluator-authenticated seed pairs before evaluation and permits exactly one declared contract factor to differ.",
        operationId: "harness.ablation.initialize",
        responses: {
          200: {
            description: "Immutable matched ablation plan",
            content: { "application/json": { schema: resolver(HarnessAblation.State) } },
          },
          ...errors(400, 403, 409),
        },
      }),
      validator("json", HarnessAblation.Initialize),
      async (c) => c.json(await HarnessAblation.initialize(c.req.valid("json"))),
    )
    .post(
      "/ablations/:planID/assessment",
      describeRoute({
        summary: "Assess a frozen matched ablation",
        description:
          "Authenticates every paired run, verifies immutable contracts and final evaluations, then derives paired effects and a 95% interval.",
        operationId: "harness.ablation.assess",
        responses: {
          200: {
            description: "Immutable matched ablation assessment",
            content: { "application/json": { schema: resolver(HarnessAblation.State) } },
          },
          ...errors(400, 403, 404, 409),
        },
      }),
      validator("param", z.object({ planID: z.string().regex(/^[a-f0-9]{64}$/) })),
      validator("json", HarnessAblation.Assess),
      async (c) => c.json(await HarnessAblation.assess(c.req.valid("param").planID, c.req.valid("json"))),
    )
    .post(
      "/interventions",
      describeRoute({
        summary: "Freeze an evaluator-owned controlled replay study",
        description:
          "Binds a candidate and exact evolution receipt to predeclared replay, retuning, ablation, repair, or transfer pairs before the candidate's final evaluation.",
        operationId: "harness.intervention.initialize",
        responses: {
          200: {
            description: "Immutable controlled intervention plan",
            content: { "application/json": { schema: resolver(HarnessIntervention.State) } },
          },
          ...errors(400, 403, 409),
        },
      }),
      validator("json", HarnessIntervention.Initialize),
      async (c) => {
        const input = c.req.valid("json")
        const contract = await HarnessAdapter.authorize(input.sessionID, input.evaluatorToken)
        return c.json(await HarnessIntervention.initialize(input, contract))
      },
    )
    .post(
      "/interventions/:candidateID/observations",
      describeRoute({
        summary: "Record an evaluator-authenticated intervention outcome",
        description:
          "Binds one numeric outcome to an exact frozen pair target without adding it to candidate fitness or the benchmark evaluation journal.",
        operationId: "harness.intervention.observe",
        responses: {
          200: {
            description: "Immutable intervention outcome",
            content: { "application/json": { schema: resolver(HarnessIntervention.Outcome) } },
          },
          ...errors(400, 403, 404, 409),
        },
      }),
      validator("param", z.object({ candidateID: z.string().regex(/^[a-f0-9]{64}$/) })),
      validator("json", HarnessIntervention.Observe),
      async (c) => {
        const input = c.req.valid("json")
        const contract = await HarnessAdapter.authorize(input.sessionID, input.evaluatorToken)
        return c.json(await HarnessIntervention.observe(c.req.valid("param").candidateID, input, contract))
      },
    )
    .post(
      "/interventions/:candidateID/assessment",
      describeRoute({
        summary: "Assess a complete controlled replay study",
        description:
          "Recomputes direction-aware paired effects, confidence intervals, stability, tuning gap, component dependence, and transfer robustness from every frozen outcome.",
        operationId: "harness.intervention.assess",
        responses: {
          200: {
            description: "Immutable controlled intervention receipt",
            content: { "application/json": { schema: resolver(HarnessIntervention.Receipt) } },
          },
          ...errors(400, 403, 404, 409),
        },
      }),
      validator("param", z.object({ candidateID: z.string().regex(/^[a-f0-9]{64}$/) })),
      validator("json", HarnessIntervention.Access),
      async (c) => {
        const input = c.req.valid("json")
        const contract = await HarnessAdapter.authorize(input.sessionID, input.evaluatorToken)
        return c.json(await HarnessIntervention.assess(input.sessionID, c.req.valid("param").candidateID, contract))
      },
    )
    .post(
      "/interventions/:candidateID/status",
      describeRoute({
        summary: "Read a capability-protected controlled replay study",
        operationId: "harness.intervention.status",
        responses: {
          200: {
            description: "Controlled intervention state",
            content: { "application/json": { schema: resolver(HarnessIntervention.State.nullable()) } },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator("param", z.object({ candidateID: z.string().regex(/^[a-f0-9]{64}$/) })),
      validator("json", HarnessIntervention.Access),
      async (c) => {
        const input = c.req.valid("json")
        const contract = await HarnessAdapter.authorize(input.sessionID, input.evaluatorToken)
        return c.json(await HarnessIntervention.status(input.sessionID, c.req.valid("param").candidateID, contract))
      },
    )
    .post(
      "/evaluators/qualifications",
      describeRoute({
        summary: "Qualify a bound benchmark evaluator",
        description:
          "Uses an independent auditor capability and a committed hidden fault suite to recompute evaluator discrimination and calibration metrics.",
        operationId: "harness.judge.record",
        responses: {
          200: {
            description: "Immutable evaluator audit receipt",
            content: { "application/json": { schema: resolver(HarnessJudge.Receipt) } },
          },
          ...errors(400, 403, 409),
        },
      }),
      validator("json", HarnessJudge.Submit),
      async (c) => {
        const input = c.req.valid("json")
        const contract = await HarnessAdapter.authorizeAuditor(input.sessionID, input.auditorToken)
        return c.json(await HarnessJudge.record(input, contract))
      },
    )
    .post(
      "/evaluators/qualifications/:receiptID",
      describeRoute({
        summary: "Read a capability-protected evaluator qualification",
        operationId: "harness.judge.receipt",
        responses: {
          200: {
            description: "Evaluator audit receipt",
            content: { "application/json": { schema: resolver(HarnessJudge.Receipt) } },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator("param", z.object({ receiptID: z.string().regex(/^[a-f0-9]{64}$/) })),
      validator("json", HarnessJudge.Access),
      async (c) => {
        const input = c.req.valid("json")
        const contract = await HarnessAdapter.authorizeAuditor(input.sessionID, input.auditorToken)
        return c.json(
          await HarnessJudge.assert({
            contract,
            receiptID: c.req.valid("param").receiptID,
            recordedAt: Date.now(),
            requirePassed: false,
          }),
        )
      },
    )
    .post(
      "/semantics/receipts",
      describeRoute({
        summary: "Record an independent semantic audit",
        description:
          "Derives whether one bound result is meaningful, merely technically valid, ambiguous, or incorrect from independent evidence-backed reviews of frozen intent, shortcuts, and literature-relative novelty.",
        operationId: "harness.semantic.record",
        responses: {
          200: {
            description: "Immutable semantic audit receipt",
            content: { "application/json": { schema: resolver(HarnessSemantic.Receipt) } },
          },
          ...errors(400, 403, 409),
        },
      }),
      validator("json", HarnessSemantic.Submit),
      async (c) => {
        const input = c.req.valid("json")
        const contract = await HarnessAdapter.authorizeSemantic(input.sessionID, input.reviewerToken)
        return c.json(await HarnessSemantic.record(input, contract))
      },
    )
    .post(
      "/semantics/receipts/:receiptID",
      describeRoute({
        summary: "Read a capability-protected semantic audit receipt",
        operationId: "harness.semantic.receipt",
        responses: {
          200: {
            description: "Semantic audit receipt",
            content: { "application/json": { schema: resolver(HarnessSemantic.Receipt) } },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator("param", z.object({ receiptID: z.string().regex(/^[a-f0-9]{64}$/) })),
      validator("json", HarnessSemantic.Access),
      async (c) => {
        const input = c.req.valid("json")
        const contract = await HarnessAdapter.authorizeSemantic(input.sessionID, input.reviewerToken)
        const receipt = await HarnessSemantic.read(c.req.valid("param").receiptID)
        if (!receipt) throw new Error(`Unknown or corrupt semantic audit receipt`)
        return c.json(
          await HarnessSemantic.assert({
            contract,
            receiptID: receipt.receiptID,
            subject: receipt.subject,
            evaluatedAt: Date.now(),
            recordedAt: Date.now(),
            requirePassed: false,
          }),
        )
      },
    )
    .post(
      "/launches/receipts",
      describeRoute({
        summary: "Record evaluator-authenticated benchmark launch readiness",
        description:
          "Verifies the complete clean-checkout, environment, hidden-boundary, deterministic-replay, artifact, and baseline launch suite against a pinned official protocol.",
        operationId: "harness.launch.record",
        responses: {
          200: {
            description: "Immutable benchmark launch receipt",
            content: { "application/json": { schema: resolver(HarnessLaunch.Info) } },
          },
          ...errors(400, 403, 409),
        },
      }),
      validator("json", HarnessLaunch.Submit),
      async (c) => {
        const input = c.req.valid("json")
        const contract = await HarnessAdapter.authorize(input.sessionID, input.evaluatorToken)
        return c.json(await HarnessLaunch.record(input, contract))
      },
    )
    .post(
      "/launches/receipts/:receiptID",
      describeRoute({
        summary: "Read a capability-protected benchmark launch receipt",
        operationId: "harness.launch.receipt",
        responses: {
          200: {
            description: "Benchmark launch receipt",
            content: { "application/json": { schema: resolver(HarnessLaunch.Info.nullable()) } },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator("param", z.object({ receiptID: z.string().regex(/^[a-f0-9]{64}$/) })),
      validator("json", HarnessLaunch.Access),
      async (c) => {
        const input = c.req.valid("json")
        await HarnessAdapter.authorize(input.sessionID, input.evaluatorToken)
        return c.json(await HarnessLaunch.read(input.sessionID, c.req.valid("param").receiptID))
      },
    )
    .post(
      "/integrity/receipts",
      describeRoute({
        summary: "Record evaluator-authenticated runtime integrity",
        description:
          "Derives trace-completeness, model-identity, contamination, external-model, benchmark-lookup, and hidden-canary gates against an immutable protocol.",
        operationId: "harness.integrity.record",
        responses: {
          200: {
            description: "Immutable runtime integrity receipt",
            content: { "application/json": { schema: resolver(HarnessIntegrity.Info) } },
          },
          ...errors(400, 403, 409),
        },
      }),
      validator("json", HarnessIntegrity.Submit),
      async (c) => {
        const input = c.req.valid("json")
        const contract = await HarnessAdapter.authorize(input.sessionID, input.evaluatorToken)
        return c.json(await HarnessIntegrity.record(input, contract))
      },
    )
    .post(
      "/integrity/receipts/:receiptID",
      describeRoute({
        summary: "Read a capability-protected runtime integrity receipt",
        operationId: "harness.integrity.receipt",
        responses: {
          200: {
            description: "Runtime integrity receipt",
            content: { "application/json": { schema: resolver(HarnessIntegrity.Info.nullable()) } },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator("param", z.object({ receiptID: z.string().regex(/^[a-f0-9]{64}$/) })),
      validator("json", HarnessIntegrity.Access),
      async (c) => {
        const input = c.req.valid("json")
        await HarnessAdapter.authorize(input.sessionID, input.evaluatorToken)
        return c.json(await HarnessIntegrity.read(input.sessionID, c.req.valid("param").receiptID))
      },
    )
    .post(
      "/evolution/receipts",
      describeRoute({
        summary: "Record evaluator-authenticated evolutionary provenance",
        description:
          "Binds a candidate snapshot and every parent delta to immutable search lineage, then derives replay and ancestral line-reintroduction diagnostics without changing fitness.",
        operationId: "harness.evolution.record",
        responses: {
          200: {
            description: "Immutable evolution trace receipt",
            content: {
              "application/json": {
                schema: resolver(HarnessEvolution.Info as z.ZodType<Record<string, unknown>>),
              },
            },
          },
          ...errors(400, 403, 409),
        },
      }),
      validator("json", HarnessEvolution.Submit),
      async (c) => {
        const input = c.req.valid("json")
        const contract = await HarnessAdapter.authorize(input.sessionID, input.evaluatorToken)
        return c.json((await HarnessEvolution.record(input, contract)) as Record<string, unknown>)
      },
    )
    .post(
      "/evolution/receipts/:receiptID",
      describeRoute({
        summary: "Read a capability-protected evolution trace receipt",
        operationId: "harness.evolution.receipt",
        responses: {
          200: {
            description: "Evolution trace receipt",
            content: {
              "application/json": {
                schema: resolver(HarnessEvolution.Info.nullable() as z.ZodType<Record<string, unknown> | null>),
              },
            },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator("param", z.object({ receiptID: z.string().regex(/^[a-f0-9]{64}$/) })),
      validator("json", HarnessEvolution.Access),
      async (c) => {
        const input = c.req.valid("json")
        await HarnessAdapter.authorize(input.sessionID, input.evaluatorToken)
        return c.json(
          (await HarnessEvolution.read(input.sessionID, c.req.valid("param").receiptID)) as Record<
            string,
            unknown
          > | null,
        )
      },
    )
    .post(
      "/simulations/receipts",
      describeRoute({
        summary: "Record an evaluator-authenticated simulator validation",
        description:
          "Recomputes convergence, residual, invariant, and stress-test gates against the immutable simulator protocol and exact subject artifact.",
        operationId: "harness.simulation.record",
        responses: {
          200: {
            description: "Immutable simulator validation receipt",
            content: { "application/json": { schema: resolver(HarnessSimulation.Info) } },
          },
          ...errors(400, 403, 409),
        },
      }),
      validator("json", HarnessSimulation.Submit),
      async (c) => {
        const input = c.req.valid("json")
        const contract = await HarnessAdapter.authorize(input.sessionID, input.evaluatorToken)
        return c.json(await HarnessSimulation.record(input, contract))
      },
    )
    .post(
      "/simulations/receipts/:receiptID",
      describeRoute({
        summary: "Read a capability-protected simulator validation receipt",
        operationId: "harness.simulation.receipt",
        responses: {
          200: {
            description: "Simulator validation receipt",
            content: { "application/json": { schema: resolver(HarnessSimulation.Info.nullable()) } },
          },
          ...errors(400, 403, 404),
        },
      }),
      validator("param", z.object({ receiptID: z.string().regex(/^[a-f0-9]{64}$/) })),
      validator("json", HarnessSimulation.Access),
      async (c) => {
        const input = c.req.valid("json")
        await HarnessAdapter.authorize(input.sessionID, input.evaluatorToken)
        return c.json(await HarnessSimulation.read(input.sessionID, c.req.valid("param").receiptID))
      },
    )
    .post(
      "/runs/:sessionID/orchestration",
      describeRoute({
        summary: "Initialize contract-bound scientific orchestration",
        description:
          "Selects a bounded topology from immutable contract traits and creates a restart-safe provisional work DAG.",
        operationId: "harness.orchestration.start",
        responses: {
          200: {
            description: "Scientific orchestration state",
            content: { "application/json": { schema: resolver(HarnessOrchestrator.State) } },
          },
          ...errors(400, 404, 409),
        },
      }),
      validator("param", SessionID),
      async (c) => c.json(await HarnessOrchestrator.initialize(c.req.valid("param").sessionID)),
    )
    .get(
      "/runs/:sessionID/orchestration",
      describeRoute({
        summary: "Read scientific orchestration state",
        operationId: "harness.orchestration.status",
        responses: {
          200: {
            description: "Scientific orchestration state",
            content: { "application/json": { schema: resolver(HarnessOrchestrator.State) } },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", SessionID),
      async (c) => c.json(await HarnessOrchestrator.read(c.req.valid("param").sessionID)),
    )
    .post(
      "/runs/:sessionID/orchestration/checkpoints",
      describeRoute({
        summary: "Record an evaluator-authenticated orchestration utility checkpoint",
        description:
          "Gates the next evolution round and stops low-utility search without allowing worker self-scores to control budget.",
        operationId: "harness.orchestration.checkpoint",
        responses: {
          200: {
            description: "Scientific orchestration state",
            content: { "application/json": { schema: resolver(HarnessOrchestrator.State) } },
          },
          ...errors(400, 403, 404, 409),
        },
      }),
      validator("param", SessionID),
      validator("json", HarnessOrchestrator.CheckpointSubmit),
      async (c) => {
        const input = c.req.valid("json")
        const sessionID = c.req.valid("param").sessionID
        const contract = await HarnessAdapter.authorize(sessionID, input.evaluatorToken)
        return c.json(
          await HarnessOrchestrator.checkpoint(
            {
              sessionID,
              round: input.round,
              utility: input.utility,
              uncertainty: input.uncertainty,
              evidenceRefs: input.evidenceRefs,
              evaluatedAt: input.evaluatedAt,
            },
            contract,
          ),
        )
      },
    )
    .post(
      "/runs",
      describeRoute({
        summary: "Bind an immutable benchmark run",
        description:
          "Called by a benchmark orchestrator before agent execution. The evaluator capability is hashed and never returned.",
        operationId: "harness.bind",
        responses: {
          200: {
            description: "Bound harness contract",
            content: { "application/json": { schema: resolver(HarnessContract.Info) } },
          },
          ...errors(400, 409),
        },
      }),
      validator("json", HarnessAdapter.Task),
      async (c) => c.json(await HarnessAdapter.bind(c.req.valid("json"))),
    )
    .post(
      "/evaluations",
      describeRoute({
        summary: "Ingest an evaluator-authenticated result",
        description:
          "Records an immutable subject result, promotes a verified search candidate, and captures task-scoped hindsight.",
        operationId: "harness.evaluate",
        responses: { 200: { description: "Recorded external evaluation" }, ...errors(400, 403, 409) },
      }),
      validator("json", HarnessAdapter.Evaluation),
      async (c) => c.json(await HarnessAdapter.ingest(c.req.valid("json"))),
    )
    .post(
      "/compare",
      describeRoute({
        summary: "Compare compatible benchmark runs",
        description: "Reports direction-aware deltas and the quality-cost Pareto frontier.",
        operationId: "harness.compare",
        responses: { 200: { description: "Comparable run deltas" }, ...errors(400) },
      }),
      validator("json", Compare),
      async (c) => {
        const input = c.req.valid("json")
        const reports = await Promise.all(input.sessionIDs.map((sessionID) => HarnessReport.build(sessionID)))
        return c.json(HarnessReport.compare(reports, input.baselineRunID))
      },
    )
    .get(
      "/skills",
      describeRoute({
        summary: "List quarantined learned skill proposals",
        operationId: "harness.skills",
        responses: {
          200: {
            description: "Learned skill qualification manifests",
            content: { "application/json": { schema: resolver(z.array(HarnessSkill.Manifest)) } },
          },
        },
      }),
      async (c) => c.json(await HarnessSkill.list()),
    )
    .post(
      "/skills",
      describeRoute({
        summary: "Create an inactive learned skill proposal",
        operationId: "harness.skill.propose",
        responses: {
          200: {
            description: "Quarantined proposal",
            content: { "application/json": { schema: resolver(HarnessSkill.Manifest.nullable()) } },
          },
          ...errors(400, 409),
        },
      }),
      validator("json", HarnessSkill.ProposalInput),
      async (c) => c.json(await HarnessSkill.propose(c.req.valid("json"))),
    )
    .post(
      "/skills/evidence",
      describeRoute({
        summary: "Attach paired held-out skill evidence",
        description:
          "Requires both evaluator capabilities and accepts only otherwise-identical candidate/control contracts.",
        operationId: "harness.skill.attest",
        responses: { 200: { description: "Updated qualification state" }, ...errors(400, 403, 409) },
      }),
      validator("json", HarnessSkill.Attestation),
      async (c) => c.json(await HarnessSkill.attest(c.req.valid("json"))),
    )
    .post(
      "/skills/:name/promotion",
      describeRoute({
        summary: "Promote a qualified learned skill",
        description: "Copies only an unchanged proposal that has met every held-out qualification criterion.",
        operationId: "harness.skill.promote",
        responses: { 200: { description: "Promoted skill" }, ...errors(400, 409) },
      }),
      validator("param", z.object({ name: z.string().min(1) })),
      async (c) => c.json(await HarnessSkill.promote(c.req.valid("param").name)),
    )
    .get(
      "/runs/:sessionID/contract",
      describeRoute({
        summary: "Read a bound harness contract",
        operationId: "harness.contract",
        responses: {
          200: {
            description: "Harness contract",
            content: { "application/json": { schema: resolver(HarnessContract.Info.nullable()) } },
          },
          ...errors(400),
        },
      }),
      validator("param", SessionID),
      async (c) => c.json(await HarnessContract.read(c.req.valid("param").sessionID)),
    )
    .get(
      "/runs/:sessionID/evaluations",
      describeRoute({
        summary: "List immutable harness evaluations",
        operationId: "harness.evaluations",
        responses: {
          200: {
            description: "Evaluation journal",
            content: { "application/json": { schema: resolver(z.array(HarnessEvaluation.Info)) } },
          },
          ...errors(400),
        },
      }),
      validator("param", SessionID),
      async (c) => c.json(await HarnessEvaluation.list(c.req.valid("param").sessionID)),
    )
    .get(
      "/runs/:sessionID/report",
      describeRoute({
        summary: "Build a benchmark quality-cost report",
        operationId: "harness.report",
        responses: {
          200: {
            description: "Quality-cost report",
            content: { "application/json": { schema: resolver(HarnessReport.Info) } },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", SessionID),
      async (c) => c.json(await HarnessReport.build(c.req.valid("param").sessionID)),
    ),
)

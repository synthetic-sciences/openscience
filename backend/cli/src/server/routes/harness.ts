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
import { HarnessOrchestrator } from "@/session/harness/orchestrator"
import { HarnessReport } from "@/session/harness/report"
import { HarnessSimulation } from "@/session/harness/simulation"
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
        description: "Lists version-agnostic adapter manifests and their required verification packs.",
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

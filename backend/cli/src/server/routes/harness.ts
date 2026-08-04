import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { lazy } from "@/util/lazy"
import { HarnessAdapter } from "@/session/harness/adapter"
import { HarnessBenchmark } from "@/session/harness/benchmark"
import { HarnessContract } from "@/session/harness/contract"
import { HarnessEvaluation } from "@/session/harness/evaluation"
import { HarnessReport } from "@/session/harness/report"
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

import { Hono } from "hono"
import { describeRoute, resolver, validator } from "hono-openapi"
import z from "zod"
import { lazy } from "@synsci/util/lazy"
import { Experiments } from "../../experiments"
import { StudyDriver } from "../../experiments/driver"
import { GpuInventory } from "../../experiments/gpu"
import { StudyLedger } from "../../experiments/ledger"
import { errors } from "../error"

const Overview = z
  .object({
    study: Experiments.Study,
    ideas: Experiments.Idea.array(),
    runs: Experiments.Run.array(),
    events: Experiments.StudyEvent.array(),
    baseline: Experiments.Run.optional(),
    best: Experiments.Run.optional(),
  })
  .meta({ ref: "StudyOverview" })

const SeriesResponse = z
  .object({
    runID: z.string(),
    key: z.string(),
    points: z.array(z.object({ step: z.number(), value: z.number() })),
  })
  .array()
  .meta({ ref: "ExperimentSeries" })

/**
 * Experiment tracking for the workspace pane and for scripts that report
 * over HTTP. Sandboxed compute jobs never reach this surface; their records
 * come out of the job log.
 */
export const ExperimentsRoutes = lazy(() =>
  new Hono()
    .get(
      "/runs",
      describeRoute({
        summary: "List tracked runs",
        operationId: "experiments.runs",
        responses: {
          200: { description: "Runs", content: { "application/json": { schema: resolver(Experiments.Run.array()) } } },
        },
      }),
      validator(
        "query",
        z.object({
          directory: z.string().optional(),
          study_id: z.string().optional(),
          status: Experiments.RunStatus.optional(),
          limit: z.coerce.number().int().min(1).max(2000).optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        return c.json(await Experiments.listRuns({ studyID: query.study_id, status: query.status, limit: query.limit }))
      },
    )
    .get(
      "/runs/:runID",
      describeRoute({
        summary: "Get one tracked run",
        operationId: "experiments.run",
        responses: {
          200: { description: "Run", content: { "application/json": { schema: resolver(Experiments.Run) } } },
          ...errors(404),
        },
      }),
      validator("param", z.object({ runID: z.string() })),
      async (c) => {
        const run = await Experiments.getRun(c.req.valid("param").runID)
        if (!run) return c.json({ error: "Run not found" }, 404)
        return c.json(run)
      },
    )
    .get(
      "/series",
      describeRoute({
        summary: "Downsampled metric series for runs",
        operationId: "experiments.series",
        responses: {
          200: { description: "Series", content: { "application/json": { schema: resolver(SeriesResponse) } } },
        },
      }),
      validator(
        "query",
        z.object({
          directory: z.string().optional(),
          run_ids: z.string().min(1),
          keys: z.string().optional(),
          max: z.coerce.number().int().min(10).max(5000).optional(),
        }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        return c.json(
          await Experiments.series({
            runIDs: query.run_ids.split(",").filter(Boolean),
            keys: query.keys ? query.keys.split(",").filter(Boolean) : undefined,
            max: query.max,
          }),
        )
      },
    )
    .get(
      "/keys",
      describeRoute({
        summary: "Metric names logged by runs",
        operationId: "experiments.keys",
        responses: {
          200: { description: "Keys", content: { "application/json": { schema: resolver(z.string().array()) } } },
        },
      }),
      validator(
        "query",
        z.object({ directory: z.string().optional(), run_ids: z.string().optional(), study_id: z.string().optional() }),
      ),
      async (c) => {
        const query = c.req.valid("query")
        return c.json(
          await Experiments.metricKeys({
            runIDs: query.run_ids ? query.run_ids.split(",").filter(Boolean) : undefined,
            studyID: query.study_id,
          }),
        )
      },
    )
    .get(
      "/gpus",
      describeRoute({
        summary: "Local GPU inventory",
        operationId: "experiments.gpus",
        responses: {
          200: { description: "GPUs", content: { "application/json": { schema: resolver(GpuInventory.Gpu.array()) } } },
        },
      }),
      async (c) => c.json(await GpuInventory.list()),
    )
    .get(
      "/studies",
      describeRoute({
        summary: "List studies",
        operationId: "experiments.studies",
        responses: {
          200: {
            description: "Studies",
            content: { "application/json": { schema: resolver(Experiments.Study.array()) } },
          },
        },
      }),
      async (c) => c.json(await Experiments.listStudies()),
    )
    .get(
      "/studies/:studyID",
      describeRoute({
        summary: "Study overview: ideas, runs, events, baseline and best",
        operationId: "experiments.study",
        responses: {
          200: { description: "Overview", content: { "application/json": { schema: resolver(Overview) } } },
          ...errors(404),
        },
      }),
      validator("param", z.object({ studyID: z.string() })),
      async (c) => {
        const overview = await Experiments.overview(c.req.valid("param").studyID)
        if (!overview) return c.json({ error: "Study not found" }, 404)
        return c.json(overview)
      },
    )
    .post(
      "/studies/:studyID/:action",
      describeRoute({
        summary: "Pause, resume, halt or re-render a study",
        operationId: "experiments.studyControl",
        responses: {
          200: { description: "Study", content: { "application/json": { schema: resolver(Experiments.Study) } } },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ studyID: z.string(), action: z.enum(["pause", "resume", "halt", "render"]) })),
      async (c) => {
        const { studyID, action } = c.req.valid("param")
        const study = await Experiments.getStudy(studyID)
        if (!study) return c.json({ error: "Study not found" }, 404)
        if (action === "pause") await StudyDriver.pause(studyID)
        if (action === "resume") {
          await StudyDriver.resume(studyID)
          StudyDriver.start()
        }
        if (action === "halt") await StudyDriver.halt(studyID)
        if (action === "render") await StudyLedger.render(studyID)
        return c.json((await Experiments.getStudy(studyID))!)
      },
    )
    .post(
      "/studies/:studyID/directives",
      describeRoute({
        summary: "Add a standing directive; the session is woken with it",
        operationId: "experiments.directive",
        responses: {
          200: { description: "Study", content: { "application/json": { schema: resolver(Experiments.Study) } } },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ studyID: z.string() })),
      validator("json", z.object({ text: z.string().trim().min(1).max(2_000) })),
      async (c) => {
        const { studyID } = c.req.valid("param")
        const study = await Experiments.getStudy(studyID)
        if (!study) return c.json({ error: "Study not found" }, 404)
        const added = await StudyDriver.directive(studyID, c.req.valid("json").text)
        StudyDriver.start()
        return c.json(added?.study ?? study)
      },
    )
    .post(
      "/studies/:studyID/directives/:directiveID/retire",
      describeRoute({
        summary: "Retire a standing directive",
        operationId: "experiments.retireDirective",
        responses: {
          200: { description: "Study", content: { "application/json": { schema: resolver(Experiments.Study) } } },
          ...errors(404),
        },
      }),
      validator("param", z.object({ studyID: z.string(), directiveID: z.string() })),
      async (c) => {
        const { studyID, directiveID } = c.req.valid("param")
        const updated = await Experiments.retireDirective(studyID, directiveID)
        if (!updated) return c.json({ error: "Study not found" }, 404)
        return c.json(updated)
      },
    )
    .patch(
      "/studies/:studyID/ideas/:ideaID",
      describeRoute({
        summary: "Reprioritize or drop an idea",
        operationId: "experiments.idea",
        responses: {
          200: { description: "Idea", content: { "application/json": { schema: resolver(Experiments.Idea) } } },
          ...errors(404),
        },
      }),
      validator("param", z.object({ studyID: z.string(), ideaID: z.string() })),
      validator(
        "json",
        z.object({ priority: z.number().int().optional(), status: z.enum(["queued", "dropped"]).optional() }),
      ),
      async (c) => {
        const { ideaID, studyID } = c.req.valid("param")
        const body = c.req.valid("json")
        const idea = await Experiments.getIdea(ideaID)
        if (!idea || idea.studyID !== studyID) return c.json({ error: "Idea not found" }, 404)
        const updated = await Experiments.updateIdea(ideaID, body)
        await StudyLedger.render(studyID).catch(() => undefined)
        return c.json(updated!)
      },
    )
    // ── HTTP ingest for scripts outside a compute job ────────────────────
    .post(
      "/ingest/runs",
      describeRoute({
        summary: "Register a run reported over HTTP",
        operationId: "experiments.ingestRun",
        responses: {
          200: {
            description: "Run identity",
            content: { "application/json": { schema: resolver(z.object({ id: z.string(), token: z.string() })) } },
          },
        },
      }),
      validator(
        "json",
        z.object({
          name: z.string().trim().min(1).max(200),
          project: z.string().optional(),
          config: z.record(z.string(), z.unknown()).optional(),
          study_id: z.string().optional(),
          session_id: z.string().optional(),
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const run = await Experiments.createRun({
          name: body.name,
          source: "external",
          config: body.config,
          studyID: body.study_id,
          sessionID: body.session_id,
        })
        return c.json({ id: run.id, token: run.id })
      },
    )
    .post(
      "/ingest/runs/:runID/points",
      describeRoute({
        summary: "Append metric points to a run",
        operationId: "experiments.ingestPoints",
        responses: {
          200: {
            description: "Accepted count",
            content: { "application/json": { schema: resolver(z.object({ accepted: z.number() })) } },
          },
          ...errors(404),
        },
      }),
      validator("param", z.object({ runID: z.string() })),
      validator("json", z.object({ points: Experiments.Point.array().max(10_000) })),
      async (c) => {
        const result = await Experiments.ingest(c.req.valid("param").runID, c.req.valid("json").points)
        if (!result) return c.json({ error: "Run not found" }, 404)
        return c.json({ accepted: result.accepted })
      },
    )
    .post(
      "/ingest/runs/:runID/summary",
      describeRoute({
        summary: "Merge summary values into a run",
        operationId: "experiments.ingestSummary",
        responses: {
          200: { description: "Run", content: { "application/json": { schema: resolver(Experiments.Run) } } },
          ...errors(404),
        },
      }),
      validator("param", z.object({ runID: z.string() })),
      validator("json", z.object({ summary: z.record(z.string(), z.unknown()) })),
      async (c) => {
        const run = await Experiments.summarize(c.req.valid("param").runID, c.req.valid("json").summary)
        if (!run) return c.json({ error: "Run not found" }, 404)
        return c.json(run)
      },
    )
    .post(
      "/ingest/runs/:runID/finish",
      describeRoute({
        summary: "Finish a run reported over HTTP",
        operationId: "experiments.ingestFinish",
        responses: {
          200: { description: "Run", content: { "application/json": { schema: resolver(Experiments.Run) } } },
          ...errors(404),
        },
      }),
      validator("param", z.object({ runID: z.string() })),
      validator("json", z.object({ status: z.enum(["finished", "failed"]).optional() })),
      async (c) => {
        const run = await Experiments.finishRun(c.req.valid("param").runID, c.req.valid("json").status ?? "finished")
        if (!run) return c.json({ error: "Run not found" }, 404)
        return c.json(run)
      },
    ),
)

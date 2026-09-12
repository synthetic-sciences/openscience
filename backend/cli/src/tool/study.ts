import path from "node:path"
import z from "zod"
import { Experiments } from "@/experiments"
import { StudyDriver } from "@/experiments/driver"
import { GpuInventory } from "@/experiments/gpu"
import { KillCriteria } from "@/experiments/kill"
import { StudyLedger } from "@/experiments/ledger"
import { TrackingSDK } from "@/experiments/sdk"
import { SessionFilesystem } from "@/session/filesystem"
import { ComputeJobTool } from "./compute-job"
import { runSummary } from "./experiments"
import { Tool } from "./tool"
import DESCRIPTION from "./study.txt"

const Action = z.enum(["create", "status", "propose", "start", "record", "drop", "conclude"])
type Metadata = {
  study?: Experiments.Study
  ideas?: Experiments.Idea[]
  idea?: Experiments.Idea
  run?: Experiments.Run
  job?: { id: string; status: string }
}

const IdeaInput = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(4_000),
  why: z.string().trim().min(1).max(2_000),
  ev: z.number().describe("Expected improvement in metric units times your confidence (0-1)."),
  config: z.record(z.string(), z.unknown()).optional(),
  priority: z.number().int().optional().describe("Higher runs sooner regardless of EV; 1000 for the baseline."),
})

export const StudyTool = Tool.define("study", {
  description: DESCRIPTION,
  parameters: z.object({
    action: Action,
    study_id: z.string().optional(),
    // create
    name: z.string().trim().min(1).max(120).optional(),
    purpose: z.string().trim().min(1).max(4_000).optional(),
    metric: z.string().trim().min(1).max(120).optional(),
    direction: Experiments.Direction.optional(),
    target: Experiments.Target.optional(),
    concurrency: z.number().int().min(1).max(64).optional(),
    kill_criteria: z.string().max(1_000).optional(),
    budget: Experiments.Budget.optional(),
    review: z.boolean().optional().describe("Ask the critique agent to review the training code before the baseline."),
    root: z
      .string()
      .max(400)
      .optional()
      .describe("Relative folder for the study's files; defaults to the working folder."),
    // propose
    ideas: z.array(IdeaInput).max(50).optional(),
    // start
    idea_id: z.string().optional(),
    command: z.string().trim().min(1).max(20_000).optional(),
    cwd: z.string().max(2_000).optional(),
    artifacts: z.array(z.string().trim().min(1).max(2_000)).max(50).optional(),
    packages: z.array(z.string().trim().min(1).max(500)).max(100).optional(),
    image: z.string().trim().min(1).max(2_000).optional(),
    gpu: z.string().trim().min(1).max(120).optional(),
    uploads: z.array(z.string().trim().min(1).max(2_000)).max(100).optional(),
    // record
    run_id: z.string().optional(),
    kept: z.boolean().optional(),
    analysis: z.string().max(8_000).optional(),
    conclusion: z.string().max(8_000).optional(),
    lessons: z.string().max(4_000).optional(),
    baseline: z.boolean().optional(),
    // drop
    reason: z.string().max(2_000).optional(),
  }),
  async execute(params, ctx) {
    await ctx.ask({ permission: "study", patterns: ["*"], always: ["*"], metadata: {} })
    const json = (value: unknown) => JSON.stringify(value, null, 1)
    const current = params.study_id
      ? await Experiments.getStudy(params.study_id)
      : await Experiments.studyForSession(ctx.sessionID)

    if (params.action === "create") {
      if (current) {
        throw new Error(
          `This session already drives study ${current.id} (${current.name}). Conclude it before creating another.`,
        )
      }
      if (!params.name || !params.purpose || !params.metric || !params.direction) {
        throw new Error("create needs name, purpose, metric and direction")
      }
      const base = await SessionFilesystem.toolDirectory(ctx.sessionID)
      const root = params.root ? path.resolve(base, params.root) : base
      if (path.relative(base, root).startsWith("..")) throw new Error("root must stay inside the working folder")
      const criteria = KillCriteria.parse(params.kill_criteria ?? "")
      if (criteria.unparsed.length) {
        throw new Error(
          `Could not read kill criteria: ${criteria.unparsed.join("; ")}. Use forms like "1 hour", "5000 steps", "val_loss plateaus for 500 steps", "val_loss > 5 for 100 steps", joined by OR.`,
        )
      }
      const slots = params.target?.kind === "local" || !params.target ? await GpuInventory.slots() : []
      const concurrency = Math.max(1, Math.min(params.concurrency ?? (slots.length || 1), 64))
      const study = await Experiments.createStudy({
        sessionID: ctx.sessionID,
        name: params.name,
        purpose: params.purpose,
        metric: params.metric,
        direction: params.direction,
        root,
        target: params.target ?? { kind: "local" },
        concurrency,
        killCriteria: params.kill_criteria ?? "",
        budget: params.budget ?? {},
        review: params.review,
      })
      await TrackingSDK.materialize(root, { shim: true })
      await StudyLedger.render(study.id)
      StudyDriver.start()
      ctx.metadata({ title: `Study: ${study.name}`, metadata: { study } })
      return {
        title: `Study created: ${study.name}`,
        metadata: { study } satisfies Metadata as Metadata,
        output: [
          `Study ${study.id} is running in ${root}.`,
          `Metric: ${study.direction} ${study.metric}. Concurrency ${study.concurrency}${slots.length > 1 ? ` (${slots.length} local GPUs, one run per GPU)` : ""}. Kill criteria: ${study.killCriteria || "none"}. Budget: ${json(study.budget)}.`,
          `Tracking SDK written to ${TrackingSDK.DIRECTORY}/ (import openscience_track, or wandb). Training scripts must log ${study.metric}.`,
          `Next: propose the baseline (priority 1000) and the first ideas, then start the baseline. Files study.md, ideas.md, results.tsv and lessons.md are rendered in the root as the study advances.`,
        ].join("\n"),
      }
    }

    if (!current) {
      throw new Error("No study is active in this session. Create one with study create first.")
    }

    if (params.action === "status") {
      const overview = (await Experiments.overview(current.id))!
      const queued = overview.ideas.filter((idea) => idea.status === "queued")
      const running = overview.runs.filter((run) => run.status === "running")
      const recent = overview.runs.filter((run) => run.status !== "running").slice(0, 10)
      return {
        title: `Study: ${current.name}`,
        metadata: { study: overview.study } satisfies Metadata as Metadata,
        output: json({
          study: {
            id: current.id,
            name: current.name,
            status: current.status,
            metric: current.metric,
            direction: current.direction,
            concurrency: current.concurrency,
            kill_criteria: current.killCriteria,
            budget: current.budget,
            runs_completed: overview.runs.filter((run) => run.status !== "running").length,
            elapsed_hours: Number(((Date.now() - current.createdAt) / 3_600_000).toFixed(2)),
          },
          baseline: overview.baseline ? runSummary(overview.baseline) : null,
          best: overview.best ? runSummary(overview.best) : null,
          running: running.map(runSummary),
          recent: recent.map(runSummary),
          queue: queued.slice(0, 10).map((idea) => ({
            idea_id: idea.id,
            title: idea.title,
            ev: idea.ev,
            priority: idea.priority,
            config: idea.config,
          })),
          lessons: current.lessons.split("\n").slice(-8).join("\n"),
        }),
      }
    }

    if (params.action === "propose") {
      if (!params.ideas?.length) throw new Error("propose needs ideas")
      const created = await Experiments.proposeIdeas(current.id, params.ideas)
      await StudyLedger.render(current.id)
      return {
        title: `${created.length} idea${created.length === 1 ? "" : "s"} queued`,
        metadata: { study: current, ideas: created } satisfies Metadata as Metadata,
        output: json(
          created.map((idea) => ({ idea_id: idea.id, title: idea.title, ev: idea.ev, priority: idea.priority })),
        ),
      }
    }

    if (params.action === "start") {
      if (!params.idea_id || !params.command) throw new Error("start needs idea_id and command")
      if (current.status !== "running") throw new Error(`The study is ${current.status}; it accepts no new runs.`)
      const idea = await Experiments.getIdea(params.idea_id)
      if (!idea || idea.studyID !== current.id) throw new Error(`Idea ${params.idea_id} is not in this study`)
      if (idea.status !== "queued") throw new Error(`Idea ${idea.id} is ${idea.status}; one run per idea.`)
      const running = await Experiments.listRuns({ studyID: current.id, status: "running" })
      if (running.length >= current.concurrency) {
        throw new Error(
          `${running.length} run${running.length === 1 ? " is" : "s are"} already live (concurrency ${current.concurrency}). Wait for a study update.`,
        )
      }
      const base = await SessionFilesystem.toolDirectory(ctx.sessionID)
      const cwd = params.cwd ? path.resolve(base, params.cwd) : current.root
      const relative = path.relative(base, cwd)
      if (relative.startsWith("..")) throw new Error("cwd must stay inside the working folder")
      const entries = await TrackingSDK.materialize(cwd, { shim: true })
      const target = params.target ?? current.target
      const slot =
        target.kind === "local"
          ? (await GpuInventory.slots()).find((candidate) => !running.some((run) => run.slot === candidate))
          : undefined
      const run = await Experiments.createRun({
        name: idea.title,
        source: "job",
        studyID: current.id,
        ideaID: idea.id,
        sessionID: ctx.sessionID,
        config: idea.config,
        slot: slot ?? undefined,
      })
      const command = TrackingSDK.wrap(params.command, {
        runID: run.id,
        name: idea.title,
        entries,
        slot: target.kind === "local" && (await GpuInventory.list()).length ? slot : undefined,
      })
      const compute = await ComputeJobTool.init({ agent: undefined })
      const result = await compute
        .execute(
          {
            action: "start",
            name: `${current.name}: ${idea.title}`.slice(0, 120),
            purpose: `Study ${current.id} run for idea ${idea.id}: ${idea.description}`.slice(0, 500),
            command,
            cwd: relative || undefined,
            target: target.kind === "modal" ? { kind: "modal" } : target,
            artifacts: params.artifacts,
            packages: params.packages,
            image: params.image,
            gpu: params.gpu ?? (target.kind === "modal" ? target.gpu : undefined),
            uploads: params.uploads,
          },
          ctx,
        )
        .catch(async (error) => {
          await Experiments.finishRun(run.id, "failed", { killReason: `dispatch failed: ${String(error)}` })
          await Experiments.updateIdea(idea.id, { status: "queued", runID: undefined })
          throw error
        })
      const job = (result.metadata as { job?: { id: string; status: string } }).job
      if (!job) {
        await Experiments.finishRun(run.id, "failed", { killReason: "dispatch returned no job" })
        await Experiments.updateIdea(idea.id, { status: "queued", runID: undefined })
        throw new Error("The compute job was not dispatched")
      }
      await Experiments.bindJob(run.id, job.id)
      const bound = (await Experiments.getRun(run.id))!
      await Experiments.addEvent(current.id, "started", `${idea.title} started as run ${run.id} (job ${job.id})`, {
        runID: run.id,
      })
      await StudyDriver.follow(bound, current)
      StudyDriver.start()
      await StudyLedger.render(current.id)
      return {
        title: `Run started: ${idea.title}`,
        metadata: { study: current, run: bound, job } satisfies Metadata as Metadata,
        output: `Run ${run.id} for idea ${idea.id} is live as compute job ${job.id}${slot !== undefined && bound.slot !== null ? ` on slot ${bound.slot}` : ""}. You will receive a study update when it ends or is killed; meanwhile implement the next queued idea if a slot is free, or wait with compute_job wait.`,
      }
    }

    if (params.action === "record") {
      if (!params.run_id || params.kept === undefined || !params.analysis) {
        throw new Error("record needs run_id, kept and analysis")
      }
      const run = await Experiments.getRun(params.run_id)
      if (!run || run.studyID !== current.id) throw new Error(`Run ${params.run_id} is not in this study`)
      if (run.status === "running") throw new Error(`Run ${run.id} is still running; record it after it ends.`)
      if (params.baseline) await Experiments.setBaseline(current.id, run.id)
      const updated = await Experiments.recordResult({
        studyID: current.id,
        runID: run.id,
        kept: params.kept,
        analysis: params.analysis,
        conclusion: params.conclusion,
        lessons: params.lessons,
      })
      await StudyLedger.render(current.id)
      const fresh = (await Experiments.getRun(run.id))!
      return {
        title: `${run.name}: ${params.kept ? "kept" : "reverted"}`,
        metadata: { study: updated, run: fresh } satisfies Metadata as Metadata,
        output: `Recorded ${run.id} as ${params.kept ? "kept" : "reverted"}${params.baseline ? " and set as the baseline" : ""}. ${
          fresh.headline !== null
            ? `${current.metric} ${Experiments.format(fresh.headline)}`
            : `No ${current.metric} was logged`
        }${fresh.baselineDelta !== null ? ` (${fresh.baselineDelta >= 0 ? "+" : ""}${Experiments.format(fresh.baselineDelta)} vs baseline)` : ""}. Best run: ${updated?.bestRunID ?? "none"}.`,
      }
    }

    if (params.action === "drop") {
      if (!params.idea_id) throw new Error("drop needs idea_id")
      const idea = await Experiments.getIdea(params.idea_id)
      if (!idea || idea.studyID !== current.id) throw new Error(`Idea ${params.idea_id} is not in this study`)
      const updated = await Experiments.updateIdea(idea.id, { status: "dropped", conclusion: params.reason })
      await StudyLedger.render(current.id)
      return {
        title: `Dropped: ${idea.title}`,
        metadata: { study: current, idea: updated } satisfies Metadata as Metadata,
        output: `Idea ${idea.id} dropped${params.reason ? `: ${params.reason}` : ""}.`,
      }
    }

    if (!params.conclusion) throw new Error("conclude needs a conclusion")
    const concluded = await StudyDriver.conclude(current.id, params.conclusion)
    return {
      title: `Study concluded: ${current.name}`,
      metadata: { study: concluded } satisfies Metadata as Metadata,
      output: `Study ${current.id} concluded. Its files (study.md, ideas.md, results.tsv, lessons.md) are in ${current.root}.`,
    }
  },
})

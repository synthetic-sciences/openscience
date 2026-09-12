import z from "zod"
import { Experiments } from "@/experiments"
import { Tool } from "./tool"
import DESCRIPTION from "./experiments.txt"

const Action = z.enum(["runs", "keys", "series", "compare"])
type Metadata = { experiments: { action: string; count: number } }

function duration(run: Experiments.Run) {
  const end = run.endedAt ?? Date.now()
  if (!run.startedAt) return undefined
  const minutes = (end - run.startedAt) / 60_000
  return minutes < 1 ? `${Math.round(minutes * 60)}s` : `${minutes.toFixed(1)}m`
}

export function runSummary(run: Experiments.Run) {
  return {
    run_id: run.id,
    name: run.name,
    status: run.status,
    headline: run.headline,
    delta_vs_baseline: run.baselineDelta,
    points: run.points,
    last_step: run.lastStep,
    duration: duration(run),
    job_id: run.jobID,
    idea_id: run.ideaID,
    kill_reason: run.killReason,
    config: run.config,
  }
}

export const ExperimentsTool = Tool.define("experiments", {
  description: DESCRIPTION,
  parameters: z.object({
    action: Action,
    study_id: z.string().optional(),
    run_ids: z.array(z.string()).max(50).optional(),
    keys: z.array(z.string()).max(20).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    max: z.number().int().min(10).max(400).optional().describe("Points per series."),
  }),
  async execute(params, ctx) {
    await ctx.ask({ permission: "experiments", patterns: ["*"], always: ["*"], metadata: {} })
    const study = params.study_id
      ? await Experiments.getStudy(params.study_id)
      : await Experiments.studyForSession(ctx.sessionID)

    if (params.action === "runs") {
      const runs = await Experiments.listRuns({ studyID: study?.id, limit: params.limit ?? 20 })
      return {
        title: `${runs.length} run${runs.length === 1 ? "" : "s"}`,
        metadata: { experiments: { action: params.action, count: runs.length } } satisfies Metadata as Metadata,
        output: runs.length
          ? JSON.stringify({ metric: study?.metric, direction: study?.direction, runs: runs.map(runSummary) }, null, 1)
          : "No tracked runs yet.",
      }
    }

    if (params.action === "keys") {
      const keys = await Experiments.metricKeys({ runIDs: params.run_ids, studyID: study?.id })
      return {
        title: `${keys.length} metric${keys.length === 1 ? "" : "s"}`,
        metadata: { experiments: { action: params.action, count: keys.length } } satisfies Metadata as Metadata,
        output: keys.length ? keys.join(", ") : "No metrics logged yet.",
      }
    }

    if (params.action === "series") {
      if (!params.run_ids?.length) throw new Error("series needs run_ids")
      const series = await Experiments.series({ runIDs: params.run_ids, keys: params.keys, max: params.max ?? 50 })
      return {
        title: `${series.length} series`,
        metadata: { experiments: { action: params.action, count: series.length } } satisfies Metadata as Metadata,
        output: series.length
          ? series
              .map(
                (item) =>
                  `${item.runID} ${item.key}: ${item.points.map((point) => `${point.step}:${Experiments.format(point.value)}`).join(" ")}`,
              )
              .join("\n")
          : "No points for those runs and keys.",
      }
    }

    const all = await Experiments.listRuns({ studyID: study?.id, limit: 200 })
    const chosen = params.run_ids?.length
      ? all.filter((run) => params.run_ids!.includes(run.id))
      : [
          ...new Set(
            [
              study?.baselineRunID ? all.find((run) => run.id === study.baselineRunID) : undefined,
              study?.bestRunID ? all.find((run) => run.id === study.bestRunID) : undefined,
              ...all.slice(0, 5),
            ].filter((run): run is Experiments.Run => !!run),
          ),
        ]
    if (!chosen.length) {
      return {
        title: "Nothing to compare",
        metadata: { experiments: { action: params.action, count: 0 } } satisfies Metadata as Metadata,
        output: "No runs to compare yet.",
      }
    }
    const keys = await Experiments.metricKeys({ runIDs: chosen.map((run) => run.id) })
    const series = await Experiments.series({ runIDs: chosen.map((run) => run.id), keys, max: 10 })
    const finals = new Map<string, Record<string, number>>()
    for (const item of series) {
      const last = item.points.at(-1)
      if (!last) continue
      finals.set(item.runID, { ...(finals.get(item.runID) ?? {}), [item.key]: last.value })
    }
    const rows = chosen.map((run) => ({
      run_id: run.id,
      name: run.name,
      status: run.status,
      role: run.id === study?.baselineRunID ? "baseline" : run.id === study?.bestRunID ? "best" : undefined,
      headline: run.headline,
      delta_vs_baseline: run.baselineDelta,
      final: {
        ...finals.get(run.id),
        ...Object.fromEntries(Object.entries(run.summary).filter(([, v]) => typeof v === "number")),
      },
      config: run.config,
    }))
    return {
      title: `Compare ${rows.length} runs`,
      metadata: { experiments: { action: params.action, count: rows.length } } satisfies Metadata as Metadata,
      output: JSON.stringify({ metric: study?.metric, direction: study?.direction, runs: rows }, null, 1),
    }
  },
})

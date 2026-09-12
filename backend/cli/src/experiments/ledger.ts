import fs from "node:fs/promises"
import path from "node:path"
import { Experiments } from "."

/**
 * The study's files in the working folder. They are rendered from the store
 * after every change, so a person, git, or a later session can read the
 * study the way Karpathy's autoresearch loop laid it out: the program, the
 * idea queue, the keep/revert ledger, and the lessons. Nothing parses them
 * back; the store is the source of truth and the agent writes through the
 * study tool.
 */
export namespace StudyLedger {
  export const FILES = ["study.md", "ideas.md", "results.tsv", "lessons.md"] as const

  const badge: Record<Experiments.IdeaStatus, string> = {
    queued: "queued",
    running: "running",
    kept: "kept",
    reverted: "reverted",
    failed: "failed",
    dropped: "dropped",
  }

  function stamp(value: number | null | undefined) {
    return value ? new Date(value).toISOString().slice(0, 16).replace("T", " ") : ""
  }

  export function ideasMarkdown(study: Experiments.Study, ideas: Experiments.Idea[], runs: Experiments.Run[]) {
    const byID = new Map(runs.map((run) => [run.id, run]))
    const lines = [
      `# ${study.name}: ideas`,
      "",
      `Objective: ${study.direction} \`${study.metric}\`. Ranked by manual priority, then expected value. Rendered by OpenScience from the study record; edit through the study tool.`,
      "",
    ]
    for (const idea of ideas) {
      const run = idea.runID ? byID.get(idea.runID) : undefined
      lines.push("#")
      lines.push(`- idea_id: \`${idea.id}\``)
      lines.push(`- Title: ${idea.title}`)
      lines.push(`- Description: ${idea.description}`)
      lines.push(`- EV Improvement: ${idea.ev}`)
      lines.push(`- Why: ${idea.why}`)
      lines.push(`- Status: ${badge[idea.status]}`)
      lines.push(`- Config: \`${JSON.stringify(idea.config)}\``)
      lines.push(`- Created: ${stamp(idea.createdAt)}`)
      if (idea.startedAt || idea.endedAt) lines.push(`- Run: ${stamp(idea.startedAt)} - ${stamp(idea.endedAt)}`)
      if (run) {
        const headline = run.headline !== null ? Experiments.format(run.headline) : "n/a"
        const delta =
          run.baselineDelta !== null
            ? ` (${run.baselineDelta >= 0 ? "+" : ""}${Experiments.format(run.baselineDelta)} vs baseline)`
            : ""
        lines.push(
          `- Result: ${study.metric} ${headline}${delta}; run \`${run.id}\`${run.jobID ? `, job \`${run.jobID}\`` : ""}`,
        )
      }
      if (idea.analysis) lines.push(`- Analysis: ${idea.analysis}`)
      if (idea.conclusion) lines.push(`- Conclusion: ${idea.conclusion}`)
      lines.push("#")
      lines.push("")
    }
    if (!ideas.length) lines.push("No ideas yet.", "")
    return lines.join("\n")
  }

  export function resultsTsv(study: Experiments.Study, runs: Experiments.Run[], ideas: Experiments.Idea[]) {
    const ideaByRun = new Map(ideas.filter((idea) => idea.runID).map((idea) => [idea.runID!, idea]))
    const header = [
      "run_id",
      "name",
      "status",
      "verdict",
      study.metric,
      "delta_vs_baseline",
      "started_at",
      "ended_at",
      "job_id",
    ].join("\t")
    const rows = [...runs]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((run) =>
        [
          run.id,
          run.name.replace(/\t/g, " "),
          run.status,
          ideaByRun.get(run.id)?.status ?? (run.id === study.baselineRunID ? "baseline" : ""),
          run.headline !== null ? String(run.headline) : "",
          run.baselineDelta !== null ? String(run.baselineDelta) : "",
          stamp(run.startedAt),
          stamp(run.endedAt),
          run.jobID ?? "",
        ].join("\t"),
      )
    return [header, ...rows].join("\n") + "\n"
  }

  export function studyMarkdown(study: Experiments.Study, best?: Experiments.Run, baseline?: Experiments.Run) {
    const budget = Object.entries(study.budget)
      .filter(([, value]) => value !== undefined)
      .map(([key, value]) => `${key} ${value}`)
      .join(", ")
    return [
      `# ${study.name}`,
      "",
      "## Purpose",
      study.purpose,
      "",
      "## Objective",
      `${study.direction} \`${study.metric}\``,
      "",
      "## Rules",
      `- Target: ${study.target.kind}${"gpu" in study.target && study.target.gpu ? ` (${study.target.gpu})` : ""}, ${study.concurrency} run${study.concurrency === 1 ? "" : "s"} at a time`,
      `- Kill criteria: ${study.killCriteria || "none"}`,
      `- Budget: ${budget || "none"}`,
      `- Code review before the baseline: ${study.review ? "yes" : "no"}`,
      "",
      "## State",
      `- Status: ${study.status}`,
      `- Baseline: ${baseline ? `${baseline.name} (${study.metric} ${baseline.headline !== null ? Experiments.format(baseline.headline) : "n/a"})` : "not set"}`,
      `- Best: ${best ? `${best.name} (${study.metric} ${best.headline !== null ? Experiments.format(best.headline) : "n/a"})` : "none yet"}`,
      `- Driver turns: ${study.turns}`,
      ...(study.conclusion ? ["", "## Conclusion", study.conclusion] : []),
      "",
      "## The loop",
      "1. Pick the highest-priority queued idea (ideas.md).",
      "2. Implement it in the training script; start one run per idea with the study tool.",
      "3. When the run ends, read the metric, decide keep or revert, and record the verdict with its analysis.",
      "4. Queue the ideas the result suggests. Repeat until the budget or target is reached.",
      "",
    ].join("\n")
  }

  export function lessonsMarkdown(study: Experiments.Study) {
    return [`# ${study.name}: lessons`, "", study.lessons || "No lessons recorded yet.", ""].join("\n")
  }

  export async function render(studyID: string, input?: { projectID?: string }) {
    const overview = await Experiments.overview(studyID, input)
    if (!overview) return
    const { study, ideas, runs, best, baseline } = overview
    const root = study.root
    await fs.mkdir(root, { recursive: true })
    await Promise.all([
      fs.writeFile(path.join(root, "study.md"), studyMarkdown(study, best, baseline)),
      fs.writeFile(path.join(root, "ideas.md"), ideasMarkdown(study, ideas, runs)),
      fs.writeFile(path.join(root, "results.tsv"), resultsTsv(study, runs, ideas)),
      fs.writeFile(path.join(root, "lessons.md"), lessonsMarkdown(study)),
    ])
  }
}

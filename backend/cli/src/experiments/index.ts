import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { Global } from "@/global"
import { Identifier } from "@/id/id"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"

/**
 * Experiment tracking and research studies.
 *
 * A run is one execution of a training or analysis script that reports
 * metrics. A study is a research loop over runs: an objective metric, a
 * baseline, a queue of ideas ranked by expected value, and a ledger of what
 * was kept or reverted. Runs and studies belong to a project and live in one
 * SQLite file per project under the data root, so charts and the ledger
 * survive sessions and server restarts.
 */
export namespace Experiments {
  const log = Log.create({ service: "experiments" })

  export const Direction = z.enum(["minimize", "maximize"])
  export type Direction = z.infer<typeof Direction>

  export const RunStatus = z.enum(["running", "finished", "failed", "killed", "cancelled"])
  export type RunStatus = z.infer<typeof RunStatus>

  export const StudyStatus = z.enum(["running", "paused", "halted", "concluded"])
  export type StudyStatus = z.infer<typeof StudyStatus>

  export const IdeaStatus = z.enum(["queued", "running", "kept", "reverted", "failed", "dropped"])
  export type IdeaStatus = z.infer<typeof IdeaStatus>

  export const Run = z
    .object({
      id: z.string(),
      projectID: z.string(),
      studyID: z.string().optional(),
      ideaID: z.string().optional(),
      jobID: z.string().optional(),
      sessionID: z.string().optional(),
      name: z.string(),
      status: RunStatus,
      source: z.enum(["job", "kernel", "external"]),
      config: z.record(z.string(), z.unknown()),
      summary: z.record(z.string(), z.unknown()),
      headline: z.number().nullable(),
      baselineDelta: z.number().nullable(),
      points: z.number().int().nonnegative(),
      lastStep: z.number().nullable(),
      slot: z.number().int().nullable(),
      killReason: z.string().optional(),
      createdAt: z.number(),
      startedAt: z.number().nullable(),
      endedAt: z.number().nullable(),
    })
    .meta({ ref: "ExperimentRun" })
  export type Run = z.infer<typeof Run>

  export const Budget = z
    .object({
      maxRuns: z.number().int().positive().optional(),
      maxHours: z.number().positive().optional(),
      maxCostUSD: z.number().positive().optional(),
      target: z.number().optional(),
      runMinutes: z.number().positive().optional(),
    })
    .meta({ ref: "StudyBudget" })
  export type Budget = z.infer<typeof Budget>

  export const Target = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("local") }),
    z.object({ kind: z.literal("ssh"), host_id: z.string() }),
    z.object({ kind: z.literal("modal"), gpu: z.string().optional() }),
  ])
  export type Target = z.infer<typeof Target>

  /** A standing instruction from the user, added mid-study from the pane or
   * chat. Directives stay in the study reminder until retired. */
  export const Directive = z
    .object({
      id: z.string(),
      text: z.string(),
      createdAt: z.number(),
      active: z.boolean(),
    })
    .meta({ ref: "StudyDirective" })
  export type Directive = z.infer<typeof Directive>

  export const Study = z
    .object({
      id: z.string(),
      projectID: z.string(),
      sessionID: z.string(),
      name: z.string(),
      purpose: z.string(),
      metric: z.string(),
      direction: Direction,
      status: StudyStatus,
      root: z.string(),
      target: Target,
      concurrency: z.number().int().positive(),
      killCriteria: z.string(),
      budget: Budget,
      review: z.boolean(),
      baselineRunID: z.string().optional(),
      bestRunID: z.string().optional(),
      turns: z.number().int().nonnegative(),
      costUSD: z.number().nonnegative(),
      lessons: z.string(),
      directives: z.array(Directive),
      conclusion: z.string().optional(),
      createdAt: z.number(),
      updatedAt: z.number(),
    })
    .meta({ ref: "Study" })
  export type Study = z.infer<typeof Study>

  export const Idea = z
    .object({
      id: z.string(),
      studyID: z.string(),
      title: z.string(),
      description: z.string(),
      why: z.string(),
      ev: z.number(),
      priority: z.number().int(),
      status: IdeaStatus,
      source: z.enum(["seed", "agent", "human", "lesson"]),
      config: z.record(z.string(), z.unknown()),
      runID: z.string().optional(),
      analysis: z.string().optional(),
      conclusion: z.string().optional(),
      createdAt: z.number(),
      startedAt: z.number().nullable(),
      endedAt: z.number().nullable(),
    })
    .meta({ ref: "StudyIdea" })
  export type Idea = z.infer<typeof Idea>

  export const StudyEvent = z
    .object({
      id: z.string(),
      studyID: z.string(),
      runID: z.string().optional(),
      kind: z.string(),
      message: z.string(),
      createdAt: z.number(),
    })
    .meta({ ref: "StudyEvent" })
  export type StudyEvent = z.infer<typeof StudyEvent>

  export const Point = z.object({
    key: z.string(),
    step: z.number(),
    value: z.number(),
    ts: z.number().optional(),
  })
  export type Point = z.infer<typeof Point>

  export const Event = {
    RunUpdated: BusEvent.define("experiment.run.updated", z.object({ run: Run })),
    RunPoints: BusEvent.define(
      "experiment.run.points",
      z.object({ runID: z.string(), keys: z.array(z.string()), lastStep: z.number().nullable() }),
    ),
    StudyUpdated: BusEvent.define("experiment.study.updated", z.object({ study: Study })),
    IdeaUpdated: BusEvent.define("experiment.idea.updated", z.object({ idea: Idea })),
    StudyEvent: BusEvent.define("experiment.study.event", z.object({ event: StudyEvent })),
  }

  const schema = `
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS study (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      name TEXT NOT NULL,
      purpose TEXT NOT NULL,
      metric TEXT NOT NULL,
      direction TEXT NOT NULL,
      status TEXT NOT NULL,
      root TEXT NOT NULL,
      target TEXT NOT NULL,
      concurrency INTEGER NOT NULL,
      kill_criteria TEXT NOT NULL,
      budget TEXT NOT NULL,
      review INTEGER NOT NULL,
      baseline_run_id TEXT,
      best_run_id TEXT,
      turns INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      lessons TEXT NOT NULL DEFAULT '',
      directives TEXT NOT NULL DEFAULT '[]',
      conclusion TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS study_project ON study(project_id, created_at DESC);
    CREATE TABLE IF NOT EXISTS idea (
      id TEXT PRIMARY KEY,
      study_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT NOT NULL,
      why TEXT NOT NULL,
      ev REAL NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      config TEXT NOT NULL,
      run_id TEXT,
      analysis TEXT,
      conclusion TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      ended_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idea_study ON idea(study_id, status, priority DESC, ev DESC);
    CREATE TABLE IF NOT EXISTS run (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      study_id TEXT,
      idea_id TEXT,
      job_id TEXT,
      session_id TEXT,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      source TEXT NOT NULL,
      config TEXT NOT NULL,
      summary TEXT NOT NULL,
      headline REAL,
      baseline_delta REAL,
      points INTEGER NOT NULL DEFAULT 0,
      last_step REAL,
      slot INTEGER,
      kill_reason TEXT,
      created_at INTEGER NOT NULL,
      started_at INTEGER,
      ended_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS run_project ON run(project_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS run_job ON run(job_id);
    CREATE TABLE IF NOT EXISTS point (
      run_id TEXT NOT NULL,
      key TEXT NOT NULL,
      step REAL NOT NULL,
      value REAL NOT NULL,
      ts INTEGER NOT NULL,
      PRIMARY KEY (run_id, key, step)
    );
    CREATE TABLE IF NOT EXISTS event (
      id TEXT PRIMARY KEY,
      study_id TEXT NOT NULL,
      run_id TEXT,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS event_study ON event(study_id, created_at DESC);
  `

  const databases = new Map<string, Database>()

  export function directory() {
    return path.join(Global.Path.data, "experiments")
  }

  async function db(projectID: string): Promise<Database> {
    const existing = databases.get(projectID)
    if (existing) return existing
    await fs.mkdir(directory(), { recursive: true })
    const database = new Database(path.join(directory(), `${projectID}.sqlite`), { create: true })
    database.exec("PRAGMA busy_timeout = 5000")
    database.exec("PRAGMA journal_mode = WAL")
    database.exec("PRAGMA synchronous = NORMAL")
    database.exec(schema)
    const columns = database.query("PRAGMA table_info(study)").all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === "directives")) {
      database.exec("ALTER TABLE study ADD COLUMN directives TEXT NOT NULL DEFAULT '[]'")
    }
    databases.set(projectID, database)
    return database
  }

  /** Tests and disposal close every open handle. */
  export function close() {
    for (const database of databases.values()) database.close()
    databases.clear()
  }

  function projectID(input?: { projectID?: string }) {
    return input?.projectID ?? Instance.project.id
  }

  function json(value: unknown) {
    return JSON.stringify(value ?? {})
  }

  function parse<T>(value: unknown, fallback: T): T {
    if (typeof value !== "string") return fallback
    try {
      return JSON.parse(value) as T
    } catch {
      return fallback
    }
  }

  type RunRow = {
    id: string
    project_id: string
    study_id: string | null
    idea_id: string | null
    job_id: string | null
    session_id: string | null
    name: string
    status: string
    source: string
    config: string
    summary: string
    headline: number | null
    baseline_delta: number | null
    points: number
    last_step: number | null
    slot: number | null
    kill_reason: string | null
    created_at: number
    started_at: number | null
    ended_at: number | null
  }

  function run(row: RunRow): Run {
    return {
      id: row.id,
      projectID: row.project_id,
      studyID: row.study_id ?? undefined,
      ideaID: row.idea_id ?? undefined,
      jobID: row.job_id ?? undefined,
      sessionID: row.session_id ?? undefined,
      name: row.name,
      status: RunStatus.parse(row.status),
      source: row.source as Run["source"],
      config: parse(row.config, {}),
      summary: parse(row.summary, {}),
      headline: row.headline,
      baselineDelta: row.baseline_delta,
      points: row.points,
      lastStep: row.last_step,
      slot: row.slot,
      killReason: row.kill_reason ?? undefined,
      createdAt: row.created_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    }
  }

  type StudyRow = {
    id: string
    project_id: string
    session_id: string
    name: string
    purpose: string
    metric: string
    direction: string
    status: string
    root: string
    target: string
    concurrency: number
    kill_criteria: string
    budget: string
    review: number
    baseline_run_id: string | null
    best_run_id: string | null
    turns: number
    cost_usd: number
    lessons: string
    directives: string
    conclusion: string | null
    created_at: number
    updated_at: number
  }

  function study(row: StudyRow): Study {
    return {
      id: row.id,
      projectID: row.project_id,
      sessionID: row.session_id,
      name: row.name,
      purpose: row.purpose,
      metric: row.metric,
      direction: Direction.parse(row.direction),
      status: StudyStatus.parse(row.status),
      root: row.root,
      target: Target.parse(parse(row.target, { kind: "local" })),
      concurrency: row.concurrency,
      killCriteria: row.kill_criteria,
      budget: Budget.parse(parse(row.budget, {})),
      review: row.review === 1,
      baselineRunID: row.baseline_run_id ?? undefined,
      bestRunID: row.best_run_id ?? undefined,
      turns: row.turns,
      costUSD: row.cost_usd,
      lessons: row.lessons,
      directives: Directive.array().catch([]).parse(parse(row.directives, [])),
      conclusion: row.conclusion ?? undefined,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  type IdeaRow = {
    id: string
    study_id: string
    title: string
    description: string
    why: string
    ev: number
    priority: number
    status: string
    source: string
    config: string
    run_id: string | null
    analysis: string | null
    conclusion: string | null
    created_at: number
    started_at: number | null
    ended_at: number | null
  }

  function idea(row: IdeaRow): Idea {
    return {
      id: row.id,
      studyID: row.study_id,
      title: row.title,
      description: row.description,
      why: row.why,
      ev: row.ev,
      priority: row.priority,
      status: IdeaStatus.parse(row.status),
      source: row.source as Idea["source"],
      config: parse(row.config, {}),
      runID: row.run_id ?? undefined,
      analysis: row.analysis ?? undefined,
      conclusion: row.conclusion ?? undefined,
      createdAt: row.created_at,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    }
  }

  type EventRow = {
    id: string
    study_id: string
    run_id: string | null
    kind: string
    message: string
    created_at: number
  }

  function event(row: EventRow): StudyEvent {
    return {
      id: row.id,
      studyID: row.study_id,
      runID: row.run_id ?? undefined,
      kind: row.kind,
      message: row.message,
      createdAt: row.created_at,
    }
  }

  async function publish<Definition extends BusEvent.Definition>(
    definition: Definition,
    properties: z.infer<Definition["properties"]>,
  ) {
    await Bus.publish(definition, properties).catch((error) => log.warn("publish failed", { error }))
  }

  // ── Runs ─────────────────────────────────────────────────────────────────

  export async function createRun(input: {
    projectID?: string
    name: string
    source: Run["source"]
    config?: Record<string, unknown>
    jobID?: string
    studyID?: string
    ideaID?: string
    sessionID?: string
    slot?: number
    id?: string
  }): Promise<Run> {
    const project = projectID(input)
    const database = await db(project)
    const now = Date.now()
    const id = input.id ?? Identifier.ascending("experiment")
    database
      .query(
        `INSERT INTO run (id, project_id, study_id, idea_id, job_id, session_id, name, status, source, config, summary, points, slot, created_at, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, '{}', 0, ?, ?, ?)`,
      )
      .run(
        id,
        project,
        input.studyID ?? null,
        input.ideaID ?? null,
        input.jobID ?? null,
        input.sessionID ?? null,
        input.name,
        input.source,
        json(input.config),
        input.slot ?? null,
        now,
        now,
      )
    if (input.ideaID) {
      database
        .query(`UPDATE idea SET status = 'running', run_id = ?, started_at = ? WHERE id = ? AND study_id = ?`)
        .run(id, now, input.ideaID, input.studyID ?? "")
    }
    const created = await getRun(id, { projectID: project })
    if (!created) throw new Error("Run was not persisted")
    await publish(Event.RunUpdated, { run: created })
    return created
  }

  export async function getRun(id: string, input?: { projectID?: string }): Promise<Run | undefined> {
    const database = await db(projectID(input))
    const row = database.query(`SELECT * FROM run WHERE id = ?`).get(id) as RunRow | null
    return row ? run(row) : undefined
  }

  export async function runForJob(jobID: string, input?: { projectID?: string }): Promise<Run | undefined> {
    const database = await db(projectID(input))
    const row = database
      .query(`SELECT * FROM run WHERE job_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(jobID) as RunRow | null
    return row ? run(row) : undefined
  }

  export async function listRuns(input?: {
    projectID?: string
    studyID?: string
    status?: RunStatus
    limit?: number
  }): Promise<Run[]> {
    const database = await db(projectID(input))
    const clauses = ["project_id = ?"]
    const params: (string | number)[] = [projectID(input)]
    if (input?.studyID) {
      clauses.push("study_id = ?")
      params.push(input.studyID)
    }
    if (input?.status) {
      clauses.push("status = ?")
      params.push(input.status)
    }
    params.push(Math.min(Math.max(input?.limit ?? 200, 1), 2000))
    const rows = database
      .query(`SELECT * FROM run WHERE ${clauses.join(" AND ")} ORDER BY created_at DESC LIMIT ?`)
      .all(...params) as RunRow[]
    return rows.map(run)
  }

  /** Metric points arrive in batches from the SDK. The primary key makes a
   * replayed batch idempotent, and the run's headline follows the study's
   * metric when it has one. */
  export async function ingest(
    runID: string,
    points: Point[],
    input?: { projectID?: string },
  ): Promise<{ accepted: number; run: Run } | undefined> {
    const project = projectID(input)
    const database = await db(project)
    const existing = database.query(`SELECT * FROM run WHERE id = ?`).get(runID) as RunRow | null
    if (!existing) return
    const valid = points.filter((point) => Number.isFinite(point.value) && Number.isFinite(point.step))
    const now = Date.now()
    const insert = database.query(`INSERT OR REPLACE INTO point (run_id, key, step, value, ts) VALUES (?, ?, ?, ?, ?)`)
    const write = database.transaction((batch: Point[]) => {
      for (const point of batch) insert.run(runID, point.key, point.step, point.value, point.ts ?? now)
    })
    write(valid)
    const lastStep = valid.reduce((max, point) => Math.max(max, point.step), existing.last_step ?? -Infinity)
    const total = database.query(`SELECT COUNT(*) AS n FROM point WHERE run_id = ?`).get(runID) as { n: number }
    database
      .query(`UPDATE run SET points = ?, last_step = ? WHERE id = ?`)
      .run(total.n, Number.isFinite(lastStep) ? lastStep : null, runID)
    await refreshHeadline(runID, project)
    const updated = (await getRun(runID, { projectID: project }))!
    await publish(Event.RunPoints, {
      runID,
      keys: [...new Set(valid.map((point) => point.key))],
      lastStep: updated.lastStep,
    })
    return { accepted: valid.length, run: updated }
  }

  /** A run learns its compute job once dispatch succeeds. */
  export async function bindJob(runID: string, jobID: string, input?: { projectID?: string }) {
    const project = projectID(input)
    const database = await db(project)
    database.query(`UPDATE run SET job_id = ? WHERE id = ?`).run(jobID, runID)
    const updated = await getRun(runID, { projectID: project })
    if (updated) await publish(Event.RunUpdated, { run: updated })
    return updated
  }

  /** The script's own config, reported at init, refines what the study
   * planned for the run. */
  export async function mergeConfig(
    runID: string,
    config: Record<string, unknown>,
    input?: { projectID?: string },
  ): Promise<Run | undefined> {
    const project = projectID(input)
    const database = await db(project)
    const existing = database.query(`SELECT config FROM run WHERE id = ?`).get(runID) as { config: string } | null
    if (!existing) return
    const merged = { ...parse<Record<string, unknown>>(existing.config, {}), ...config }
    database.query(`UPDATE run SET config = ? WHERE id = ?`).run(json(merged), runID)
    const updated = (await getRun(runID, { projectID: project }))!
    await publish(Event.RunUpdated, { run: updated })
    return updated
  }

  export async function summarize(
    runID: string,
    summary: Record<string, unknown>,
    input?: { projectID?: string },
  ): Promise<Run | undefined> {
    const project = projectID(input)
    const database = await db(project)
    const existing = database.query(`SELECT summary FROM run WHERE id = ?`).get(runID) as { summary: string } | null
    if (!existing) return
    const merged = { ...parse<Record<string, unknown>>(existing.summary, {}), ...summary }
    database.query(`UPDATE run SET summary = ? WHERE id = ?`).run(json(merged), runID)
    await refreshHeadline(runID, project)
    const updated = (await getRun(runID, { projectID: project }))!
    await publish(Event.RunUpdated, { run: updated })
    return updated
  }

  export async function finishRun(
    runID: string,
    status: Exclude<RunStatus, "running">,
    input?: { projectID?: string; killReason?: string },
  ): Promise<Run | undefined> {
    const project = projectID(input)
    const database = await db(project)
    const existing = database.query(`SELECT * FROM run WHERE id = ?`).get(runID) as RunRow | null
    if (!existing) return
    if (existing.status !== "running") return run(existing)
    database
      .query(`UPDATE run SET status = ?, ended_at = ?, kill_reason = COALESCE(?, kill_reason) WHERE id = ?`)
      .run(status, Date.now(), input?.killReason ?? null, runID)
    await refreshHeadline(runID, project)
    const updated = (await getRun(runID, { projectID: project }))!
    if (updated.studyID) await refreshStudy(updated.studyID, project)
    await publish(Event.RunUpdated, { run: updated })
    return updated
  }

  /** The headline is the study metric's summary value when the script set
   * one, otherwise its last logged value. Delta is measured against the
   * study's baseline run; sign follows the metric's direction so positive
   * always means better. */
  async function refreshHeadline(runID: string, project: string) {
    const database = await db(project)
    const row = database.query(`SELECT * FROM run WHERE id = ?`).get(runID) as RunRow | null
    if (!row) return
    const studyRow = row.study_id
      ? (database.query(`SELECT * FROM study WHERE id = ?`).get(row.study_id) as StudyRow | null)
      : null
    const metric = studyRow?.metric ?? (row.summary && Object.keys(parse<Record<string, unknown>>(row.summary, {}))[0])
    if (!metric) return
    const summary = parse<Record<string, unknown>>(row.summary, {})
    const fromSummary = typeof summary[metric] === "number" ? (summary[metric] as number) : undefined
    const last = database
      .query(`SELECT value FROM point WHERE run_id = ? AND key = ? ORDER BY step DESC LIMIT 1`)
      .get(runID, metric) as { value: number } | null
    const headline = fromSummary ?? last?.value ?? null
    const baseline =
      studyRow?.baseline_run_id && studyRow.baseline_run_id !== runID
        ? (database.query(`SELECT headline FROM run WHERE id = ?`).get(studyRow.baseline_run_id) as {
            headline: number | null
          } | null)
        : null
    const delta =
      headline !== null && baseline?.headline !== null && baseline?.headline !== undefined
        ? studyRow?.direction === "maximize"
          ? headline - baseline.headline
          : baseline.headline - headline
        : null
    database.query(`UPDATE run SET headline = ?, baseline_delta = ? WHERE id = ?`).run(headline, delta, runID)
  }

  export type Series = { runID: string; key: string; points: Array<{ step: number; value: number }> }

  /** Downsampled series for charts: at most `max` points per run and key,
   * averaged within equal-width step buckets so long runs stay light. */
  export async function series(input: {
    projectID?: string
    runIDs: string[]
    keys?: string[]
    max?: number
  }): Promise<Series[]> {
    const database = await db(projectID(input))
    const max = Math.min(Math.max(input.max ?? 400, 10), 5000)
    const result: Series[] = []
    for (const runID of input.runIDs.slice(0, 50)) {
      const keys =
        input.keys ??
        (
          database.query(`SELECT DISTINCT key FROM point WHERE run_id = ? ORDER BY key`).all(runID) as Array<{
            key: string
          }>
        ).map((row) => row.key)
      for (const key of keys) {
        const rows = database
          .query(`SELECT step, value FROM point WHERE run_id = ? AND key = ? ORDER BY step`)
          .all(runID, key) as Array<{ step: number; value: number }>
        if (!rows.length) continue
        if (rows.length <= max) {
          result.push({ runID, key, points: rows })
          continue
        }
        const bucket = rows.length / max
        const points: Array<{ step: number; value: number }> = []
        for (let index = 0; index < max; index++) {
          const slice = rows.slice(Math.floor(index * bucket), Math.floor((index + 1) * bucket))
          if (!slice.length) continue
          const sum = slice.reduce((total, row) => total + row.value, 0)
          points.push({ step: slice[slice.length - 1]!.step, value: sum / slice.length })
        }
        result.push({ runID, key, points })
      }
    }
    return result
  }

  export async function metricKeys(input: { projectID?: string; runIDs?: string[]; studyID?: string }) {
    const database = await db(projectID(input))
    if (input.runIDs?.length) {
      const placeholders = input.runIDs
        .slice(0, 200)
        .map(() => "?")
        .join(", ")
      const rows = database
        .query(`SELECT DISTINCT key FROM point WHERE run_id IN (${placeholders}) ORDER BY key`)
        .all(...input.runIDs.slice(0, 200)) as Array<{ key: string }>
      return rows.map((row) => row.key)
    }
    const rows = database
      .query(
        `SELECT DISTINCT point.key AS key FROM point JOIN run ON run.id = point.run_id WHERE run.project_id = ?${
          input.studyID ? " AND run.study_id = ?" : ""
        } ORDER BY key`,
      )
      .all(...(input.studyID ? [projectID(input), input.studyID] : [projectID(input)])) as Array<{ key: string }>
    return rows.map((row) => row.key)
  }

  /** Recent values for a live run, for kill criteria. */
  export async function recent(runID: string, key: string, limit: number, input?: { projectID?: string }) {
    const database = await db(projectID(input))
    const rows = database
      .query(`SELECT step, value FROM point WHERE run_id = ? AND key = ? ORDER BY step DESC LIMIT ?`)
      .all(runID, key, limit) as Array<{ step: number; value: number }>
    return rows.reverse()
  }

  // ── Studies ──────────────────────────────────────────────────────────────

  export async function createStudy(input: {
    projectID?: string
    sessionID: string
    name: string
    purpose: string
    metric: string
    direction: Direction
    root: string
    target?: Target
    concurrency?: number
    killCriteria?: string
    budget?: Budget
    review?: boolean
  }): Promise<Study> {
    const project = projectID(input)
    const database = await db(project)
    const now = Date.now()
    const id = Identifier.ascending("study")
    database
      .query(
        `INSERT INTO study (id, project_id, session_id, name, purpose, metric, direction, status, root, target, concurrency, kill_criteria, budget, review, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        project,
        input.sessionID,
        input.name,
        input.purpose,
        input.metric,
        input.direction,
        input.root,
        json(input.target ?? { kind: "local" }),
        input.concurrency ?? 1,
        input.killCriteria ?? "",
        json(input.budget ?? {}),
        input.review === false ? 0 : 1,
        now,
        now,
      )
    const created = (await getStudy(id, { projectID: project }))!
    await addEvent(id, "created", `Study created: ${input.name}`, { projectID: project })
    await publish(Event.StudyUpdated, { study: created })
    return created
  }

  export async function getStudy(id: string, input?: { projectID?: string }): Promise<Study | undefined> {
    const database = await db(projectID(input))
    const row = database.query(`SELECT * FROM study WHERE id = ?`).get(id) as StudyRow | null
    return row ? study(row) : undefined
  }

  export async function listStudies(input?: { projectID?: string; status?: StudyStatus[] }): Promise<Study[]> {
    const database = await db(projectID(input))
    const rows = database
      .query(`SELECT * FROM study WHERE project_id = ? ORDER BY created_at DESC LIMIT 200`)
      .all(projectID(input)) as StudyRow[]
    const all = rows.map(study)
    return input?.status ? all.filter((item) => input.status!.includes(item.status)) : all
  }

  /** The study a session is driving, if any: one live study per session. */
  export async function studyForSession(sessionID: string, input?: { projectID?: string }) {
    const database = await db(projectID(input))
    const row = database
      .query(
        `SELECT * FROM study WHERE session_id = ? AND status IN ('running', 'paused') ORDER BY created_at DESC LIMIT 1`,
      )
      .get(sessionID) as StudyRow | null
    return row ? study(row) : undefined
  }

  export async function updateStudy(
    id: string,
    patch: Partial<
      Pick<
        Study,
        | "status"
        | "baselineRunID"
        | "bestRunID"
        | "lessons"
        | "conclusion"
        | "concurrency"
        | "killCriteria"
        | "budget"
        | "review"
        | "purpose"
        | "name"
      >
    > & { turns?: number; costUSD?: number },
    input?: { projectID?: string },
  ): Promise<Study | undefined> {
    const project = projectID(input)
    const database = await db(project)
    const existing = await getStudy(id, { projectID: project })
    if (!existing) return
    const next = { ...existing, ...patch, updatedAt: Date.now() }
    database
      .query(
        `UPDATE study SET status = ?, baseline_run_id = ?, best_run_id = ?, lessons = ?, conclusion = ?, concurrency = ?, kill_criteria = ?, budget = ?, review = ?, purpose = ?, name = ?, turns = ?, cost_usd = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.status,
        next.baselineRunID ?? null,
        next.bestRunID ?? null,
        next.lessons,
        next.conclusion ?? null,
        next.concurrency,
        next.killCriteria,
        json(next.budget),
        next.review ? 1 : 0,
        next.purpose,
        next.name,
        next.turns,
        next.costUSD,
        next.updatedAt,
        id,
      )
    const updated = (await getStudy(id, { projectID: project }))!
    await publish(Event.StudyUpdated, { study: updated })
    return updated
  }

  /** Recompute the best run and re-derive every run's delta after a baseline
   * or a result changes. */
  async function refreshStudy(studyID: string, project: string) {
    const database = await db(project)
    const row = database.query(`SELECT * FROM study WHERE id = ?`).get(studyID) as StudyRow | null
    if (!row) return
    const runs = database.query(`SELECT id FROM run WHERE study_id = ? AND status <> 'running'`).all(studyID) as Array<{
      id: string
    }>
    for (const item of runs) await refreshHeadline(item.id, project)
    const best = database
      .query(
        `SELECT id FROM run WHERE study_id = ? AND status = 'finished' AND headline IS NOT NULL ORDER BY headline ${
          row.direction === "maximize" ? "DESC" : "ASC"
        } LIMIT 1`,
      )
      .get(studyID) as { id: string } | null
    database
      .query(`UPDATE study SET best_run_id = ?, updated_at = ? WHERE id = ?`)
      .run(best?.id ?? null, Date.now(), studyID)
    const updated = (await getStudy(studyID, { projectID: project }))!
    await publish(Event.StudyUpdated, { study: updated })
  }

  export async function setBaseline(studyID: string, runID: string, input?: { projectID?: string }) {
    const project = projectID(input)
    const database = await db(project)
    database.query(`UPDATE study SET baseline_run_id = ?, updated_at = ? WHERE id = ?`).run(runID, Date.now(), studyID)
    await refreshStudy(studyID, project)
    return getStudy(studyID, { projectID: project })
  }

  // ── Ideas ────────────────────────────────────────────────────────────────

  export async function proposeIdeas(
    studyID: string,
    ideas: Array<{
      title: string
      description: string
      why: string
      ev: number
      config?: Record<string, unknown>
      source?: Idea["source"]
      priority?: number
    }>,
    input?: { projectID?: string },
  ): Promise<Idea[]> {
    const project = projectID(input)
    const database = await db(project)
    const now = Date.now()
    const created: Idea[] = []
    const insert = database.query(
      `INSERT INTO idea (id, study_id, title, description, why, ev, priority, status, source, config, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
    )
    for (const item of ideas) {
      const id = Identifier.ascending("idea")
      insert.run(
        id,
        studyID,
        item.title,
        item.description,
        item.why,
        item.ev,
        item.priority ?? 0,
        item.source ?? "agent",
        json(item.config),
        now,
      )
      const row = database.query(`SELECT * FROM idea WHERE id = ?`).get(id) as IdeaRow
      created.push(idea(row))
    }
    for (const item of created) await publish(Event.IdeaUpdated, { idea: item })
    if (created.length) {
      await addEvent(studyID, "ideas", `${created.length} idea${created.length === 1 ? "" : "s"} queued`, {
        projectID: project,
      })
    }
    return created
  }

  export async function listIdeas(studyID: string, input?: { projectID?: string; status?: IdeaStatus[] }) {
    const database = await db(projectID(input))
    const rows = database
      .query(`SELECT * FROM idea WHERE study_id = ? ORDER BY priority DESC, ev DESC, created_at ASC`)
      .all(studyID) as IdeaRow[]
    const all = rows.map(idea)
    return input?.status ? all.filter((item) => input.status!.includes(item.status)) : all
  }

  export async function getIdea(id: string, input?: { projectID?: string }) {
    const database = await db(projectID(input))
    const row = database.query(`SELECT * FROM idea WHERE id = ?`).get(id) as IdeaRow | null
    return row ? idea(row) : undefined
  }

  /** The next idea to run: highest manual priority, then highest EV. */
  export async function nextIdea(studyID: string, input?: { projectID?: string }) {
    const queued = await listIdeas(studyID, { ...input, status: ["queued"] })
    return queued[0]
  }

  export async function updateIdea(
    id: string,
    patch: Partial<
      Pick<
        Idea,
        "status" | "ev" | "priority" | "analysis" | "conclusion" | "config" | "description" | "why" | "title" | "runID"
      >
    >,
    input?: { projectID?: string },
  ): Promise<Idea | undefined> {
    const project = projectID(input)
    const database = await db(project)
    const existing = await getIdea(id, { projectID: project })
    if (!existing) return
    const next = { ...existing, ...patch }
    const ended = next.status !== "queued" && next.status !== "running" ? (existing.endedAt ?? Date.now()) : null
    database
      .query(
        `UPDATE idea SET title = ?, description = ?, why = ?, ev = ?, priority = ?, status = ?, config = ?, run_id = ?, analysis = ?, conclusion = ?, ended_at = ? WHERE id = ?`,
      )
      .run(
        next.title,
        next.description,
        next.why,
        next.ev,
        next.priority,
        next.status,
        json(next.config),
        next.runID ?? null,
        next.analysis ?? null,
        next.conclusion ?? null,
        ended,
        id,
      )
    const updated = (await getIdea(id, { projectID: project }))!
    await publish(Event.IdeaUpdated, { idea: updated })
    return updated
  }

  /** Close the loop on a run: the agent's verdict, its analysis, and any
   * lessons for the study. Kept runs move the best marker. */
  export async function recordResult(input: {
    projectID?: string
    studyID: string
    runID: string
    kept: boolean
    analysis: string
    conclusion?: string
    lessons?: string
  }) {
    const project = projectID(input)
    const database = await db(project)
    const current = await getRun(input.runID, { projectID: project })
    const target = await getStudy(input.studyID, { projectID: project })
    if (!current || !target) return
    if (current.ideaID) {
      await updateIdea(
        current.ideaID,
        {
          status: input.kept ? "kept" : current.status === "finished" ? "reverted" : "failed",
          analysis: input.analysis,
          conclusion: input.conclusion,
        },
        { projectID: project },
      )
    }
    if (input.lessons?.trim()) {
      const stamp = new Date().toISOString().slice(0, 16).replace("T", " ")
      const lessons = `${target.lessons}${target.lessons ? "\n\n" : ""}- ${stamp} (${current.name}): ${input.lessons.trim()}`
      database.query(`UPDATE study SET lessons = ?, updated_at = ? WHERE id = ?`).run(lessons, Date.now(), target.id)
    }
    await addEvent(
      target.id,
      input.kept ? "kept" : "reverted",
      `${current.name}: ${input.kept ? "kept" : "reverted"}${current.headline !== null ? ` (${target.metric} ${format(current.headline)})` : ""}`,
      { projectID: project, runID: current.id },
    )
    await refreshStudy(target.id, project)
    return getStudy(target.id, { projectID: project })
  }

  /** Add a standing directive; the driver wakes the session with it. */
  export async function addDirective(studyID: string, text: string, input?: { projectID?: string }) {
    const project = projectID(input)
    const database = await db(project)
    const current = await getStudy(studyID, { projectID: project })
    if (!current) return
    const directive: Directive = {
      id: `dir_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
      text: text.trim(),
      createdAt: Date.now(),
      active: true,
    }
    const next = [...current.directives, directive]
    database.query(`UPDATE study SET directives = ?, updated_at = ? WHERE id = ?`).run(json(next), Date.now(), studyID)
    await addEvent(studyID, "directive", `Directive: ${directive.text}`, { projectID: project })
    const updated = (await getStudy(studyID, { projectID: project }))!
    await publish(Event.StudyUpdated, { study: updated })
    return { study: updated, directive }
  }

  export async function retireDirective(studyID: string, directiveID: string, input?: { projectID?: string }) {
    const project = projectID(input)
    const database = await db(project)
    const current = await getStudy(studyID, { projectID: project })
    if (!current) return
    const next = current.directives.map((item) => (item.id === directiveID ? { ...item, active: false } : item))
    database.query(`UPDATE study SET directives = ?, updated_at = ? WHERE id = ?`).run(json(next), Date.now(), studyID)
    const updated = (await getStudy(studyID, { projectID: project }))!
    await publish(Event.StudyUpdated, { study: updated })
    return updated
  }

  export function format(value: number) {
    if (!Number.isFinite(value)) return String(value)
    const abs = Math.abs(value)
    if (abs !== 0 && (abs < 0.001 || abs >= 1e6)) return value.toExponential(3)
    return Number(value.toPrecision(5)).toString()
  }

  // ── Events ───────────────────────────────────────────────────────────────

  export async function addEvent(
    studyID: string,
    kind: string,
    message: string,
    input?: { projectID?: string; runID?: string },
  ) {
    const project = projectID(input)
    const database = await db(project)
    const id = `evt_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
    const now = Date.now()
    database
      .query(`INSERT INTO event (id, study_id, run_id, kind, message, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, studyID, input?.runID ?? null, kind, message, now)
    const created: StudyEvent = { id, studyID, runID: input?.runID, kind, message, createdAt: now }
    await publish(Event.StudyEvent, { event: created })
    return created
  }

  export async function listEvents(studyID: string, input?: { projectID?: string; limit?: number }) {
    const database = await db(projectID(input))
    const rows = database
      .query(`SELECT * FROM event WHERE study_id = ? ORDER BY created_at DESC LIMIT ?`)
      .all(studyID, Math.min(input?.limit ?? 100, 1000)) as EventRow[]
    return rows.map(event)
  }

  /** Everything the pane and the agent need about one study in one read. */
  export async function overview(studyID: string, input?: { projectID?: string }) {
    const target = await getStudy(studyID, input)
    if (!target) return
    const [ideas, runs, events] = await Promise.all([
      listIdeas(studyID, input),
      listRuns({ ...input, studyID, limit: 500 }),
      listEvents(studyID, { ...input, limit: 50 }),
    ])
    const baseline = target.baselineRunID ? runs.find((item) => item.id === target.baselineRunID) : undefined
    const best = target.bestRunID ? runs.find((item) => item.id === target.bestRunID) : undefined
    return { study: target, ideas, runs, events, baseline, best }
  }
}

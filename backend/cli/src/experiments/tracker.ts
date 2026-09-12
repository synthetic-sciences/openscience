import fs from "node:fs/promises"
import z from "zod"
import { Experiments } from "."
import { TrackingSDK } from "./sdk"

/**
 * Reads the SDK's marked records back out of a job log. A follower keeps its
 * byte offset and any partial trailing line, so it can poll a growing log
 * cheaply and never double-counts a record.
 */
export namespace Tracker {
  export const TrackRecord = z.discriminatedUnion("t", [
    z.object({
      t: z.literal("init"),
      name: z.string().optional(),
      project: z.string().optional(),
      config: z.record(z.string(), z.unknown()).optional(),
      ts: z.number().optional(),
    }),
    z.object({
      t: z.literal("log"),
      step: z.number(),
      m: z.record(z.string(), z.number()),
      ts: z.number().optional(),
    }),
    z.object({ t: z.literal("summary"), s: z.record(z.string(), z.unknown()), ts: z.number().optional() }),
    z.object({ t: z.literal("finish"), status: z.string().optional(), ts: z.number().optional() }),
    z.object({ t: z.literal("artifact"), name: z.string(), path: z.string().optional(), ts: z.number().optional() }),
  ])
  export type TrackRecord = z.infer<typeof TrackRecord>

  export function parseLine(line: string): TrackRecord | undefined {
    const start = line.indexOf(TrackingSDK.MARKER)
    if (start < 0) return
    const payload = line.slice(start + TrackingSDK.MARKER.length).trim()
    try {
      const parsed = TrackRecord.safeParse(JSON.parse(payload))
      return parsed.success ? parsed.data : undefined
    } catch {
      return
    }
  }

  export function parse(text: string): TrackRecord[] {
    const records: TrackRecord[] = []
    for (const line of text.split("\n")) {
      const record = parseLine(line)
      if (record) records.push(record)
    }
    return records
  }

  /** Lines carrying tracking records are data, not output: strip them from
   * text shown to people or fed back to the model. */
  export function strip(text: string): string {
    if (!text.includes(TrackingSDK.MARKER)) return text
    return text
      .split("\n")
      .filter((line) => !line.includes(TrackingSDK.MARKER))
      .join("\n")
  }

  export async function apply(runID: string, records: TrackRecord[], input?: { projectID?: string }) {
    const points: Experiments.Point[] = []
    let summary: Record<string, unknown> | undefined
    let init: Extract<TrackRecord, { t: "init" }> | undefined
    let finished: string | undefined
    for (const record of records) {
      if (record.t === "log") {
        for (const [key, value] of Object.entries(record.m)) {
          points.push({ key, step: record.step, value, ts: record.ts })
        }
        continue
      }
      if (record.t === "summary") summary = { ...(summary ?? {}), ...record.s }
      if (record.t === "init") init = record
      if (record.t === "finish") finished = record.status ?? "finished"
    }
    if (init?.config && Object.keys(init.config).length) {
      const current = await Experiments.getRun(runID, input)
      if (current) await Experiments.mergeConfig(runID, init.config, input)
    }
    if (points.length) await Experiments.ingest(runID, points, input)
    if (summary) await Experiments.summarize(runID, summary, input)
    return { points: points.length, summary: summary !== undefined, finished }
  }

  export class Follower {
    private offset = 0
    private partial = ""

    constructor(
      readonly runID: string,
      readonly file: string,
      readonly projectID?: string,
    ) {}

    /** Read what the log gained since the last poll and apply its records. */
    async poll(): Promise<{ records: number; finished?: string }> {
      const handle = await fs.open(this.file, "r").catch(() => undefined)
      if (!handle) return { records: 0 }
      try {
        const stat = await handle.stat()
        if (stat.size < this.offset) {
          this.offset = 0
          this.partial = ""
        }
        if (stat.size === this.offset) return { records: 0 }
        const length = stat.size - this.offset
        const buffer = Buffer.alloc(length)
        await handle.read(buffer, 0, length, this.offset)
        this.offset = stat.size
        const text = this.partial + buffer.toString("utf8")
        const cut = text.lastIndexOf("\n")
        const complete = cut < 0 ? "" : text.slice(0, cut + 1)
        this.partial = cut < 0 ? text : text.slice(cut + 1)
        const records = parse(complete)
        if (!records.length) return { records: 0 }
        const applied = await apply(this.runID, records, { projectID: this.projectID })
        return { records: records.length, finished: applied.finished }
      } finally {
        await handle.close()
      }
    }
  }
}

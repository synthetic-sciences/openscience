// Lenient JSONL reading for other tools' transcripts. Their formats are
// undocumented and a live session may be mid-write, so a line that does not
// parse is skipped rather than failing the import.
import fs from "node:fs/promises"

export type JsonRecord = Record<string, unknown>

export const SAMPLE_BYTES = 64 * 1024

/** Bytes read by `sample`; tests use it to prove listing stays cheap. */
export const readStats = { bytes: 0 }

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function str(value: unknown, key: string): string | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return typeof field === "string" ? field : undefined
}

export function num(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined
  const field = value[key]
  return typeof field === "number" && Number.isFinite(field) ? field : undefined
}

export function parseLines(text: string): Array<{ line: number; record: JsonRecord }> {
  const out: Array<{ line: number; record: JsonRecord }> = []
  const lines = text.split("\n")
  for (let index = 0; index < lines.length; index++) {
    const raw = lines[index].trim()
    if (!raw) continue
    try {
      const parsed = JSON.parse(raw)
      if (isRecord(parsed)) out.push({ line: index + 1, record: parsed })
    } catch {
      // A partial or corrupt line: skip it.
    }
  }
  return out
}

/** Records from the first and last `SAMPLE_BYTES` of a file, for listing. */
export async function sample(file: string): Promise<{ head: JsonRecord[]; tail: JsonRecord[]; whole: boolean }> {
  const handle = await fs.open(file, "r")
  try {
    const size = (await handle.stat()).size
    const read = async (start: number, length: number) => {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, start)
      readStats.bytes += bytesRead
      return buffer.subarray(0, bytesRead).toString("utf8")
    }
    if (size <= SAMPLE_BYTES * 2) {
      const all = parseLines(await read(0, size)).map((item) => item.record)
      return { head: all, tail: all, whole: true }
    }
    // The first line of the tail and the last line of the head are usually cut;
    // parseLines skips them.
    const head = parseLines(await read(0, SAMPLE_BYTES)).map((item) => item.record)
    const tail = parseLines(await read(size - SAMPLE_BYTES, SAMPLE_BYTES)).map((item) => item.record)
    return { head, tail, whole: false }
  } finally {
    await handle.close()
  }
}

export function time(value: unknown, fallback: number): number {
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  if (typeof value === "number" && Number.isFinite(value)) return value
  return fallback
}

/** A file written to this recently may still be mid-turn; its last turn waits for the next import. */
export const LIVE_MS = 5 * 60 * 1000
export function isLive(modified: number) {
  return Date.now() - modified < LIVE_MS
}

export const LISTED_TEXT = 200
export function clip(text: string | undefined) {
  if (!text) return text
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > LISTED_TEXT ? flat.slice(0, LISTED_TEXT - 1) + "…" : flat
}

/** Map with at most `limit` calls in flight; a failed item becomes undefined. */
export async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R | undefined>) {
  const out: Array<R | undefined> = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      out[index] = await fn(items[index]).catch(() => undefined)
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out.filter((item): item is R => item !== undefined)
}

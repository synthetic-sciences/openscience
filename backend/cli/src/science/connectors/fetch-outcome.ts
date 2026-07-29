/**
 * Classifies what a connector fetch produced: record, file, clean miss, or error.
 * Determines whether a record goes inline or spills to disk based on size.
 *
 * Lifted from a prototype validated against all 42 connectors' live APIs.
 * Sentinel handling is the load-bearing part: nine connectors signal 'not found'
 * with null, {}, or found:false rather than throwing, and conflating those with
 * failures renders an ordinary miss as an outage.
 */

import { Truncate } from "../../tool/truncation"

export type Disposition = "inline" | "spill"

export type FetchOutcome =
  | { kind: "record"; disposition: Disposition; bytes: number; body: string; filename: string; summary: string }
  | { kind: "file"; disposition: "spill"; bytes: number; body: string; filename: string; summary: string }
  | { kind: "miss"; note: string }
  | { kind: "error"; retryable: boolean; message: string }

/**
 * Sentinel detection. The survey found four "not found" conventions across the
 * 42 connectors, and one of them (`{id, error}`) is a genuine failure rather
 * than a miss — biogrid returns it when BIOGRID_ACCESS_KEY is unset.
 *
 * Returning null means "this is a real record, carry on".
 */
export function sentinelOf(payload: unknown): { kind: "miss" | "error"; note: string } | null {
  if (payload === null || payload === undefined) return { kind: "miss", note: "connector returned null" }
  if (typeof payload !== "object") return null
  if (Array.isArray(payload)) return payload.length ? null : { kind: "miss", note: "connector returned an empty array" }
  const rec = payload as Record<string, unknown>
  const err = rec["error"]
  if (typeof err === "string" && err.length) return { kind: "error", note: err }
  if (rec["found"] === false) return { kind: "miss", note: "connector reported found: false" }
  if (Object.keys(rec).length === 0) return { kind: "miss", note: "connector returned an empty object" }
  return null
}

/** Mirrors the degradation logic science_search already uses, so both tools agree. */
export function classifyError(err: unknown): { retryable: boolean; message: string } {
  const message = err instanceof Error ? err.message : String(err)
  const retryable = /\b(429|503|408)\b/.test(message) || /rate.?limit/i.test(message)
  return { retryable, message }
}

/**
 * Filename for a spilled payload: .openscience/fetch/<db>/<id>.<ext>
 *
 * ids are NOT safe path segments — crossref takes `10.1038/nature12373` (slash),
 * kegg takes `hsa:7157` (colon), myvariant takes `chr7:g.140453134A>T` (colon,
 * angle bracket). Colons and backslashes are illegal on Windows, which this
 * project ships binaries for, so they are sanitised too.
 */
export function safeSegment(raw: string): string {
  const cleaned = raw
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^[._]+|[._]+$/g, "")
    .slice(0, 120)
  return cleaned || "record"
}

const EXT_FOR: Record<string, string> = {
  json: "json",
  pdb: "pdb",
  cif: "cif",
  mmcif: "cif",
  fasta: "fasta",
  sdf: "sdf",
  xml: "xml",
  tsv: "tsv",
  txt: "txt",
}

export function filenameFor(db: string, id: string, format?: string): string {
  const ext = EXT_FOR[(format ?? "json").toLowerCase()] ?? safeSegment(format ?? "json")
  return `.openscience/fetch/${safeSegment(db)}/${safeSegment(id)}.${ext}`
}

/** One-line-per-key gist of what got spilled, so the model knows whether to Read it. */
export function summarize(payload: unknown, format?: string): string {
  if (format && typeof payload === "string") {
    const head = payload.slice(0, 160).replace(/\s+/g, " ").trim()
    return head + (payload.length > 160 ? " …" : "")
  }
  if (payload === null || payload === undefined) return "(empty)"
  if (Array.isArray(payload)) return `array of ${payload.length}`
  if (typeof payload !== "object") return String(payload).slice(0, 160)
  const keys = Object.keys(payload as Record<string, unknown>)
  const shown = keys.slice(0, 6).join(", ")
  return keys.length > 6 ? `${shown} (+${keys.length - 6} more)` : shown || "(no keys)"
}

export function serialize(payload: unknown): string {
  if (typeof payload === "string") return payload
  try {
    return JSON.stringify(payload, null, 2) ?? String(payload)
  } catch {
    return String(payload)
  }
}

/**
 * THE decision under test.
 *
 * A file (format requested) always spills — its size is not the deciding factor,
 * its kind is. A record spills only when it exceeds the cap. That is the claim
 * this prototype exists to falsify.
 */
export function outcomeFor(input: {
  db: string
  id: string
  format?: string
  payload: unknown
  capBytes?: number
}): FetchOutcome {
  const cap = input.capBytes ?? Truncate.MAX_BYTES
  const sentinel = sentinelOf(input.payload)
  if (sentinel?.kind === "miss") return { kind: "miss", note: sentinel.note }
  if (sentinel?.kind === "error") return { kind: "error", retryable: false, message: sentinel.note }

  const body = serialize(input.payload)
  const bytes = Buffer.byteLength(body, "utf8")
  const filename = filenameFor(input.db, input.id, input.format)
  const summary = summarize(input.payload, input.format)

  if (input.format) return { kind: "file", disposition: "spill", bytes, body, filename, summary }
  return {
    kind: "record",
    disposition: bytes > cap ? "spill" : "inline",
    bytes,
    body,
    filename,
    summary,
  }
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

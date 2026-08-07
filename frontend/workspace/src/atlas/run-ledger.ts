import type { Status } from "@/atlas/ComputeJobsAPI"

type Run = { status: Status; target_label: string }

/**
 * How a run's status reads in the ledger.
 *
 * 3a states the status on every row rather than only where something is wrong.
 * That is a deliberate reversal of the earlier pass: in a ledger the status is
 * a column, and a column with holes in it is harder to scan than one that is
 * always filled — the eye tracks down a fixed position instead of hunting for
 * which rows chose to speak.
 *
 * `tone` names the semantic, not the colour, so the component maps it to a
 * theme token. Running is warned rather than praised: it is the one state that
 * is still changing, and the only one the reader may want to act on.
 */
const tones = {
  succeeded: "success",
  failed: "danger",
  interrupted: "danger",
  cancelled: "muted",
  running: "active",
  queued: "muted",
} as const satisfies Record<Status, string>

export type RunTone = (typeof tones)[Status]

export type RunEntry = {
  /** Zero-padded position in the ledger, oldest number highest. */
  index: string
  /** The status as the ledger prints it. Kept separate from the run's own
   *  `status` so the entry is still a Job — the row expands into a detail
   *  panel that needs the real value, not a display string. */
  statusLabel: string
  tone: RunTone
  target: string
}

/**
 * Turns runs into ledger entries: a number, the target as the server names it,
 * the status in sentence case, and its tone.
 *
 * Numbering is by position in the list as given, so it matches what the reader
 * sees rather than any internal ordering — the API returns newest first, and
 * "01" is therefore the newest run.
 */
export function ledger<T extends Run>(runs: readonly T[]): (T & RunEntry)[] {
  return runs.map((run, position) => ({
    ...run,
    index: String(position + 1).padStart(2, "0"),
    statusLabel: run.status.charAt(0).toUpperCase() + run.status.slice(1),
    tone: tones[run.status] ?? "muted",
    target: run.target_label,
  }))
}

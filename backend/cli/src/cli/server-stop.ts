import { GracefulShutdown } from "../process/graceful-shutdown"
import { Log } from "../util/log"
import { UI } from "./ui"

/** How long a server has to be gone, measured from the signal that stopped it.
 *  The disposal's own 8s plus the usage drain's 2s, with room for the log
 *  flush on top, because this bounds the *whole* stop: `index.ts` still runs
 *  that drain, the data-root disposal and the flush after the command returns,
 *  and nothing else is watching them. */
export const STOP_DEADLINE_MS = 12_000

/** The deadline for a server the desktop app started. The shell SIGKILLs its
 *  sidecar 5s after SIGTERM (`drainService` in `frontend/desktop/src/main.mjs`)
 *  and a SIGKILL runs no `exit` hook at all, so the kernel children this
 *  process spawned would outlive it — the exact orphan the kernel hooks exist
 *  to prevent. Leaving first is what keeps that guarantee: the deadline below
 *  ends the process through `process.exit`, which runs those hooks. */
export const DESKTOP_STOP_DEADLINE_MS = 4_000

/** The exit code of a stop that had to be cut short at its deadline. Every
 *  other outcome of a stop that was asked for is `0`. */
export const STOP_TIMED_OUT = 1

const DISPOSE_TIMEOUT_MS = 8_000

type Stoppable = { stop: (closeActiveConnections: boolean) => Promise<unknown> }

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/** Every leaf reason behind a nested `AggregateError`. The disposer wraps the
 *  instance disposal, which wraps each project's state disposal, so the only
 *  layer that names the runtime which would not release is the innermost. */
function reasons(error: unknown, depth = 4): unknown[] {
  if (depth <= 0 || !(error instanceof AggregateError) || !error.errors.length) return [error]
  return error.errors.flatMap((cause) => reasons(cause, depth - 1))
}

/** The failure in a few lines. A server with twenty unreleasable runtimes must
 *  not bury why it could not stop under twenty stack traces. */
function summarize(error: unknown, limit = 3) {
  const leaves = reasons(error)
  if (leaves.length === 1 && leaves[0] === error) return message(error)
  const lines = leaves.slice(0, limit).map((leaf) => `\n  ↳ ${message(leaf)}`)
  if (leaves.length > limit) lines.push(`\n  ↳ and ${leaves.length - limit} more`)
  return message(error) + lines.join("")
}

/** Stop a server: close its connections, release the runtimes a session left
 *  running, and leave the process on a deliberate exit code.
 *
 *  A runtime that will not release is not a failed stop. The stop was asked
 *  for, the process is leaving either way, and a non-zero code would mark an
 *  ordinary `systemctl stop` as a failed unit — so it is reported as a warning
 *  naming what did not release, with the detail in the log, and the process
 *  still exits 0. Only a stop that runs out of time exits non-zero. */
export async function stopServer(server: Stoppable, options: { deadlineMs?: number } = {}) {
  // Deliberately never cleared. Unref'd it cannot hold a finished process
  // open, and staying armed past this function's return is exactly what makes
  // it bound the exit as well as the drain.
  const deadline = setTimeout(() => process.exit(STOP_TIMED_OUT), options.deadlineMs ?? STOP_DEADLINE_MS)
  deadline.unref?.()
  await server.stop(true)
  await GracefulShutdown.run({ timeoutMs: DISPOSE_TIMEOUT_MS }).catch((error) => {
    Log.Default.warn("runtime disposal failed while stopping the server", { error })
    UI.println(UI.Style.TEXT_WARNING_BOLD + "Warning: " + UI.Style.TEXT_NORMAL + summarize(error))
  })
}

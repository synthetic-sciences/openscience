import type { SessionRequestProgress } from "@synsci/sdk/v2/client"
import type { UiI18nKey, UiI18nParams } from "../context/i18n"

/** How long a connect may take before the status line starts counting it. A
 * gateway that polls a conflict inside the fetch never leaves this phase, so
 * a long connect has to show the same honest clock as a silent response. */
export const PROGRESS_SLOW_MS = 3_000

/** How long a request may sit without a response before the status line adds
 * the "still open" hint. */
export const PROGRESS_HINT_MS = 30_000

export type ProgressStatus = { key: UiI18nKey; params: UiI18nParams; hint?: UiI18nKey }

/** Status-line copy for a live request phase. The elapsed clock is rebuilt
 * from the server's own offsets (`elapsedMs` at `since`) so client/server
 * skew can only shift it, never make it negative or jump. Terminal phases
 * render nothing so the caller can fall back to its generic copy. */
export function progressStatus(progress: SessionRequestProgress | undefined, now: number): ProgressStatus | undefined {
  if (!progress) return
  const phase = Math.max(0, now - progress.since)
  const seconds = Math.floor((progress.elapsedMs + phase) / 1000)
  const model = progress.modelID
  // Nothing has come back yet, whether the socket is still being set up or the
  // headers arrived and the body is silent: both earn the same hint.
  const hint = phase >= PROGRESS_HINT_MS && { hint: "ui.sessionTurn.progress.stillOpen" as const }
  switch (progress.phase) {
    case "preparing":
      return {
        key: "ui.sessionTurn.progress.preparing",
        params: { model, seconds },
        ...(phase >= PROGRESS_HINT_MS && { hint: "ui.sessionTurn.progress.preparingHint" as const }),
      }
    case "connecting":
      if (phase < PROGRESS_SLOW_MS) return { key: "ui.sessionTurn.progress.connecting", params: { model } }
      return { key: "ui.sessionTurn.progress.stillConnecting", params: { model, seconds }, ...hint }
    case "waiting_first_token":
      return { key: "ui.sessionTurn.progress.waitingFirstToken", params: { model, seconds }, ...hint }
    case "streaming":
      if (progress.lastOutputAt !== undefined && now - progress.lastOutputAt >= PROGRESS_HINT_MS) {
        return {
          key: "ui.sessionTurn.progress.stalled",
          params: { model, seconds: Math.max(0, Math.floor((now - progress.lastOutputAt) / 1000)) },
          hint: "ui.sessionTurn.progress.stalledHint",
        }
      }
      return { key: "ui.sessionTurn.progress.streaming", params: { model } }
    case "conflict_wait":
      return { key: "ui.sessionTurn.progress.conflictWait", params: { seconds } }
    case "retry_wait":
      return {
        key: "ui.sessionTurn.progress.retryWait",
        params: { seconds: Math.max(0, Math.ceil(((progress.retryAfterMs ?? 0) - phase) / 1000)) },
      }
    default:
      return
  }
}

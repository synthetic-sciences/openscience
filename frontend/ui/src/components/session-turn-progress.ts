import type { SessionRequestProgress } from "@synsci/sdk/v2/client"
import type { UiI18nKey, UiI18nParams } from "../context/i18n"

/** How long a request may sit waiting for its first token before the status
 * line adds the "still open" hint. */
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
  switch (progress.phase) {
    case "connecting":
      return { key: "ui.sessionTurn.progress.connecting", params: { model } }
    case "waiting_first_token":
      return {
        key: "ui.sessionTurn.progress.waitingFirstToken",
        params: { model, seconds },
        ...(phase >= PROGRESS_HINT_MS && { hint: "ui.sessionTurn.progress.stillOpen" as const }),
      }
    case "streaming":
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

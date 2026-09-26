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

/** How long a request may go without model output before the header stops
 * calling the wait thinking. Healthy first output lands within two minutes
 * even on long prompts; one request that died after its first byte read as
 * "Thinking" for eighteen minutes. */
export const HEADER_SILENCE_MS = 120_000

/** The phases the header names while a turn runs. A retry countdown and a
 * conflict wait change what the reader might do next, and so does a request
 * silent past `HEADER_SILENCE_MS`: the reader may stop and resend. Anything
 * shorter — the access check, the connect, a brief pause — reads as
 * thinking, with the elapsed clock beside it and the request detail one hover
 * away. A running tool holds the stream open without model output; that is
 * work, not silence, so `tool` keeps a quiet stream calm. */
export function headerProgress(
  progress: SessionRequestProgress | undefined,
  now: number,
  tool = false,
): ProgressStatus | undefined {
  if (progress?.phase === "retry_wait" || progress?.phase === "conflict_wait") return progressStatus(progress, now)
  if (progress?.phase === "connecting" || progress?.phase === "waiting_first_token") {
    if (progress.elapsedMs + Math.max(0, now - progress.since) < HEADER_SILENCE_MS) return
    return { key: "ui.sessionTurn.status.noOutput", params: {} }
  }
  if (progress?.phase !== "streaming" || tool || progress.lastOutputAt === undefined) return
  if (now - progress.lastOutputAt < HEADER_SILENCE_MS) return
  return { key: "ui.sessionTurn.status.noNewOutput", params: {} }
}

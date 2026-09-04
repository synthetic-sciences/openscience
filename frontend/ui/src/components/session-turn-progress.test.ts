import { describe, expect, test } from "bun:test"
import { readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import type { SessionRequestProgress } from "@synsci/sdk/v2/client"
import { dict as en } from "../i18n/en"
import { PROGRESS_HINT_MS, PROGRESS_SLOW_MS, progressStatus } from "./session-turn-progress"

const since = 1_000_000
const base: SessionRequestProgress = {
  sessionID: "ses_progress",
  messageID: "msg_assistant",
  attempt: 1,
  agent: "research",
  providerID: "openrouter",
  modelID: "openai/gpt-5.6-sol",
  phase: "connecting",
  since,
  elapsedMs: 0,
  stalls: 0,
}
const at = (phase: SessionRequestProgress["phase"], extra: Partial<SessionRequestProgress> = {}) => ({
  ...base,
  phase,
  ...extra,
})

describe("request phase status copy", () => {
  test("each live phase names the model and the honest elapsed time", () => {
    expect(progressStatus(at("connecting"), since + PROGRESS_SLOW_MS - 1)).toEqual({
      key: "ui.sessionTurn.progress.connecting",
      params: { model: "openai/gpt-5.6-sol" },
    })
    // A connect that outlives the grace period counts up like a silent
    // response: a gateway polling a conflict inside the fetch never leaves
    // this phase, so the clock is the only honest signal.
    expect(progressStatus(at("connecting"), since + PROGRESS_SLOW_MS)).toEqual({
      key: "ui.sessionTurn.progress.stillConnecting",
      params: { model: "openai/gpt-5.6-sol", seconds: 3 },
    })
    expect(progressStatus(at("connecting"), since + 245_800)).toEqual({
      key: "ui.sessionTurn.progress.stillConnecting",
      params: { model: "openai/gpt-5.6-sol", seconds: 245 },
      hint: "ui.sessionTurn.progress.stillOpen",
    })
    // 7 s elapsed when headers arrived plus 12.4 s in this phase = 19 s.
    expect(progressStatus(at("waiting_first_token", { elapsedMs: 7_000 }), since + 12_400)).toEqual({
      key: "ui.sessionTurn.progress.waitingFirstToken",
      params: { model: "openai/gpt-5.6-sol", seconds: 19 },
    })
    expect(progressStatus(at("streaming", { elapsedMs: 250_000 }), since + 100)).toEqual({
      key: "ui.sessionTurn.progress.streaming",
      params: { model: "openai/gpt-5.6-sol" },
    })
    expect(progressStatus(at("conflict_wait", { elapsedMs: 4_000, stalls: 1 }), since + 3_000)).toEqual({
      key: "ui.sessionTurn.progress.conflictWait",
      params: { seconds: 7 },
    })
    expect(progressStatus(at("retry_wait", { retryAfterMs: 5_000, stalls: 1 }), since + 1_200)).toEqual({
      key: "ui.sessionTurn.progress.retryWait",
      params: { seconds: 4 },
    })
  })

  test("terminal or missing telemetry leaves the generic fallback to the caller", () => {
    expect(progressStatus(undefined, since)).toBeUndefined()
    expect(progressStatus(at("done"), since + 10)).toBeUndefined()
    expect(progressStatus(at("error"), since + 10)).toBeUndefined()
  })

  test("the still-open hint appears only after 30 s without a response", () => {
    for (const phase of ["connecting", "waiting_first_token"] as const) {
      const early = progressStatus(at(phase), since + PROGRESS_HINT_MS - 1)
      const late = progressStatus(at(phase), since + PROGRESS_HINT_MS)
      expect(early?.hint).toBeUndefined()
      expect(late?.hint).toBe("ui.sessionTurn.progress.stillOpen")
    }
    expect(progressStatus(at("streaming"), since + PROGRESS_HINT_MS * 2)?.hint).toBeUndefined()
    expect(progressStatus(at("conflict_wait"), since + PROGRESS_HINT_MS * 2)?.hint).toBeUndefined()
    expect(progressStatus(at("retry_wait", { retryAfterMs: 1 }), since + PROGRESS_HINT_MS * 2)?.hint).toBeUndefined()
  })

  test("clock skew can shift the counter but never make it negative", () => {
    expect(progressStatus(at("waiting_first_token", { elapsedMs: 3_000 }), since - 60_000)?.params).toEqual({
      model: "openai/gpt-5.6-sol",
      seconds: 3,
    })
    expect(progressStatus(at("retry_wait", { retryAfterMs: 1_000 }), since + 5_000)?.params).toEqual({ seconds: 0 })
  })

  test("every phase key exists in every locale with the placeholders it needs", async () => {
    const used = [
      progressStatus(at("connecting"), since),
      progressStatus(at("connecting"), since + PROGRESS_HINT_MS),
      progressStatus(at("waiting_first_token"), since + PROGRESS_HINT_MS),
      progressStatus(at("streaming"), since),
      progressStatus(at("conflict_wait"), since),
      progressStatus(at("retry_wait", { retryAfterMs: 1 }), since),
    ].flatMap((item) => (item ? [item] : []))
    expect(used.length).toBe(6)
    const keys = new Set(used.flatMap((item) => [item.key, ...(item.hint ? [item.hint] : [])]))
    expect(keys.size).toBe(7)
    for (const item of used) {
      for (const name of Object.keys(item.params)) expect(en[item.key]).toContain(`{{${name}}}`)
    }
    const dir = fileURLToPath(new URL("../i18n/", import.meta.url))
    const locales = readdirSync(dir).filter((file) => file.endsWith(".ts"))
    expect(locales.length).toBe(15)
    for (const file of locales) {
      const mod = (await import(`${dir}${file}`)) as { dict: Record<string, string> }
      for (const key of keys) expect(`${file}:${key}:${mod.dict[key] ?? ""}`).not.toBe(`${file}:${key}:`)
      for (const item of used) {
        for (const name of Object.keys(item.params)) expect(mod.dict[item.key]).toContain(`{{${name}}}`)
      }
    }
  })
})

describe("session turn wiring", () => {
  const source = Bun.file(new URL("./session-turn.tsx", import.meta.url)).text()

  test("renders the request phase before any part exists and keeps the generic copy last", async () => {
    const component = await source
    expect(component).toContain("progressStatus(progress(), store.now)")
    expect(component).toContain("if (store.status) return store.status")
    expect(component).toContain('i18n.t("ui.sessionTurn.status.consideringNextSteps")')
    expect(component).toContain('<span data-slot="session-turn-status-text">{statusText()}</span>')
    expect(component).toContain('data-slot="session-turn-progress-hint"')
    expect(component).toContain("message.id === item.messageID")
  })
})

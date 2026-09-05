import { describe, expect, test } from "bun:test"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { SessionProcessor } from "../../src/session/processor"
import { SessionStatus } from "../../src/session/status"
import { SessionTelemetry } from "../../src/session/telemetry"
import { tmpdir, trustProject } from "../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

const MARKER = "REQUEST_PROGRESS_MAIN_REQUEST"
const DELAY_MS = 400
const encoder = new TextEncoder()

function chunk(delta: Record<string, unknown>, finish: string | null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-progress",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1_000),
    model: STRESS_PROVIDER_MODEL,
    choices: [{ index: 0, delta, finish_reason: finish }],
    ...(finish ? { usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } } : {}),
  })}\n\n`
}

function sse(body: ReadableStream<Uint8Array> | string) {
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
}

function immediate(text: string) {
  return sse(`${chunk({ role: "assistant", content: text }, null)}${chunk({}, "stop")}data: [DONE]\n\n`)
}

/** Headers first, then only an SSE keepalive comment and a role-only delta for
 * `DELAY_MS`, then the real content: the gateway shape seen in the field where
 * the first body chunk arrives with the headers but is not first output. */
function delayed(marks: { headers?: number; content?: number }) {
  const pipe = new TransformStream<Uint8Array, Uint8Array>()
  void (async () => {
    const writer = pipe.writable.getWriter()
    await writer.write(encoder.encode(": OPENROUTER PROCESSING\n\n"))
    await writer.write(encoder.encode(chunk({ role: "assistant", content: "" }, null)))
    await writer.write(encoder.encode(chunk({ reasoning_content: "[RE" }, null)))
    await writer.write(encoder.encode(chunk({ reasoning_content: "DACTED]" }, null)))
    await Bun.sleep(DELAY_MS)
    marks.content = Date.now()
    await writer.write(encoder.encode(chunk({ content: "Delayed first token" }, null)))
    await writer.write(encoder.encode(chunk({}, "stop")))
    await writer.write(encoder.encode("data: [DONE]\n\n"))
    await writer.close()
  })()
  marks.headers = Date.now()
  return sse(pipe.readable)
}

async function until(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for request progress events")
    await Bun.sleep(10)
  }
}

describe("session.request.progress", () => {
  test.each([
    ["", "[REDACTED]", false],
    ["[RE", "DACTED]", false],
    ["Readable thought", "[RE", false],
    ["Readable thought[RE", "DACTED]", false],
    ["[REDACTED]", "Actual reasoning", true],
    ["Readable thought", " \n", false],
    ["Readable thought", " continues", true],
  ] as const)("distinguishes readable reasoning from private placeholders", (text, delta, expected) => {
    expect(SessionProcessor.readableReasoning(text, delta)).toBe(expected)
  })

  test("retains preflight time and tracks output activity without resetting the phase or flooding the bus", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const seen: SessionTelemetry.RequestProgress[] = []
        Bus.subscribe(SessionTelemetry.Event.Progress, (event) => seen.push(event.properties))
        const base = {
          sessionID: "ses_activity",
          messageID: "msg_activity",
          attempt: 1,
          agent: "research",
          providerID: "stress",
          modelID: "fixture-model",
        }
        const preparing = SessionTelemetry.recordProgress({ ...base, phase: "preparing" })
        await Bun.sleep(20)
        const connecting = SessionTelemetry.recordProgress({ ...base, phase: "connecting" })
        expect(connecting.elapsedMs).toBe(connecting.since - preparing.since)
        expect(connecting.elapsedMs).toBeGreaterThanOrEqual(15)
        SessionTelemetry.recordProgress({ ...base, phase: "waiting_first_token" })
        const streaming = SessionTelemetry.recordProgress({ ...base, phase: "streaming" })
        await Bun.sleep(20)
        for (let n = 0; n < 100; n++) SessionTelemetry.recordProgress({ ...base, phase: "streaming" })
        expect(SessionTelemetry.progress(base.sessionID)?.lastOutputAt).toBeGreaterThan(streaming.lastOutputAt!)
        expect(seen.filter((item) => item.phase === "streaming")).toHaveLength(1)
        await Bun.sleep(1_000)
        SessionTelemetry.recordProgress({ ...base, phase: "streaming" })
        await until(() => seen.filter((item) => item.phase === "streaming").length === 2)
        const activity = SessionTelemetry.progress(base.sessionID)!
        expect(activity.since).toBe(streaming.since)
        expect(activity.elapsedMs).toBe(streaming.elapsedMs)
        expect(activity.firstOutputMs).toBe(streaming.firstOutputMs)
        expect(activity.lastOutputAt).toBeGreaterThan(streaming.lastOutputAt! + 1_000)
        SessionTelemetry.recordProgress({ ...base, phase: "done" })
        expect(SessionTelemetry.progress(base.sessionID)?.lastOutputAt).toBe(activity.lastOutputAt)
      },
    })
  })

  test("reports headers as waiting_first_token and only real content as streaming", async () => {
    const marks: { headers?: number; content?: number } = {}
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        if (new URL(request.url).pathname !== "/v1/chat/completions") return new Response("not found", { status: 404 })
        const body = await request.json()
        // Title/summary helpers run in the background on the first turn; keep
        // them instant so the timing assertions only see the main request.
        return JSON.stringify(body).includes(MARKER) ? delayed(marks) : immediate("Background helper reply")
      },
    })
    await using tmp = await tmpdir({
      git: true,
      config: stressProviderConfig(`http://127.0.0.1:${server.port}/v1`),
    })

    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        await trustProject()
        await Provider.invalidate()
      },
      fn: async () => {
        const seen: SessionTelemetry.RequestProgress[] = []
        Bus.subscribe(SessionTelemetry.Event.Progress, (event) => seen.push(event.properties))
        const session = await Session.create({ title: "Request progress" })
        const result = await SessionPrompt.prompt({
          sessionID: session.id,
          model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
          agent: "research",
          delegation: false,
          system: MARKER,
          parts: [{ type: "text", text: "Return a deterministic response." }],
        })
        expect(result.info.role).toBe("assistant")
        const mine = () => seen.filter((item) => item.messageID === result.info.id)
        await until(() => mine().some((item) => item.phase === "done"))

        const phases = mine()
        expect(phases.map((item) => item.phase)).toEqual([
          "preparing",
          "connecting",
          "waiting_first_token",
          "streaming",
          "done",
        ])
        expect(phases[0]).toMatchObject({
          sessionID: session.id,
          attempt: 1,
          agent: "research",
          providerID: STRESS_PROVIDER_ID,
          modelID: STRESS_PROVIDER_MODEL,
          elapsedMs: 0,
          stalls: 0,
        })

        const waiting = phases[2]
        const streaming = phases[3]
        // Headers were observed while the body still held only the keepalive
        // comment and the role-only delta.
        expect(waiting.since).toBeGreaterThanOrEqual(marks.headers!)
        expect(waiting.since).toBeLessThan(marks.content!)
        // First output is stamped when real content is parsed, never earlier.
        expect(streaming.since).toBeGreaterThanOrEqual(marks.content!)
        expect(streaming.since - waiting.since).toBeGreaterThanOrEqual(DELAY_MS - 50)
        expect(streaming.firstOutputMs).toBeGreaterThanOrEqual(DELAY_MS - 50)
        expect(streaming.elapsedMs).toBe(streaming.firstOutputMs!)

        expect(streaming.lastOutputAt).toBeGreaterThanOrEqual(marks.content!)
        const done = phases[4]
        expect(done.firstOutputMs).toBe(streaming.firstOutputMs)
        expect(done.elapsedMs).toBeGreaterThanOrEqual(streaming.elapsedMs)
        expect(SessionTelemetry.progress(session.id)).toEqual(done)
      },
    })
  }, 20_000)

  test("mirrors a retry countdown as retry_wait and ignores repeated phases", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const seen: SessionTelemetry.RequestProgress[] = []
        Bus.subscribe(SessionTelemetry.Event.Progress, (event) => seen.push(event.properties))
        const base = {
          sessionID: "ses_progress",
          messageID: "msg_progress",
          attempt: 1,
          agent: "research",
          providerID: "stress",
          modelID: "fixture-model",
        }
        SessionTelemetry.recordProgress({ ...base, phase: "connecting" })
        SessionTelemetry.recordProgress({ ...base, phase: "streaming" })
        SessionTelemetry.recordProgress({ ...base, phase: "streaming" })
        SessionStatus.set("ses_progress", {
          type: "retry",
          attempt: 2,
          message: "Provider Server Error",
          next: Date.now() + 1_500,
        })
        // A session with no in-flight request record has nothing to attribute.
        SessionStatus.set("ses_unknown", { type: "retry", attempt: 1, message: "noise", next: Date.now() + 1_000 })
        await until(() => seen.length >= 3)
        await Bun.sleep(20)

        expect(seen.map((item) => item.phase)).toEqual(["connecting", "streaming", "retry_wait"])
        expect(seen[2]).toMatchObject({
          messageID: "msg_progress",
          attempt: 2,
          agent: "research",
          providerID: "stress",
          modelID: "fixture-model",
          detail: "Provider Server Error",
          stalls: 1,
        })
        expect(seen[2].retryAfterMs).toBeGreaterThan(1_000)
        expect(seen[2].retryAfterMs).toBeLessThanOrEqual(1_500)
        expect(seen[2].firstOutputMs).toBe(seen[1].firstOutputMs)
        expect(SessionTelemetry.progress("ses_progress")).toEqual(seen[2])
        expect(SessionTelemetry.progress("ses_unknown")).toBeUndefined()
        SessionStatus.set("ses_progress", { type: "idle" })
      },
    })
  })
})

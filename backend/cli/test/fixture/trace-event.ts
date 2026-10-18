import type { TraceQueue } from "../../src/session/trace-queue"

export const installation = "00000000-0000-4000-8000-000000000099"
export function traceEvent(index = 1): TraceQueue.Row {
  return {
    account: "fixture-account",
    event: {
      event_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      schema_version: 2,
      event_type: "model.response",
      occurred_at: "2026-10-18T00:00:00.000Z",
      installation_id: installation,
      trace_id: "a".repeat(32),
      span_id: "b".repeat(16),
      session_id: "c".repeat(64),
      run_id: "d".repeat(64),
      model_route: "byok",
      provider_id: "openai",
      model_id: "fixture",
      payload: { usage: { input_tokens: 0, reasoning_tokens: null } },
    },
  }
}

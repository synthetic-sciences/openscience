# Diagnose model request latency

OpenScience records local preparation, response headers, and readable output separately. Use these timings to locate a delay before changing account checks, model settings, or retry behavior. The instrumentation measures latency; it does not make model inference faster.

## Request phases

The desktop consumes `session.request.progress`, defined in [session/telemetry.ts](../../backend/cli/src/session/telemetry.ts) and emitted by [session/processor.ts](../../backend/cli/src/session/processor.ts).

| Phase                          | Boundary                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `preparing`                    | Local request preparation, including credential, funding, balance, and runtime checks.                                               |
| `connecting`                   | The provider fetch is being dispatched, after local preparation. It remains here until the SDK receives response headers.            |
| `waiting_first_token`          | Response headers arrived, but no readable model output or tool-call activity has arrived.                                            |
| `streaming`                    | Readable text, readable reasoning, or tool-call activity has arrived. The request can subsequently become silent without closing.    |
| `conflict_wait` / `retry_wait` | An existing request is being waited on, or an existing retry policy is counting down. Telemetry does not authorize another dispatch. |
| `done` / `error`               | Processing settled.                                                                                                                  |

`since` marks the current phase's start. `elapsedMs` is the attempt's elapsed time at that boundary; the attempt clock continues across `preparing` → `connecting`. `firstOutputMs` records the delay from the beginning of the attempt that produced the message's first readable output and remains available through later phases or retries. It is not total conversation duration.

`lastOutputAt` records the latest readable output or tool-call activity. Streaming activity refreshes the local record on every meaningful delta and publishes updates at most once per second, without resetting `since`. The UI can identify an open stream with no new output; silence alone does not prove that the model, gateway, or network failed.

SSE comments, role-only deltas, whitespace-only text, and private reasoning placeholders such as `[REDACTED]` do not count as readable output. Split placeholders are handled across deltas. A tool name or partial tool arguments count as output, but do not prove that a tool executed. Tool execution has its own pending, running, completed, and error states.

## Correlate local and gateway logs

The local runtime emits three INFO records:

- `request response`: response headers arrived, with `responseStartMs` and any validated gateway metadata. This record is available while the stream is still open.
- `request first output`: the first readable output, with `firstOutputMs` and the selected model and agent.
- `request timing`: the HTTP response body completed, failed, or was cancelled. It includes the outcome, response-header delay, first body-chunk delay, active-body duration, and total request duration. Body completion is not proof that an assistant finished all of its tools.

Match `sessionID`, `messageID`, and `attempt` to the visible assistant turn. Each HTTP fetch also has a local `requestID`, shared by its response and completion records. Background title or summary requests must be distinguished by message and agent. First-body-chunk timing can describe a keepalive; use readable-output timing for user-visible latency.

For the validated managed route, [provider/gateway-timing.ts](../../backend/cli/src/provider/gateway-timing.ts) reads the server-generated `x-openscience-gateway-request-id` as `gatewayRequestID`. This 32-character hexadecimal ID joins desktop records to the gateway's records for that HTTP request. It is distinct from the local `requestID` and from an idempotency key.

The parser also accepts these `Server-Timing` metrics:

```text
os_authenticated
os_authorized
os_admitted
os_upstream_dispatch
os_upstream_headers
os_upstream_response
```

Their `dur` values are **millisecond offsets from gateway arrival**, stored in `gatewayTiming`, rather than independent stage durations. Headers are emitted for streaming responses; the buffered path can report `os_upstream_response`. Missing metrics mean unknown, not zero. Unknown metrics, descriptions, arbitrary response headers, malformed IDs, and ambiguous offsets are excluded. Direct provider responses do not contribute gateway metadata.

## Interpret the measurements

Subtract consecutive offsets only when both belong to the same gateway request. For example, `os_upstream_headers - os_upstream_dispatch` measures the gateway's upstream wait. It can include connection-pool wait, DNS/TLS setup, network transit, provider admission, prompt processing, and other upstream work. It does not isolate model thinking or OpenRouter queue time.

The local response-header delay spans a different boundary: desktop dispatch through gateway processing and delivery of headers back to the desktop. Subtracting a gateway offset from it does not isolate network latency. Avoid subtracting absolute timestamps from machines with independent clocks.

After streaming headers have been sent, the gateway cannot add the later first-content time to those headers. Correlate gateway stream logs with the desktop's first-readable-output record to investigate that interval. A long context, a high reasoning setting, or reported cache usage can help explain a result, but none independently proves where the delay occurred. Preserve missing observations as unknown, and compare matched requests before claiming a speed improvement.

## Focused verification

From `backend/cli`, these tests exercise the actual parser, dispatch observation, phase transitions, split private placeholders, keepalive handling, and activity throttling without paid model calls:

```bash
bun test --timeout 15000 ./test/provider/gateway-timing.test.ts ./test/provider/idle-watchdog.test.ts ./test/session/request-progress.test.ts ./test/session/telemetry.test.ts
```

When changing the progress schema, regenerate the SDK with `./tooling/repo/generate.ts` from the repository root and update the workspace's phase handling in the same change.

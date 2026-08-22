import { describe, expect, test } from "bun:test"
import { requestFailure, requestStatus } from "./request-error"

describe("requestFailure", () => {
  test("separates transport, server-health, and provider failures", () => {
    expect(requestFailure(new TypeError("fetch failed: ECONNREFUSED"), "Send prompt")).toMatchObject({
      kind: "transport",
      title: "Local server is unreachable",
    })
    expect(requestFailure({ status: 503, data: { message: "warming up" } }, "Send prompt")).toMatchObject({
      kind: "health",
      title: "Local server reported an error",
    })
    expect(
      requestFailure({ name: "APIError", data: { message: "insufficient balance", statusCode: 402 } }, "Send prompt"),
    ).toMatchObject({ kind: "provider", title: "Model provider request failed" })
  })

  test("explains ambiguous session creation without encouraging a new ID", () => {
    expect(
      requestFailure(new TypeError("fetch failed"), "Create session", {
        ambiguousCreate: true,
        candidate: "ses_stable",
      }),
    ).toEqual({
      kind: "ambiguous-create",
      title: "Session creation is awaiting confirmation",
      description:
        "The server did not confirm whether the session was created (ses_stable). Retry this saved draft; OpenScience will reuse the same session ID instead of creating a duplicate.",
    })
  })

  test("reads status codes from common SDK error envelopes", () => {
    expect(requestStatus({ data: { statusCode: 404 } })).toBe(404)
    expect(requestStatus({ response: { status: 502 } })).toBe(502)
  })
})

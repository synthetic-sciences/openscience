import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { SessionRetry } from "../../src/session/retry"
import { MessageV2 } from "../../src/session/message-v2"
import { NamedError } from "@synsci/util/error"

function apiError(headers?: Record<string, string>): MessageV2.APIError {
  return new MessageV2.APIError({
    message: "boom",
    isRetryable: true,
    responseHeaders: headers,
  }).toObject() as MessageV2.APIError
}

function wrap(message: unknown) {
  return new NamedError.Unknown({ message: String(message) }).toObject()
}

describe("session.retry.delay", () => {
  test("caps delay at 30 seconds when headers missing", () => {
    const error = apiError()
    const delays = Array.from({ length: 10 }, (_, index) => SessionRetry.delay(index + 1, error))
    expect(delays).toStrictEqual([2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000, 30000, 30000])
  })

  test("prefers retry-after-ms when shorter than exponential", () => {
    const error = apiError({ "retry-after-ms": "1500" })
    expect(SessionRetry.delay(4, error)).toBe(1500)
  })

  test("uses retry-after seconds when reasonable", () => {
    const error = apiError({ "retry-after": "30" })
    expect(SessionRetry.delay(3, error)).toBe(30000)
  })

  test("accepts http-date retry-after values", () => {
    const date = new Date(Date.now() + 20000).toUTCString()
    const error = apiError({ "retry-after": date })
    const d = SessionRetry.delay(1, error)
    expect(d).toBeGreaterThanOrEqual(19000)
    expect(d).toBeLessThanOrEqual(20000)
  })

  test("ignores invalid retry hints", () => {
    const error = apiError({ "retry-after": "not-a-number" })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("ignores malformed date retry hints", () => {
    const error = apiError({ "retry-after": "Invalid Date String" })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("ignores past date retry hints", () => {
    const pastDate = new Date(Date.now() - 5000).toUTCString()
    const error = apiError({ "retry-after": pastDate })
    expect(SessionRetry.delay(1, error)).toBe(2000)
  })

  test("uses retry-after values even when exceeding 10 minutes with headers", () => {
    const error = apiError({ "retry-after": "50" })
    expect(SessionRetry.delay(1, error)).toBe(50000)

    const longError = apiError({ "retry-after-ms": "700000" })
    expect(SessionRetry.delay(1, longError)).toBe(700000)
  })

  test("sleep caps delay to max 32-bit signed integer to avoid TimeoutOverflowWarning", async () => {
    const controller = new AbortController()

    const warnings: string[] = []
    const originalWarn = process.emitWarning
    process.emitWarning = (warning: string | Error) => {
      warnings.push(typeof warning === "string" ? warning : warning.message)
    }

    const promise = SessionRetry.sleep(2_560_914_000, controller.signal)
    controller.abort()

    try {
      await promise
    } catch {}

    process.emitWarning = originalWarn
    expect(warnings.some((w) => w.includes("TimeoutOverflowWarning"))).toBe(false)
  })
})

describe("session.retry.retryable", () => {
  test("maps too_many_requests json messages", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { type: "too_many_requests" } }))
    expect(SessionRetry.retryable(error)).toBe("Too Many Requests")
  })

  test("maps overloaded provider codes", () => {
    const error = wrap(JSON.stringify({ code: "resource_exhausted" }))
    expect(SessionRetry.retryable(error)).toBe("Provider is overloaded")
  })

  test("handles json messages without code", () => {
    const error = wrap(JSON.stringify({ error: { message: "no_kv_space" } }))
    expect(SessionRetry.retryable(error)).toBe("Provider Server Error")
  })

  test("does not throw on numeric error codes", () => {
    const error = wrap(JSON.stringify({ type: "error", error: { code: 123 } }))
    const result = SessionRetry.retryable(error)
    expect(result).toBeUndefined()
  })

  test("returns undefined for non-json message", () => {
    const error = wrap("not-json")
    expect(SessionRetry.retryable(error)).toBeUndefined()
  })
})

describe("session.message-v2.fromError", () => {
  test.concurrent(
    "converts ECONNRESET socket errors to retryable APIError",
    async () => {
      using server = Bun.serve({
        port: 0,
        idleTimeout: 8,
        async fetch(req) {
          return new Response(
            new ReadableStream({
              async pull(controller) {
                controller.enqueue("Hello,")
                await Bun.sleep(10000)
                controller.enqueue(" World!")
                controller.close()
              },
            }),
            { headers: { "Content-Type": "text/plain" } },
          )
        },
      })

      const error = await fetch(new URL("/", server.url.origin))
        .then((res) => res.text())
        .catch((e) => e)

      const result = MessageV2.fromError(error, { providerID: "test" })

      expect(MessageV2.APIError.isInstance(result)).toBe(true)
      expect((result as MessageV2.APIError).data.isRetryable).toBe(true)
      expect((result as MessageV2.APIError).data.message).toBe("Connection reset by server")
      expect((result as MessageV2.APIError).data.metadata?.code).toBe("ECONNRESET")
      expect((result as MessageV2.APIError).data.metadata?.message).toInclude("socket connection")
    },
    15_000,
  )

  test("ECONNRESET socket error is retryable", () => {
    const error = new MessageV2.APIError({
      message: "Connection reset by server",
      isRetryable: true,
      metadata: { code: "ECONNRESET", message: "The socket connection was closed unexpectedly" },
    }).toObject() as MessageV2.APIError

    const retryable = SessionRetry.retryable(error)
    expect(retryable).toBeDefined()
    expect(retryable).toBe("Connection reset by server")
  })

  test("marks OpenAI 404 status codes as retryable", () => {
    const error = new APICallError({
      message: "boom",
      url: "https://api.openai.com/v1/chat/completions",
      requestBodyValues: {},
      statusCode: 404,
      responseHeaders: { "content-type": "application/json" },
      responseBody: '{"error":"boom"}',
      isRetryable: false,
    })
    const result = MessageV2.fromError(error, { providerID: "openai" }) as MessageV2.APIError
    expect(result.data.isRetryable).toBe(true)
  })
})

describe("SessionRetry.isContextOverflow", () => {
  const api = (data: {
    statusCode?: number
    responseBody?: string
    message?: string
  }) =>
    new MessageV2.APIError({ message: "", isRetryable: true, ...data }).toObject() as MessageV2.APIError

  test("true for OpenAI/Codex context_length_exceeded code in responseBody", () => {
    const err = api({
      statusCode: 400,
      responseBody: JSON.stringify({
        error: { type: "invalid_request_error", code: "context_length_exceeded", message: "Your input exceeds the context window of this model." },
      }),
    })
    expect(SessionRetry.isContextOverflow(err)).toBe(true)
  })

  test("false for string_above_max_length alone — an oversized single field is not total-context overflow", () => {
    // string_above_max_length fires when ONE string parameter exceeds its per-field limit,
    // which compaction can't fix. Only classify it as overflow if the message ALSO describes
    // a context-window condition (caught by the patterns), not on the code alone.
    const err = api({ statusCode: 400, responseBody: JSON.stringify({ error: { code: "string_above_max_length", message: "too long" } }) })
    expect(SessionRetry.isContextOverflow(err)).toBe(false)
  })

  test("true for Anthropic-style 'prompt is too long' message (no code)", () => {
    const err = wrap(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens > 200000 maximum" } }))
    expect(SessionRetry.isContextOverflow(err)).toBe(true)
  })

  test("true for Gemini-style INVALID_ARGUMENT message that mentions the context window", () => {
    const err = wrap(JSON.stringify({ error: { status: "INVALID_ARGUMENT", message: "The input token count exceeds the maximum number of tokens allowed." } }))
    expect(SessionRetry.isContextOverflow(err)).toBe(true)
  })

  test("false for a 5xx server error even if its body mentions context", () => {
    const err = api({ statusCode: 503, responseBody: JSON.stringify({ error: { message: "context service temporarily unavailable" } }) })
    expect(SessionRetry.isContextOverflow(err)).toBe(false)
  })

  test("false for a plain rate limit", () => {
    const err = api({ statusCode: 429, responseBody: JSON.stringify({ error: { type: "too_many_requests", message: "Rate limited" } }) })
    expect(SessionRetry.isContextOverflow(err)).toBe(false)
  })

  test("false for an unrelated bad-parameter invalid_request_error", () => {
    const err = api({ statusCode: 400, responseBody: JSON.stringify({ error: { type: "invalid_request_error", message: "Unknown parameter: 'foo'." } }) })
    expect(SessionRetry.isContextOverflow(err)).toBe(false)
  })

  test("false for a 429 rate limit whose message mentions reducing prompt length", () => {
    // A retryable TPM rate limit must not be treated as a deterministic overflow.
    const err = api({
      statusCode: 429,
      responseBody: JSON.stringify({ error: { message: "Rate limit reached. Please reduce your prompt length and retry." } }),
    })
    expect(SessionRetry.isContextOverflow(err)).toBe(false)
  })

  test("false for rate-limit-guidance wording no longer in the overflow patterns", () => {
    // "too many tokens" / "reduce the length" were removed — they also appear in
    // rate-limit guidance, and no remaining overflow pattern is present here.
    const err = api({
      statusCode: 400,
      responseBody: JSON.stringify({ error: { message: "You are sending too many tokens; reduce the length of the messages." } }),
    })
    expect(SessionRetry.isContextOverflow(err)).toBe(false)
  })

  test("false for a streamed (statusCode-less) rate limit that also mentions token counts", () => {
    // No statusCode → the numeric 5xx/429 guards can't fire. A Gemini/quota rate limit
    // whose text mentions "input token count" must stay retryable, not be turned into a
    // deterministic overflow (which would burn the turn on a terminal 'too large').
    const err = wrap(
      JSON.stringify({
        error: {
          status: "RESOURCE_EXHAUSTED",
          message: "Quota exceeded: input token count over the per-minute limit, please try again later.",
        },
      }),
    )
    expect(SessionRetry.isContextOverflow(err)).toBe(false)
  })
})

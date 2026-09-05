import { expect, test } from "bun:test"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { streamText } from "ai"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { SessionRetry } from "../../src/session/retry"

test.each(
  ["managed_request_timeout", "managed_response_incomplete"].flatMap((code) =>
    [false, true].map((partial) => ({ code, partial })),
  ),
)(
  "keeps a managed HTTP-200 stream failure terminal: %j",
  async ({ code, partial }) => {
    // Exact gateway terminal SSE shape: this is an error within an
    // already-started response, not an HTTP 4xx that an SDK can classify early.
    const timeout = {
      error: {
        code,
        type: code,
        message:
          code === "managed_response_incomplete"
            ? "The managed response ended before completion. Its provider outcome is unknown; it will not be retried automatically."
            : "The managed response stopped making progress. Its provider outcome is unknown; it will not be retried automatically.",
        metadata: { retryable: false, dispatch_state: "outcome_unknown", phase: "content" },
      },
      choices: [{ index: 0, delta: {}, finish_reason: "error" }],
    }
    const content = {
      id: "chatcmpl-managed-timeout",
      object: "chat.completion.chunk",
      created: 1,
      model: "openai/test",
      choices: [{ index: 0, delta: { role: "assistant", content: "Saved partial answer." }, finish_reason: null }],
    }
    let requests = 0
    using server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        requests++
        return new Response(
          `${partial ? `data: ${JSON.stringify(content)}\n\n` : ""}data: ${JSON.stringify(timeout)}\n\ndata: [DONE]\n\n`,
          { status: 200, headers: { "content-type": "text/event-stream" } },
        )
      },
    })
    const provider = createOpenRouter({ apiKey: "test-local-only", baseURL: `${server.url.origin}/api/v1` })
    const response = streamText({
      model: provider.chat("openai/test"),
      prompt: "Return the local fixture.",
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(2_000),
      onError() {},
    })
    const errors: unknown[] = []
    const text: string[] = []
    for await (const part of response.fullStream) {
      if (part.type === "error") errors.push(part.error)
      if (part.type === "text-delta") text.push(part.text)
    }
    expect(requests).toBe(1)
    expect(errors).toHaveLength(1)
    expect(text.join("")).toBe(partial ? "Saved partial answer." : "")
    const normalized = MessageV2.fromError(errors[0], { providerID: "openrouter" })
    expect(SessionRetry.retryable(normalized)).toBeUndefined()
    expect(SessionRetry.isContextOverflow(normalized)).toBe(false)
    expect(SessionProcessor.providerFailureAction(errors[0], normalized, false)).toEqual({ type: "terminal" })
    expect(SessionProcessor.providerFailureAction(errors[0], normalized, true)).toEqual({ type: "terminal" })
    const shown = SessionRetry.terminal(normalized)
    expect(shown).toMatchObject({
      name: "APIError",
      data: {
        isRetryable: false,
        metadata: { code, action: "resubmit", dispatch_state: "outcome_unknown" },
      },
    })
    expect(shown.data.message).toContain("Partial output and completed tool results are kept")
    expect(shown.data.message).toContain("did not retry automatically")
    expect(shown.data.message).toContain("may still bill")
    expect(shown.data.message).not.toContain('"error":')
    expect(SessionRetry.retryable(shown)).toBeUndefined()
  },
  5_000,
)

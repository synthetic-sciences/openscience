import { describe, expect, test } from "bun:test"
import { createXai } from "@ai-sdk/xai"
import { streamText } from "ai"

/** A Grok 4.5 turn replayed from the wire. xAI opens every Responses stream
 *  with `response.created` carrying `"usage": null`; @ai-sdk/xai@2.0.51 marked
 *  that field optional (accepts *absent*) rather than nullable, so the first
 *  SSE event failed every branch of the chunk union and the turn died before
 *  any content. tooling/patches/@ai-sdk%2Fxai@2.0.51.patch makes it nullish,
 *  matching the upstream fix in @ai-sdk/xai@4.0.25. */
const events = [
  {
    sequence_number: 0,
    type: "response.created",
    response: {
      created_at: 1785764408,
      id: "55a979f0-880b-9e72-85bd-0e7211a8ea43",
      model: "grok-4.5",
      object: "response",
      output: [],
      usage: null,
      status: "in_progress",
    },
  },
  {
    type: "response.output_item.added",
    output_index: 0,
    item: { type: "message", role: "assistant", content: [], id: "msg-1", status: "in_progress" },
  },
  {
    type: "response.content_part.added",
    item_id: "msg-1",
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "" },
  },
  { type: "response.output_text.delta", item_id: "msg-1", output_index: 0, content_index: 0, delta: "OK" },
  { type: "response.output_text.done", item_id: "msg-1", output_index: 0, content_index: 0, text: "OK" },
  {
    type: "response.content_part.done",
    item_id: "msg-1",
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "OK" },
  },
  {
    type: "response.output_item.done",
    output_index: 0,
    item: {
      type: "message",
      role: "assistant",
      content: [{ type: "output_text", text: "OK" }],
      id: "msg-1",
      status: "completed",
    },
  },
  {
    type: "response.completed",
    response: {
      created_at: 1785764408,
      id: "55a979f0-880b-9e72-85bd-0e7211a8ea43",
      model: "grok-4.5",
      object: "response",
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "OK" }],
          id: "msg-1",
          status: "completed",
        },
      ],
      usage: { input_tokens: 9, output_tokens: 2, total_tokens: 11 },
      status: "completed",
    },
  },
]

/** Canned SSE body: data, not a mock. Nothing inside the provider is stubbed —
 *  the real @ai-sdk/xai Responses model parses these bytes. */
function replay() {
  const body = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")
  const fetch = async () => new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } })
  return fetch as unknown as typeof globalThis.fetch
}

describe("xAI Responses stream tolerates a null usage on response.created", () => {
  test("Grok 4.5 streams its text instead of aborting on the opening chunk", async () => {
    const sdk = createXai({ apiKey: "test", baseURL: "https://xai.test/v1", fetch: replay() })
    const result = streamText({ model: sdk.responses("grok-4.5"), prompt: "Reply with exactly: OK" })

    const errors: unknown[] = []
    const text: string[] = []
    for await (const part of result.fullStream) {
      if (part.type === "error") errors.push(part.error)
      if (part.type === "text-delta") text.push(part.text)
    }

    expect(errors).toEqual([])
    expect(text.join("")).toBe("OK")
  })
})

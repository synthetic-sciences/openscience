import { describe, expect, test } from "bun:test"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { generateText, stepCountIs, streamText, tool } from "ai"
import z from "zod"

const encrypted = { type: "reasoning.encrypted", data: "opaque-local-fixture", index: 0 }
const text = "A provider sentence.  \n"
const summary = "**Provider heading**\n\nA provider summary.  \n"
const cases = [
  { name: "legacy only", legacy: text, details: undefined, expected: text },
  { name: "empty details", legacy: text, details: [], expected: text },
  { name: "encrypted details and legacy text", legacy: text, details: [encrypted], expected: text },
  {
    name: "empty text detail and legacy text",
    legacy: text,
    details: [encrypted, { type: "reasoning.text", text: "", index: 1 }],
    expected: text,
  },
  {
    name: "empty summary detail and legacy text",
    legacy: text,
    details: [encrypted, { type: "reasoning.summary", summary: "", index: 1 }],
    expected: text,
  },
  {
    name: "whitespace text detail and legacy text without changing signed bytes",
    legacy: text,
    details: [encrypted, { type: "reasoning.text", text: " \n", signature: "offline-signature", index: 1 }],
    expected: " \n" + text,
  },
  {
    name: "whitespace summary detail and legacy text without changing source bytes",
    legacy: text,
    details: [encrypted, { type: "reasoning.summary", summary: " \n", index: 1 }],
    expected: " \n" + text,
  },
  {
    name: "readable text details without duplicating legacy",
    legacy: text,
    details: [encrypted, { type: "reasoning.text", text, index: 1 }],
    expected: text,
  },
  {
    name: "readable summary details without duplicating legacy",
    legacy: summary,
    details: [encrypted, { type: "reasoning.summary", summary, index: 1 }],
    expected: summary,
  },
  {
    name: "all readable details without duplicating legacy",
    legacy: text + summary,
    details: [{ type: "reasoning.text", text, index: 0 }, { type: "reasoning.summary", summary, index: 1 }, encrypted],
    expected: text + summary,
  },
  { name: "encrypted-only response stays private", legacy: undefined, details: [encrypted], expected: "" },
]

for (const mode of ["stream", "buffered"] as const) {
  describe(`OpenRouter ${mode} reasoning`, () => {
    test.each(cases)("preserves $name", async ({ legacy, details, expected }) => {
      const message = { role: "assistant", reasoning: legacy, reasoning_details: details }
      let requests = 0
      const provider = createOpenRouter({
        apiKey: "offline-fixture",
        fetch: Object.assign(
          async () => {
            requests++
            if (mode === "buffered") {
              return Response.json({
                id: "chatcmpl-local",
                object: "chat.completion",
                created: 1,
                model: "openai/test",
                choices: [{ index: 0, message: { ...message, content: "Answer." }, finish_reason: "stop" }],
                usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
              })
            }
            const frames = [message, { content: "Answer." }, {}].map((delta, index) => ({
              id: "chatcmpl-local",
              object: "chat.completion.chunk",
              created: 1,
              model: "openai/test",
              choices: [{ index: 0, delta, finish_reason: index === 2 ? "stop" : null }],
            }))
            return new Response(
              frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n",
              {
                headers: { "content-type": "text/event-stream" },
              },
            )
          },
          {
            preconnect() {
              throw new Error("Offline fixture must not open a connection")
            },
          },
        ),
      })
      const options = {
        model: provider.chat("openai/test"),
        prompt: "Read the offline fixture.",
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(2_000),
      }
      const result = mode === "stream" ? streamText(options) : await generateText(options)
      const reasoning = await result.reasoning
      const metadata = await result.providerMetadata
      // The SDK's opaque placeholder is not plaintext. All actual supplied
      // text, including provider Markdown and whitespace, must survive exactly.
      expect(
        reasoning
          .map((part) => part.text)
          .join("")
          .replaceAll("[REDACTED]", ""),
      ).toBe(expected)
      if (details?.includes(encrypted)) {
        expect(metadata?.openrouter?.reasoning_details).toContainEqual(encrypted)
      }
      for (const detail of details ?? []) {
        expect(metadata?.openrouter?.reasoning_details).toEqual(expect.arrayContaining([detail]))
      }
      expect(await result.text).toBe("Answer.")
      expect(requests).toBe(1)
    })
  })
}

test.each([
  { name: "native block IDs and indices", second: { id: "anthropic:msg_fixture:2", index: 2 } },
  { name: "distinct IDs at the same index", second: { id: "anthropic:msg_fixture:2", index: 0 } },
  { name: "distinct indices without IDs", second: { index: 2 } },
])("OpenRouter replays separate signed thinking blocks with $name", async ({ second }) => {
  const first = { ...(second.id ? { id: "anthropic:msg_fixture:0" } : {}), index: 0 }
  const details = [first, second].map((identity, index) => ({
    type: "reasoning.text",
    format: "anthropic-claude-v1",
    ...identity,
    text: index === 0 ? "First thought.  \n" : "Second thought.  \n",
    signature: index === 0 ? "offline-first-signature" : "offline-second-signature",
  }))
  const deltas = details.flatMap(({ text, signature, ...identity }) => [
    { reasoning_details: [{ ...identity, text: text.slice(0, 6) }] },
    { reasoning_details: [{ ...identity, text: text.slice(6) }] },
    { reasoning_details: [{ ...identity, signature }] },
    { content: "Progress. " },
  ])
  const requests: Array<{ messages: Array<{ role: string; reasoning_details?: Array<Record<string, unknown>> }> }> = []
  const provider = createOpenRouter({
    apiKey: "offline-fixture",
    fetch: Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        requests.push(JSON.parse(String(init?.body)))
        const first = requests.length === 1
        const chunks = first
          ? [
              ...deltas,
              {
                tool_calls: [
                  { index: 0, id: "call_fixture", type: "function", function: { name: "check", arguments: "" } },
                ],
              },
              { tool_calls: [{ index: 0, function: { arguments: "{}" } }] },
              {},
            ]
          : [{ content: "Answer." }, {}]
        return new Response(
          chunks
            .map((delta, index) => {
              const chunk = {
                id: first ? "msg_fixture" : "msg_continuation",
                object: "chat.completion.chunk",
                created: 1,
                model: "anthropic/claude-sonnet-5",
                choices: [
                  {
                    index: 0,
                    delta,
                    finish_reason: index === chunks.length - 1 ? (first ? "tool_calls" : "stop") : null,
                  },
                ],
              }
              return `data: ${JSON.stringify(chunk)}\n\n`
            })
            .join("") + "data: [DONE]\n\n",
          { headers: { "content-type": "text/event-stream" } },
        )
      },
      {
        preconnect() {
          throw new Error("Offline fixture must not open a connection")
        },
      },
    ),
  })
  const result = streamText({
    model: provider.chat("anthropic/claude-sonnet-5"),
    prompt: "Read the offline fixture.",
    tools: { check: tool({ inputSchema: z.object({}), execute: async () => "checked" }) },
    stopWhen: stepCountIs(2),
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(2_000),
  })

  expect(await result.text).toBe("Answer.")
  const metadata: unknown = (await result.steps)[0].providerMetadata?.openrouter?.reasoning_details
  expect(metadata).toEqual(details)
  expect(requests).toHaveLength(2)
  const replay = requests[1].messages.find((message) => message.role === "assistant")?.reasoning_details
  // Atlas replays the signed records carried by tool calls; incomplete display
  // deltas have no signature and cannot replace either authenticated block.
  expect(replay?.filter((detail) => typeof detail.signature === "string")).toEqual(details)
})

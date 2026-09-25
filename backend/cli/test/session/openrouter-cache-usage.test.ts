import { describe, expect, test } from "bun:test"
import { createRequire } from "node:module"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { generateText, streamText } from "ai"
import { TokenUsage } from "@synsci/util/token-usage"
import type { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"

const cjs = createRequire(import.meta.url)(
  "@openrouter/ai-sdk-provider",
) as typeof import("@openrouter/ai-sdk-provider")
const model = {
  providerID: "openrouter",
  api: { id: "anthropic/claude-opus-5.5" },
  cost: { input: 4, output: 20, cache: { read: 0.4, write: 5 } },
} as Provider.Model
const cases: Array<{
  name: string
  input: number
  output: number
  plain: number
  read: number
  write: number
  details?: Record<string, number>
  cost?: number
  charged?: number
}> = [
  {
    name: "Claude cache creation receipt",
    input: 20_994,
    output: 19,
    plain: 4,
    read: 0,
    write: 20_990,
    details: { cached_tokens: 0, cache_write_tokens: 20_990, cache_write_5m_tokens: 20_990, cache_write_1h_tokens: 0 },
    cost: 0.105346,
    charged: 0.111141,
  },
  {
    name: "mixed cached reads and 5m/1h writes",
    input: 1_000,
    output: 20,
    plain: 300,
    read: 200,
    write: 500,
    details: { cached_tokens: 200, cache_write_tokens: 500, cache_write_5m_tokens: 400, cache_write_1h_tokens: 100 },
    cost: 0.004321,
    charged: 0.004559,
  },
  {
    name: "write detail without a cached-read field",
    input: 1_000,
    output: 20,
    plain: 500,
    read: 0,
    write: 500,
    details: { cache_write_tokens: 500 },
    cost: 0,
    charged: 0,
  },
  {
    name: "receipt without cache details",
    input: 1_000,
    output: 20,
    plain: 1_000,
    read: 0,
    write: 0,
    cost: 0.01,
    charged: 0.01055,
  },
  {
    name: "catalog fallback with explicit cache writes",
    input: 1_000,
    output: 20,
    plain: 300,
    read: 200,
    write: 500,
    details: { cached_tokens: 200, cache_write_tokens: 500 },
  },
]

for (const [format, create] of [
  ["ESM", createOpenRouter],
  ["CJS", cjs.createOpenRouter],
] as const) {
  for (const mode of ["stream", "buffered"] as const) {
    describe(`OpenRouter ${format} ${mode} cache accounting`, () => {
      test.each(cases)("preserves $name through the SDK and Session.getUsage", async (fixture) => {
        const wire = {
          prompt_tokens: fixture.input,
          completion_tokens: fixture.output,
          total_tokens: fixture.input + fixture.output,
          prompt_tokens_details: fixture.details,
          completion_tokens_details: { reasoning_tokens: 7 },
          ...(fixture.cost !== undefined ? { cost: fixture.cost } : {}),
        }
        let requests = 0
        const provider = create({
          apiKey: "offline-fixture",
          fetch: Object.assign(
            async () => {
              requests++
              const common = { id: "chatcmpl-cache-fixture", created: 1, model: model.api.id }
              if (mode === "buffered") {
                return Response.json({
                  ...common,
                  object: "chat.completion",
                  choices: [{ index: 0, message: { role: "assistant", content: "ACE_OK" }, finish_reason: "stop" }],
                  usage: wire,
                })
              }
              const frames = [
                {
                  ...common,
                  choices: [{ index: 0, delta: { role: "assistant", content: "ACE_OK" }, finish_reason: null }],
                },
                { ...common, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: wire },
              ]
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
        const options = { model: provider.chat(model.api.id), prompt: "Read the offline receipt.", maxRetries: 0 }
        const result = mode === "stream" ? streamText(options) : await generateText(options)
        expect(await result.text).toBe("ACE_OK")
        const usage = await result.usage
        const metadata = await result.providerMetadata
        expect(usage.inputTokens).toBe(fixture.input)
        expect(usage.outputTokens).toBe(fixture.output)
        expect(usage.totalTokens).toBe(fixture.input + fixture.output)
        if (fixture.details) {
          expect(metadata?.openrouter?.usage).toMatchObject({
            promptTokensDetails: {
              cachedTokens: fixture.read,
              cacheWriteTokens: fixture.write,
              ...(fixture.details.cache_write_5m_tokens !== undefined
                ? {
                    cacheWrite5mTokens: fixture.details.cache_write_5m_tokens,
                    cacheWrite1hTokens: fixture.details.cache_write_1h_tokens,
                  }
                : {}),
            },
          })
        }
        const recorded = Session.getUsage({ model, usage, metadata, fundingFeeBps: 550 })
        expect(recorded.tokens).toEqual({
          input: fixture.plain,
          output: fixture.output,
          reasoning: 7,
          cache: { read: fixture.read, write: fixture.write },
        })
        expect(TokenUsage.total(recorded.tokens)).toBe(fixture.input + fixture.output)
        const cost =
          fixture.cost === undefined
            ? (fixture.plain * 4 + fixture.output * 20 + fixture.read * 0.4 + fixture.write * 5) / 1_000_000
            : fixture.charged!
        expect(recorded.cost).toBeCloseTo(cost, 12)
        expect(requests).toBe(1)
      })
    })
  }
}

test("invalid gateway cache-write metadata cannot inflate the prompt total", () => {
  for (const cacheWriteTokens of [-1, 0.5, "500", null]) {
    const result = Session.getUsage({
      model,
      usage: { inputTokens: 1_000, outputTokens: 20, totalTokens: 1_020, cachedInputTokens: 200, reasoningTokens: 0 },
      metadata: { openrouter: { usage: { cost: 0.01, promptTokensDetails: { cacheWriteTokens } } } },
    })
    expect(result.tokens).toEqual({ input: 800, output: 20, reasoning: 0, cache: { read: 200, write: 0 } })
    expect(result.cost).toBe(0.01)
    expect(TokenUsage.total(result.tokens)).toBe(1_020)
  }
})

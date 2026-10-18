import { expect, test } from "bun:test"
import { createRequire } from "node:module"
import { createOpenAI } from "@ai-sdk/openai"
import { createAzure } from "@ai-sdk/azure"
import { generateText, streamText } from "ai"
import { createOpenaiCompatible } from "../../src/provider/sdk/openai-compatible/src"
import { UsageLogging } from "../../src/session/usage-logging"

const require = createRequire(import.meta.url)
const commonjs: typeof import("@ai-sdk/openai") = require("@ai-sdk/openai")

for (const adapter of ["openai", "commonjs", "azure", "compatible", "openai-codex"] as const) {
  for (const counter of [0, 17, null, undefined]) {
    test(`${adapter} Responses preserves cache writes ${String(counter)} through JSON and SSE`, async () => {
      using server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const body = (await request.json()) as { stream?: boolean }
          const response = {
            id: "resp_cache_fixture",
            object: "response",
            model: "gpt-fixture",
            created_at: 1,
            status: "completed",
            output: [],
            usage: {
              input_tokens: 33,
              output_tokens: 5,
              total_tokens: 38,
              input_tokens_details: {
                cached_tokens: 0,
                ...(counter === undefined ? {} : { cache_write_tokens: counter }),
              },
              output_tokens_details: { reasoning_tokens: 0 },
            },
          }
          if (!body.stream) return Response.json(response)
          return new Response(
            [
              {
                type: "response.created",
                response: { id: response.id, created_at: 1, model: response.model, object: "response" },
              },
              { type: "response.completed", response },
            ]
              .map((event) => `data: ${JSON.stringify(event)}\n\n`)
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          )
        },
      })
      const baseURL = server.url.toString()
      const model =
        adapter === "openai-codex"
          ? createOpenAI({ apiKey: "fixture", baseURL, name: "openai-codex" }).responses("gpt-fixture")
          : adapter === "openai"
            ? createOpenAI({ apiKey: "fixture", baseURL }).responses("gpt-fixture")
            : adapter === "commonjs"
              ? commonjs.createOpenAI({ apiKey: "fixture", baseURL }).responses("gpt-fixture")
              : adapter === "azure"
                ? createAzure({ apiKey: "fixture", baseURL }).responses("gpt-fixture")
                : createOpenaiCompatible({ name: "fixture", apiKey: "fixture", baseURL }).responses("gpt-fixture")
      const generated = await generateText({ model, prompt: "Fixture", maxRetries: 0 })
      const direct = UsageLogging.reported(generated.usage, generated.providerMetadata, adapter)
      expect(direct.usage.cache_creation_input_tokens).toBe(counter ?? null)
      const streamed = streamText({ model, prompt: "Fixture", maxRetries: 0 })
      await streamed.consumeStream()
      const evidence = UsageLogging.reported(await streamed.totalUsage, await streamed.providerMetadata, adapter)
      expect(evidence.usage).toEqual({
        input_tokens: 33,
        output_tokens: 5,
        total_tokens: 38,
        reasoning_tokens: 0,
        cached_input_tokens: 0,
        cache_creation_input_tokens: counter ?? null,
      })
    })
  }
}

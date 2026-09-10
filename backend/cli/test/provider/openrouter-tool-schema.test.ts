import { expect, test } from "bun:test"
import z from "zod"
import type { JSONSchema7 } from "@ai-sdk/provider"
import { Provider } from "../../src/provider/provider"
import { ResearchSearchParameters } from "../../src/tool/research-search"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"

test("the actual OpenRouter SDK sends optional tool inputs without implicit strict mode", async () => {
  const requests: Record<string, unknown>[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests.push(await request.json())
      return Response.json({
        id: "fixture",
        model: "openai/gpt-5.6-sol",
        created: 1,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "done" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      })
    },
  })
  await using tmp = await tmpdir({
    config: {
      provider: {
        router: {
          npm: "@openrouter/ai-sdk-provider",
          options: { apiKey: "test-only", baseURL: `${server.url.origin}/v1` },
          models: { "openai/gpt-5.6-sol": { name: "fixture", limit: { context: 10000, output: 1000 } } },
        },
      },
    },
  })
  try {
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const language = await Provider.getLanguage(await Provider.getModel("router", "openai/gpt-5.6-sol"))
        const schema = z.toJSONSchema(ResearchSearchParameters, { io: "input" })
        await language.doGenerate({
          prompt: [{ role: "user", content: [{ type: "text", text: "Find the original paper without date filters" }] }],
          tools: [{ type: "function", name: "research_search", inputSchema: schema as JSONSchema7 }],
        })
        expect(requests).toHaveLength(1)
        expect(requests[0].tools).toEqual([
          { type: "function", function: { name: "research_search", parameters: schema, strict: false } },
        ])
        expect(ResearchSearchParameters.parse({ query: "Benjamini Hochberg" }).published_after).toBeUndefined()
        expect(ResearchSearchParameters.safeParse({ query: "paper", published_after: "" }).success).toBe(false)
        expect(ResearchSearchParameters.safeParse({ published_after: "2026-01-01" }).success).toBe(false)
      },
    })
  } finally {
    server.stop(true)
  }
})

test("strict adaptation preserves explicit policy, other models and provider tools", () => {
  const tools = [
    true,
    { type: "web_search" },
    { type: "function", function: { name: "custom", strict: true } },
    { type: "function", function: { name: "custom", strict: false } },
  ]
  expect(Provider.normalizeOpenRouterRequestBody({ model: "openai/gpt-5.6-sol", tools }).tools).toEqual(tools)
  for (const model of ["anthropic/claude-sonnet-5", "deepseek/deepseek-v4", "custom"]) {
    const input = { model, tools: [{ type: "function", function: { name: "custom" } }] }
    expect(Provider.normalizeOpenRouterRequestBody(input)).toBe(input)
  }
})

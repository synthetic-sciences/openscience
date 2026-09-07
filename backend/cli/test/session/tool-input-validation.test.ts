import { describe, expect, test } from "bun:test"
import z from "zod"
import type { Provider } from "../../src/provider/provider"
import { SessionPrompt } from "../../src/session/prompt"
import { normalizeBashInput } from "../../src/tool/bash"
import { WebFetchTool } from "../../src/tool/webfetch"
import { ReadTool } from "../../src/tool/read"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import { generateText, tool } from "ai"

const model = {
  id: "provider-boundary-test",
  providerID: "openrouter",
  api: {
    id: "provider-boundary-test",
    url: "https://example.com",
    npm: "@openrouter/ai-sdk-provider",
  },
} as Provider.Model

describe("SessionPrompt.toolInputSchema", () => {
  const schema = SessionPrompt.toolInputSchema(model, {
    id: "bash",
    parameters: z.object({
      command: z.string().trim().min(1),
      description: z.string(),
    }),
    normalizeInput: normalizeBashInput,
  })

  test("rejects the empty object emitted by an interrupted provider tool call", async () => {
    const result = await schema.validate?.({})
    expect(result?.success).toBe(false)
    if (!result || result.success) throw new Error("Incomplete Bash input unexpectedly passed validation")
    expect(result.error.message).toContain("No action was taken")
  })

  test("returns canonical input to the AI SDK before execute", async () => {
    const result = await schema.validate?.({ cmd: "pwd" })
    expect(result).toEqual({
      success: true,
      value: {
        command: "pwd",
        description: "Run pwd",
      },
    })
  })

  test("advertises accepted input rather than required defaulted output fields", async () => {
    const input = SessionPrompt.toolInputSchema(model, {
      id: "fixture",
      parameters: z.object({
        source: z.string(),
        count: z.number().int().positive().default(3),
        mode: z.enum(["fast", "complete"]).default("fast"),
        nested: z.object({ enabled: z.boolean().default(true) }).optional(),
      }),
    })
    expect(input.jsonSchema.required).toEqual(["source"])
    expect(input.jsonSchema.properties?.nested).toMatchObject({ properties: { enabled: { default: true } } })
    expect(input.jsonSchema.properties?.nested).not.toHaveProperty("required")
    expect(await input.validate?.({ source: "fixture", nested: {} })).toEqual({
      success: true,
      value: { source: "fixture", count: 3, mode: "fast", nested: { enabled: true } },
    })
  })

  test("OpenRouter serializes optional WebFetch fields without forcing download mode", async () => {
    const captured: Array<{
      model: string
      tools: Array<{ function: { name: string; parameters: Record<string, unknown>; strict?: boolean } }>
    }> = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        captured.push(await request.json())
        return Response.json({
          id: "chatcmpl-local-schema",
          object: "chat.completion",
          created: 1,
          model: "openai/gpt-5.6-sol",
          choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        })
      },
    })
    try {
      const webfetch = await WebFetchTool.init()
      const inputSchema = SessionPrompt.toolInputSchema(model, { id: "webfetch", ...webfetch })
      const sdk = createOpenRouter({ apiKey: "fixture-only", baseURL: server.url.href })
      await generateText({
        model: sdk.chat("openai/gpt-5.6-sol"),
        prompt: "Inspect the local fixture tool schema.",
        tools: { webfetch: tool({ description: webfetch.description, inputSchema }) },
        maxRetries: 0,
      })
      expect(captured).toHaveLength(1)
      expect(captured[0].model).toBe("openai/gpt-5.6-sol")
      const advertised = captured[0].tools[0].function
      expect(advertised.name).toBe("webfetch")
      expect(advertised.strict).not.toBe(true)
      expect(advertised.parameters.required).toEqual(["url"])
      expect(advertised.parameters.properties).toMatchObject({
        format: { default: "markdown" },
        output_path: { type: "string" },
        timeout: { type: "number" },
      })
      expect(await inputSchema.validate?.({ url: "https://example.com/article" })).toEqual({
        success: true,
        value: { url: "https://example.com/article", format: "markdown" },
      })
    } finally {
      await server.stop(true)
    }
  })

  test("keeps numeric provider hints for coerced Read inputs while accepting numeric strings", async () => {
    const read = await ReadTool.init()
    const input = SessionPrompt.toolInputSchema(model, { id: "read", ...read })
    expect(input.jsonSchema.required).toEqual(["filePath"])
    expect(input.jsonSchema.properties?.offset).toMatchObject({ type: "integer", minimum: 0 })
    expect(input.jsonSchema.properties?.limit).toMatchObject({ type: "integer", minimum: 0, maximum: 10_000 })
    expect(await input.validate?.({ filePath: "fixture.txt", offset: "2", limit: "3" })).toEqual({
      success: true,
      value: { filePath: "fixture.txt", offset: 2, limit: 3 },
    })
  })
})

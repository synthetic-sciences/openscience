import { describe, expect, test } from "bun:test"
import z from "zod"
import type { Provider } from "../../src/provider/provider"
import { SessionPrompt } from "../../src/session/prompt"
import { normalizeBashInput } from "../../src/tool/bash"

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
})

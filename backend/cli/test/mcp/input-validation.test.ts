import { describe, expect, test } from "bun:test"
import { MCP } from "../../src/mcp"

describe("MCP input validation", () => {
  const schema = MCP.inputSchema("lookup", {
    type: "object",
    properties: {
      query: { type: "string" },
    },
    required: ["query"],
    additionalProperties: false,
  })

  test("rejects interrupted provider calls before remote execution", async () => {
    const result = await schema.validate?.({})
    expect(result?.success).toBe(false)
    if (!result || result.success) throw new Error("Incomplete MCP input unexpectedly passed validation")
    expect(result.error.message).toBe(
      "The lookup MCP tool received invalid arguments or incomplete input. No action was taken. Retry with all required fields.",
    )
  })

  test("accepts input matching the published MCP schema", async () => {
    expect(await schema.validate?.({ query: "CERBench" })).toEqual({
      success: true,
      value: { query: "CERBench" },
    })
  })
})

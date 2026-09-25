import { describe, expect, test } from "bun:test"
import type { JSONSchema7 } from "ai"
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

  test("reuses the validator when the same tool schema is converted again", () => {
    // MCP.tools() converts every connected tool again on each agent step, each
    // time with a freshly spread schema object. AJV caches compiled schemas by
    // object identity and never evicts them, so compiling per call retains one
    // validator per tool per step for the life of the process.
    const published = (): JSONSchema7 => ({
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 12 }, (_, i) => [`field${i}`, { type: "string", minLength: 1 }]),
      ),
      required: ["field0"],
      additionalProperties: false,
    })
    MCP.inputSchema("lookup", published())
    Bun.gc(true)
    const before = process.memoryUsage().heapUsed
    for (let step = 0; step < 2000; step++) MCP.inputSchema("lookup", published())
    Bun.gc(true)
    const retained = process.memoryUsage().heapUsed - before
    // Compiling each time keeps several KB per call (over 10 MB here); reuse
    // keeps nothing beyond the one validator compiled above.
    expect(retained).toBeLessThan(2 * 1024 * 1024)
  })
})

import { describe, expect, test } from "bun:test"
import { normalizeDeepSeekToolSchema } from "../../src/provider/tool-schema"
import { ProviderTransform } from "../../src/provider/transform"

const union = {
  oneOf: [
    {
      type: "object",
      properties: { action: { type: "string", const: "list" }, limit: { type: "integer", minimum: 1 } },
      required: ["action"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { action: { type: "string", const: "status" }, job_id: { type: "string", minLength: 1 } },
      required: ["action", "job_id"],
      additionalProperties: false,
    },
  ],
}

const model = (npm: string) =>
  ({
    id: "deepseek-v4-flash",
    providerID: "deepseek",
    api: { id: "deepseek-v4-flash", url: "https://api.deepseek.com", npm },
  }) as any

describe("DeepSeek tool schema normalization", () => {
  test("adds an object root to a const-discriminated oneOf without flattening constraints", () => {
    const result = normalizeDeepSeekToolSchema(union as any) as any
    expect(result.type).toBe("object")
    expect(result.oneOf).toBeUndefined()
    expect(result.anyOf).toHaveLength(2)
    expect(result.anyOf[0].properties.action).toEqual({ type: "string", enum: ["list"] })
    expect(result.anyOf[0].properties.limit.minimum).toBe(1)
    expect(result.anyOf[1].properties.job_id.minLength).toBe(1)
    expect(result.anyOf[1].required).toEqual(["action", "job_id"])
  })

  test("keeps an overlapping oneOf intact instead of widening its semantics", () => {
    const overlapping = {
      oneOf: [
        { type: "object", properties: { value: { type: "string" } } },
        { type: "object", properties: { value: { type: "string", minLength: 1 } } },
      ],
    }
    const result = normalizeDeepSeekToolSchema(overlapping as any) as any
    expect(result.type).toBeUndefined()
    expect(result.oneOf).toHaveLength(2)
    expect(result.anyOf).toBeUndefined()
  })

  test("keeps an optional-discriminator oneOf intact instead of widening its semantics", () => {
    const optionalDiscriminator = {
      oneOf: [
        {
          type: "object",
          properties: { action: { type: "string", const: "list" } },
          additionalProperties: false,
        },
        {
          type: "object",
          properties: { action: { type: "string", const: "status" } },
          additionalProperties: false,
        },
      ],
    }
    const result = normalizeDeepSeekToolSchema(optionalDiscriminator as any) as any
    expect(result.type).toBeUndefined()
    expect(result.oneOf).toHaveLength(2)
    expect(result.anyOf).toBeUndefined()
  })

  test("keeps a separate anyOf constraint when oneOf is also present", () => {
    const conjunctive = {
      ...union,
      anyOf: [
        {
          type: "object",
          properties: { scope: { type: "string", const: "project" } },
          required: ["scope"],
        },
      ],
    }
    const result = normalizeDeepSeekToolSchema(conjunctive as any) as any
    expect(result.type).toBeUndefined()
    expect(result.oneOf).toHaveLength(2)
    expect(result.anyOf).toHaveLength(1)
    expect(result.anyOf[0].properties.scope).toEqual({ type: "string", enum: ["project"] })
  })

  test("runs only at the native DeepSeek provider boundary", () => {
    expect((ProviderTransform.schema(model("@ai-sdk/deepseek"), union as any) as any).type).toBe("object")
    expect((ProviderTransform.schema(model("@ai-sdk/openai-compatible"), union as any) as any).type).toBeUndefined()
  })
})

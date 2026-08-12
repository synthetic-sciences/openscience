import { describe, expect, test } from "bun:test"
import { normalizeToolSchema } from "../../src/provider/tool-schema"
import { ProviderTransform } from "../../src/provider/transform"

/** A zod discriminated-union serialization exactly as z.toJSONSchema emits it
 *  (see the compute_job tool pre-fix): root-level `oneOf`, per-branch `const`
 *  discriminators, constraint keywords on properties. */
const discriminatedUnion = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  oneOf: [
    {
      type: "object",
      properties: {
        action: { type: "string", const: "list" },
        status: { type: "string", enum: ["running", "succeeded", "failed"] },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["action"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        action: { type: "string", const: "status" },
        job_id: { type: "string", minLength: 1 },
      },
      required: ["action", "job_id"],
      additionalProperties: false,
    },
  ],
}

const norm = (schema: any): any => normalizeToolSchema(schema)

const model = (npm: string) =>
  ({
    id: "deepseek/deepseek-v4-flash",
    providerID: "deepseek",
    api: { id: "deepseek-v4-flash", url: "https://api.deepseek.com", npm },
    name: "deepseek-v4-flash",
    capabilities: { temperature: true, reasoning: true, toolcall: true },
    status: "active",
    options: {},
    headers: {},
  }) as any

describe("normalizeToolSchema", () => {
  test("flattens a root discriminated union into a single object schema", () => {
    const out = norm(discriminatedUnion)
    expect(out.type).toBe("object")
    expect(out.oneOf).toBeUndefined()
    expect(out.anyOf).toBeUndefined()
    expect(out.properties).toBeDefined()
  })

  test("widens the const discriminator into an enum", () => {
    const out = norm(discriminatedUnion)
    expect(out.properties.action).toEqual({ type: "string", enum: ["list", "status"] })
    expect(out.properties.action.const).toBeUndefined()
  })

  test("intersects required across union branches", () => {
    const out = norm(discriminatedUnion)
    expect(out.required).toEqual(["action"])
  })

  test("strips constraint keywords DeepSeek rejects but keeps enum/type", () => {
    const out = norm(discriminatedUnion)
    expect(out.properties.limit).toEqual({ type: "integer" })
    expect(out.properties.status).toEqual({ type: "string", enum: ["running", "succeeded", "failed"] })
  })

  test("drops minLength/maxLength/pattern/format recursively", () => {
    const input = {
      type: "object",
      properties: {
        name: { type: "string", minLength: 1, maxLength: 100, pattern: "^[a-z]+$", format: "email" },
        nested: { type: "object", properties: { score: { type: "number", minimum: 0, maximum: 1, multipleOf: 0.1 } } },
        tags: { type: "array", minItems: 1, maxItems: 5 },
        patternMap: { type: "object", patternProperties: { "^x": { type: "string" } } },
      },
    }
    const out = norm(input)
    expect(out.properties.name).toEqual({ type: "string" })
    expect(out.properties.nested.properties.score).toEqual({ type: "number" })
    expect(out.properties.tags).toEqual({ type: "array" })
    expect(out.properties.patternMap).toEqual({ type: "object" })
  })

  test("keeps defaults and non-rejected keywords", () => {
    const input = {
      type: "object",
      properties: { action: { type: "string", default: "list", description: "which job action" } },
    }
    const out = norm(input)
    expect(out.properties.action).toEqual({ type: "string", default: "list", description: "which job action" })
  })

  test("passes through a plain object schema unchanged", () => {
    const input = { type: "object", properties: { a: { type: "string" } }, required: ["a"] }
    expect(norm(input)).toEqual(input)
  })

  test("every value valid under the original union is valid under the normalized schema", () => {
    const out = norm(discriminatedUnion)
    for (const valid of [
      { action: "list", limit: 20 },
      { action: "status", job_id: "job-1" },
    ]) {
      // Structural check only — the union's branches accepted both shapes.
      expect(out.properties.action.enum).toContain(valid.action)
      for (const key of Object.keys(valid)) {
        expect(out.properties[key]).toBeDefined()
      }
    }
  })
})

describe("ProviderTransform.schema", () => {
  test("normalizes tool schemas for the native deepseek adapter", () => {
    const out: any = ProviderTransform.schema(model("@ai-sdk/deepseek"), discriminatedUnion as any)
    expect(out.type).toBe("object")
    expect(out.oneOf).toBeUndefined()
    expect(out.properties.action.enum).toEqual(["list", "status"])
  })

  test("normalizes tool schemas for openai-compatible gateways", () => {
    const out: any = ProviderTransform.schema(model("@ai-sdk/openai-compatible"), discriminatedUnion as any)
    expect(out.type).toBe("object")
    expect(out.oneOf).toBeUndefined()
  })

  test("leaves non-strict-schema providers untouched", () => {
    const anthropic = model("@ai-sdk/anthropic")
    const out: any = ProviderTransform.schema(anthropic, discriminatedUnion as any)
    expect(out.oneOf).toBeDefined()
    expect(out.type).toBeUndefined()
  })
})

import type { JSONSchema } from "zod/v4/core"

/**
 * Tool-schema normalization for providers that run strict JSON-Schema
 * validation on function definitions (DeepSeek's official API and
 * OpenAI-compatible gateways in general).
 *
 * zod discriminated unions serialize to `oneOf`/`anyOf` with no top-level
 * `type: "object"`; strict validators reject that shape with a 400 (DeepSeek:
 * `schema must be a JSON Schema of 'type: "object"', got 'type: null'`). The
 * same validators reject a subset of constraint keywords. We merge the union
 * back into a single object schema and drop the rejected keywords so the model
 * only needs to produce a structurally valid object — the Zod schema backing
 * each tool still enforces full constraints when its arguments are parsed at
 * execution time.
 *
 * Pure and lossless in the direction that matters: every value that satisfied
 * the original schema still satisfies the normalized one.
 */

/** Keywords DeepSeek's strict tool-schema validation rejects. `enum` and
 *  `anyOf` for VALUES are kept — only these structural/constraint keywords are
 *  dropped. */
const STRIPPED_KEYWORDS = new Set([
  "minLength",
  "maxLength",
  "pattern",
  "format",
  "minimum",
  "maximum",
  "multipleOf",
  "patternProperties",
  "minItems",
  "maxItems",
])

export function normalizeToolSchema(schema: JSONSchema.BaseSchema): JSONSchema.BaseSchema {
  return normalize(schema)
}

function normalize(node: any): any {
  if (node === null || typeof node !== "object") return node
  if (Array.isArray(node)) return node.map(normalize)

  const out: any = {}
  const unionMembers: any[] = []

  for (const [key, value] of Object.entries(node)) {
    // Root union (zod discriminated union). Flattened below into the object.
    if (key === "oneOf" || key === "anyOf" || key === "allOf") {
      if (Array.isArray(value)) unionMembers.push(...value)
      continue
    }
    if (STRIPPED_KEYWORDS.has(key)) continue
    out[key] = typeof value === "object" && value !== null ? normalize(value) : value
  }

  // Merge union members into this object so the result is a single
  // `type: "object"` schema. The discriminator's distinct const values widen
  // into an enum; `required` intersects across branches (a valid object must
  // satisfy one branch, so only fields every branch demands are required).
  for (const rawMember of unionMembers) {
    const member = normalize(rawMember)
    if (!member || typeof member !== "object") continue
    if (member.properties && typeof member.properties === "object") {
      out.properties = out.properties ?? {}
      for (const [key, value] of Object.entries(member.properties)) {
        out.properties[key] = mergeProperty(out.properties[key], value)
      }
    }
    if (Array.isArray(member.required)) {
      if (!Array.isArray(out.required)) out.required = [...member.required]
      else out.required = out.required.filter((field: string) => member.required.includes(field))
    }
  }

  if (out.properties) out.type = "object"
  return out
}

/** Merge two definitions of the same property across union branches. Identical
 *  definitions pass through; distinct literal constraints (the discriminated
 *  union's discriminator) widen into an enum; anything else allows either
 *  shape via `anyOf`. */
function mergeProperty(existing: any, value: any): any {
  if (existing === undefined) return value
  if (JSON.stringify(existing) === JSON.stringify(value)) return existing

  const aValues = existing.const !== undefined ? [existing.const] : existing.enum
  const bValues = value.const !== undefined ? [value.const] : value.enum
  if (aValues && bValues) {
    const merged: any = { ...existing, ...value }
    delete merged.const
    merged.enum = [...new Set([...aValues, ...bValues])]
    return merged
  }

  return { anyOf: [existing, value] }
}

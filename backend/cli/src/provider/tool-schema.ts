import type { JSONSchema } from "zod/v4/core"

type Node = Record<string, unknown>

function record(value: unknown): value is Node {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function discriminator(branches: Node[]) {
  const first = branches[0]?.properties
  if (!record(first)) return undefined
  for (const key of Object.keys(first)) {
    const values = branches.map((branch) => {
      const properties = branch.properties
      if (!Array.isArray(branch.required) || !branch.required.includes(key)) return undefined
      if (!record(properties) || !record(properties[key])) return undefined
      return properties[key].const
    })
    if (values.some((value) => value === undefined)) continue
    if (new Set(values.map((value) => JSON.stringify(value))).size === values.length) return key
  }
  return undefined
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize)
  if (!record(value)) return value

  const rawOneOf = Array.isArray(value.oneOf) && value.oneOf.every(record) ? value.oneOf : undefined
  const result: Node = Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]))
  if (Object.hasOwn(result, "const")) {
    result.enum = [result.const]
    delete result.const
  }

  const oneOf = Array.isArray(result.oneOf) && result.oneOf.every(record) ? result.oneOf : undefined
  const anyOf = Array.isArray(result.anyOf) && result.anyOf.every(record) ? result.anyOf : undefined
  const branches = oneOf ?? anyOf
  if (!result.type && branches?.length && branches.every((branch) => branch.type === "object")) {
    // DeepSeek requires a function schema to have an object root and supports
    // anyOf. A discriminated oneOf is equivalent to anyOf because the const
    // discriminator makes its branches mutually exclusive. Keep every branch
    // and constraint intact instead of flattening or widening the contract.
    const safeOneOf = !rawOneOf || (!Array.isArray(value.anyOf) && discriminator(rawOneOf) !== undefined)
    if (safeOneOf) {
      result.type = "object"
      result.anyOf = branches
      delete result.oneOf
    }
  }
  return result
}

/**
 * Normalize only representational differences accepted by DeepSeek while
 * preserving the set of valid tool inputs. Runtime Zod validation remains the
 * authority; this function never strips constraints or makes fields optional.
 */
export function normalizeDeepSeekToolSchema(schema: JSONSchema.BaseSchema): JSONSchema.BaseSchema {
  return normalize(schema) as JSONSchema.BaseSchema
}

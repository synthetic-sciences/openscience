import { OpenScience } from "@/openscience"

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
const maxBytes = 512 * 1024

/** Bound hostile tool data before recursively redacting it. Binary attachments
 * retain their type and size; trace logging never opens referenced files. */
export async function tracePayload(value: Record<string, unknown>): Promise<Record<string, Json>> {
  const seen = new WeakSet<object>()
  const budget = { remaining: 20_000, bytes: maxBytes }
  const text = (value: string) => {
    if (/^data:[^,]*;base64,/i.test(value)) return "[binary data URL omitted]"
    const redacted = OpenScience.redactSecrets(value)
      .replace(/\b((?:https?|postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis(?:s)?):\/\/)[^@\s/]+@/gi, "$1[REDACTED]@")
      .replace(/(\b(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key)\s*:\s*)[^\r\n]+/gi, "$1[REDACTED]")
    const available = Math.min(128 * 1024, budget.bytes)
    const bytes = new TextEncoder().encode(redacted)
    budget.bytes = Math.max(0, budget.bytes - Math.min(bytes.length, available))
    return bytes.length > available ? new TextDecoder().decode(bytes.slice(0, available)) + "… [truncated]" : redacted
  }
  const visit = (item: unknown, depth = 0): Json => {
    if (--budget.remaining < 0 || budget.bytes <= 0 || depth > 24) return "[truncated]"
    if (item === null || item === undefined) return null
    if (typeof item === "string") return text(item)
    if (typeof item === "number") return Number.isFinite(item) ? item : null
    if (typeof item === "boolean") return item
    if (typeof item !== "object") return text(String(item))
    if (item instanceof Uint8Array || item instanceof ArrayBuffer)
      return { type: "binary", byte_length: item.byteLength }
    if (item instanceof URL) return text(item.href)
    if (item instanceof Date) return item.toISOString()
    if (item instanceof Error) return visit({ name: item.name, message: item.message }, depth + 1)
    if (seen.has(item)) return "[circular]"
    seen.add(item)
    if (Array.isArray(item)) {
      const result: Json[] = []
      for (const child of item.slice(0, 512)) {
        if (budget.remaining <= 0 || budget.bytes <= 0) break
        result.push(visit(child, depth + 1))
      }
      if (result.length < item.length) result.push("[truncated]")
      seen.delete(item)
      return result
    }
    const result: Record<string, Json> = Object.create(null)
    const keys = Object.keys(item)
    for (const key of keys.slice(0, 512)) {
      if (budget.remaining <= 0 || budget.bytes <= 0) {
        result._truncated = true
        break
      }
      result[text(key)] = visit((item as Record<string, unknown>)[key], depth + 1)
    }
    if (keys.length > 512) result._truncated = true
    seen.delete(item)
    return result
  }
  await OpenScience.refreshByokSecrets()
  const payload = OpenScience.redactSensitive(visit(value)) as Record<string, Json>
  if (Buffer.byteLength(JSON.stringify(payload)) <= maxBytes) return payload
  return { _truncated: true, preview: text(JSON.stringify(payload).slice(0, 64 * 1024)) }
}

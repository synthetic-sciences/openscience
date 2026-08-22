export namespace InvalidCall {
  export const failures = ["invalid_input", "unknown_tool"] as const
  export type Failure = (typeof failures)[number]

  export class RepeatedError extends Error {
    constructor(readonly tool: string) {
      super(`OpenScience stopped two repeated incomplete ${tool} calls before execution. No action was taken.`)
      this.name = "RepeatedMalformedToolCallError"
    }
  }

  export function tool(value: unknown) {
    if (typeof value !== "string") return "tool"
    const normalized = value.trim().toLowerCase()
    if (!/^[a-z0-9_-]{1,64}$/.test(normalized)) return "tool"
    return normalized
  }

  export function failure(value: unknown): Failure {
    return value === "unknown_tool" ? "unknown_tool" : "invalid_input"
  }

  export function message(name: string, reason: Failure) {
    const source = tool(name)
    if (reason === "unknown_tool") {
      return `OpenScience caught a call to unavailable tool ${source}. No action was taken.`
    }
    return `OpenScience caught an incomplete ${source} call before execution. No action was taken.`
  }

  export function payload(name: string, reason: Failure) {
    const source = tool(name)
    return {
      tool: source,
      failure: reason,
      error: message(source, reason),
    }
  }

  export function signature(value: unknown) {
    const input = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
    return `${tool(input.tool)}:${failure(input.failure)}`
  }
}

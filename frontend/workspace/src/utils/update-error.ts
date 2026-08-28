function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

export function updateError(value: unknown, status: number) {
  if (!record(value)) return `Update install failed (${status})`
  const data = record(value.data) ? value.data : undefined
  const detail = [value.error, value.message, data?.message].find((item) => typeof item === "string")
  if (typeof detail !== "string") return `Update install failed (${status})`
  return detail.replace(/^Error:\s*/, "").split("\n", 1)[0]
}

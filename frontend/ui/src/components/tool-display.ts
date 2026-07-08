const titlecase = (s: string) =>
  s
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ")

// Known first-party MCP-style namespaces produce "ns · rest"; a bare id titlecases.
export function humanizeToolName(tool: string): string {
  const parts = tool.split("_")
  if (parts.length > 2) {
    const ns = parts[0]
    const rest = parts.slice(1).join(" ")
    return `${ns} · ${rest}`
  }
  return titlecase(tool)
}

export function skillName(source: {
  metadata?: Record<string, unknown>
  input?: Record<string, unknown>
  title?: string
}): string {
  const meta = source.metadata?.name
  if (typeof meta === "string" && meta) return meta
  const input = source.input?.name
  if (typeof input === "string" && input) return input
  const title = source.title
  if (typeof title === "string" && title.startsWith("Loaded skill: ")) return title.slice("Loaded skill: ".length)
  return "skill"
}

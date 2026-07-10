const titlecase = (s: string) =>
  s
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ")

// There's no reliable signal to distinguish a first-party multi-word tool id
// (e.g. "science_list_dbs") from an MCP "namespace_tool" id, so titlecase both.
export function humanizeToolName(tool: string): string {
  return titlecase(tool)
}

// OpenRouter (and some providers) return encrypted reasoning as a "[REDACTED]"
// placeholder appended to — or standing in for — the readable summary; the real
// payload is the encrypted blob carried in the part's metadata for model
// continuity, never meant for display. Strip the placeholder from reasoning text.
// (Tool output keeps its own "[REDACTED]" secret masking; this is reasoning-only.)
export function stripRedactedReasoning(text: string): string {
  return (text ?? "").replaceAll("[REDACTED]", "").trim()
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

import type { Part, ToolPart } from "@synsci/sdk/v2/client"

export type LiveActivity = {
  /** "Reading study.json", "Running pytest -q", "Thinking", "Writing". */
  label: string
  /** When this particular call or phase began, for its own clock. */
  since?: number
}

const VERB: Record<string, string> = {
  read: "Reading",
  glob: "Searching",
  grep: "Searching",
  list: "Listing",
  codesearch: "Searching",
  lsp: "Inspecting",
  webfetch: "Fetching",
  websearch: "Searching",
  research_search: "Searching",
  literature: "Reading literature",
  science_search: "Querying",
  science_fetch: "Fetching",
  science_list_dbs: "Listing databases",
  edit: "Editing",
  write: "Writing",
  apply_patch: "Editing",
  notebook: "Editing notebook",
  bash: "Running",
  python: "Running Python",
  r: "Running R",
  rkernel: "Running R",
  compute_job: "Running job",
  modal: "Running job",
  provider_compute: "Running job",
  remote_compute: "Running job",
  task: "Delegating",
  todowrite: "Planning",
  question: "Asking",
  skill: "Loading skill",
  artifact: "Saving",
  recall: "Recalling",
  experiments: "Tracking experiments",
  study: "Running study",
  generate_image: "Generating image",
}

function firstLine(value: string, max = 72) {
  const line = value.split("\n").find((item) => item.trim()) ?? ""
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function basename(value: string) {
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value
}

/** What a running call is doing, in the words the trace rows use: the title
 * the tool recorded, else the most telling argument it was called with. */
export function toolDetail(part: ToolPart): string {
  const state = part.state
  const title = "title" in state ? state.title?.trim() : undefined
  if (title) return firstLine(title)
  const input = (state.input ?? {}) as Record<string, unknown>
  for (const key of ["filePath", "path", "file"]) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return basename(value)
  }
  for (const key of ["description", "command", "pattern", "query", "url", "name", "prompt"]) {
    const value = input[key]
    if (typeof value === "string" && value.trim()) return firstLine(value.trim())
  }
  return ""
}

/**
 * The newest thing the turn is doing right now, read from the parts of its
 * in-flight message: a running tool with its detail and start time, else a
 * reasoning or text part that has begun and not ended. `undefined` means the
 * request is still waiting on the provider.
 */
export function liveActivity(parts: readonly Part[]): LiveActivity | undefined {
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]
    if (!part) continue
    if (part.type === "tool") {
      if (part.state.status !== "running") continue
      const verb = VERB[part.tool] ?? `Using ${part.tool.replaceAll("_", " ")}`
      const detail = toolDetail(part)
      return { label: detail ? `${verb} ${detail}` : verb, since: part.state.time.start }
    }
    if (part.type === "reasoning") {
      if (part.time?.end || !part.time?.start) continue
      return { label: "Thinking", since: part.time.start }
    }
    if (part.type === "text") {
      if (part.time?.end || !part.time?.start || !part.text?.trim()) continue
      return { label: "Writing", since: part.time.start }
    }
  }
  return undefined
}

const titlecase = (s: string) =>
  s
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ")

export function sentenceCaseLabel(value: string): string {
  const label = value.replace(/[\s_-]+/g, " ").trim()
  if (!label) return label
  return label[0].toLocaleUpperCase() + label.slice(1)
}

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

export type SavedArtifact = {
  title: string
  kind: string
  path: string
  id: string
  versionID: string
  mimeType?: string
  version: number
  size: number
  sha256: string
  preview?: { kind: "image" | "text"; data: string }
}

const record = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

export function savedArtifact(value: unknown): SavedArtifact | undefined {
  const item = record(value)
  if (
    !item ||
    typeof item.title !== "string" ||
    typeof item.kind !== "string" ||
    typeof item.path !== "string" ||
    typeof item.id !== "string" ||
    typeof item.versionID !== "string" ||
    typeof item.version !== "number" ||
    typeof item.size !== "number" ||
    typeof item.sha256 !== "string"
  )
    return
  const raw = record(item.preview)
  const kind = raw?.kind
  const preview: SavedArtifact["preview"] =
    raw && (kind === "image" || kind === "text") && typeof raw.data === "string" ? { kind, data: raw.data } : undefined
  return {
    title: item.title,
    kind: item.kind,
    path: item.path,
    id: item.id,
    versionID: item.versionID,
    ...(typeof item.mimeType === "string" ? { mimeType: item.mimeType } : {}),
    version: item.version,
    size: item.size,
    sha256: item.sha256,
    ...(preview ? { preview } : {}),
  }
}

export function generatedArtifacts(
  parts: ReadonlyArray<{
    type: string
    tool?: string
    state?: { status?: string; metadata?: unknown }
  }>,
): SavedArtifact[] {
  const seen = new Set<string>()
  return parts.flatMap((part) => {
    if (part.type !== "tool" || part.tool !== "artifact" || part.state?.status !== "completed") return []
    const metadata = record(part.state.metadata)
    const artifact = savedArtifact(metadata?.savedArtifact)
    if (!artifact || seen.has(artifact.versionID)) return []
    seen.add(artifact.versionID)
    return [artifact]
  })
}

const filename = (value: string) => value.replaceAll("\\", "/").split("/").pop() || value

/**
 * A stable receipt label for a scientific execution. Models can provide a
 * concrete action title; older calls fall back to conservative code-shape
 * labels instead of leaking an arbitrary first line such as an import.
 */
export function scienceTaskLabel(input: { title?: unknown; code?: unknown; language?: unknown }): string {
  if (typeof input.title === "string" && input.title.trim())
    return input.title
      .trim()
      .replace(/[.\s]+$/, "")
      .slice(0, 100)
  const code = typeof input.code === "string" ? input.code : ""
  const comment = code
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^#\s+\S/.test(line) && !/^#\s*(?:coding|type:|noqa|r)/i.test(line))
  if (comment)
    return comment
      .replace(/^#\s*/, "")
      .replace(/[.\s]+$/, "")
      .slice(0, 100)

  const read = code.match(/\b(?:read_csv|read_table|read_parquet|read_excel|readRDS|fread)\s*\(\s*[rubf]*["']([^"']+)/i)
  const write = code.match(
    /\b(?:to_csv|to_parquet|to_excel|savefig|ggsave|write_csv|write\.csv|saveRDS)\s*\(\s*[rubf]*["']([^"']+)/i,
  )
  if (/\b(?:savefig|ggsave)\s*\(/i.test(code))
    return write ? `Rendering ${filename(write[1])}` : "Rendering analysis figure"
  if (/\b(?:plt\.|sns\.|ggplot\s*\(|plot\s*\()/i.test(code)) return "Rendering analysis figure"
  if (/\b(?:cross_val|GridSearch|RandomForest|LogisticRegression|\.fit\s*\(|model\.train\s*\()/i.test(code)) {
    return "Fitting statistical models"
  }
  if (/\b(?:groupby|describe\s*\(|crosstab|summary\s*\(|aggregate\s*\()/i.test(code)) return "Summarizing dataset"
  if (read) return `Loading ${filename(read[1])}`
  if (write) return `Saving ${filename(write[1])}`
  return `${input.language === "r" ? "R" : "Python"} execution`
}

/**
 * Files a turn actually wrote, from its completed tool parts. write/edit/
 * multiedit carry the target in input.filePath; apply_patch lists every
 * changed file (with moves resolved and deletes skipped) in its completed
 * metadata. Python and R tools take only code — kernel-side writes carry no
 * path in the part — so it is deliberately not guessed at here.
 */
export function writtenFiles(
  parts: ReadonlyArray<{
    type: string
    tool?: string
    state?: { status?: string; input?: unknown; metadata?: unknown }
  }>,
): string[] {
  const files: string[] = []
  const seen = new Set<string>()
  const push = (value: unknown) => {
    if (typeof value !== "string" || !value || seen.has(value)) return
    seen.add(value)
    files.push(value)
  }
  for (const part of parts) {
    if (part.type !== "tool" || part.state?.status !== "completed") continue
    const input = (part.state.input ?? {}) as Record<string, unknown>
    if (part.tool === "write" || part.tool === "edit" || part.tool === "multiedit") push(input.filePath)
    if (part.tool !== "apply_patch") continue
    const metadata = (part.state.metadata ?? {}) as Record<string, unknown>
    const changes = Array.isArray(metadata.files) ? metadata.files : []
    for (const change of changes) {
      if (!change || typeof change !== "object") continue
      const record = change as Record<string, unknown>
      if (record.type === "delete") continue
      push(record.movePath ?? record.filePath)
    }
  }
  return files
}

/**
 * End-of-turn "Save as artifact" affordance: a single written file gets the
 * bare action, several written files get one labeled action per path.
 */
export function artifactActions(files: readonly string[]): Array<{ path: string; label: string }> {
  if (files.length === 1) return [{ path: files[0], label: "Save as Result…" }]
  return files.map((file) => ({
    path: file,
    label: `Save as Result… ${file.split("/").pop() || file}`,
  }))
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

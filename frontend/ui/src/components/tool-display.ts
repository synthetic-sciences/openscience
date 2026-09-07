import type { UiI18nKey, UiI18nParams } from "../context/i18n"

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
  const visible = (text ?? "").replaceAll("[REDACTED]", "")
  return visible.trim() ? visible : ""
}

const reasoningHeading = /^[\p{L}\p{N} ,'/()_&:–—-]+$/u
const reasoningStatus =
  /^(?:planning|preparing|retrieving|exploring|inspecting|testing|verifying|checking|reviewing|analyzing|evaluating|designing|building|running|confirming|adjusting|patching|restarting|summarizing|finalizing|thinking|considering next steps)$/i

/** Display-only heading cleanup; the persisted provider text is never changed. */
export function reasoningDisplayText(text: string): string {
  const visible = stripRedactedReasoning(text)
  if (!visible || reasoningStatus.test(visible.trim())) return ""
  if (!visible.includes("**")) return visible

  // Do not interpret heading-like text inside code or math, including an
  // unfinished literal arriving over the stream. This deliberately errs on the
  // side of retaining labels rather than deleting potentially meaningful text.
  const literals: { start: number; end: number }[] = []
  const delimiters = /^ {0,3}(`{3,}|~{3,})[^\r\n]*(?:\r?\n|$)|`+|(?<!\\)\${1,2}|\\[[(]|<(pre|code)\b[^>]*>|<!--/gim
  for (const match of visible.matchAll(delimiters)) {
    if ((literals.at(-1)?.end ?? -1) > match.index) continue
    const delimiter = match[1] ?? match[0]
    const start = match.index + match[0].length
    const closing = match[1]
      ? new RegExp(`^ {0,3}${delimiter[0]}{${delimiter.length},}[ \\t]*(?:\\r?\\n|$)`, "gm")
      : match[2]
        ? new RegExp(`</${match[2]}\\s*>`, "gi")
        : delimiter.startsWith("`")
          ? new RegExp("(?<!`)`{" + delimiter.length + "}(?!`)", "g")
          : delimiter.startsWith("$")
            ? new RegExp("(?<!\\\\)\\${" + delimiter.length + "}", "g")
            : undefined
    if (closing) closing.lastIndex = start
    const ending = delimiter === "\\[" ? "\\]" : delimiter === "\\(" ? "\\)" : delimiter === "<!--" ? "-->" : delimiter
    const end = closing ? closing.exec(visible) : undefined
    const index = closing ? (end?.index ?? -1) : visible.indexOf(ending, start)
    literals.push({ start: match.index, end: index < 0 ? visible.length : index + (end?.[0].length ?? ending.length) })
  }

  const headings = /(^ {0,3}|[.!?])\*\*([^*\r\n]+)\*\*[ \t]*\r?\n(?:[ \t]*\r?\n)*/gm
  const end = visible.trimEnd().length
  return visible.replace(headings, (match: string, prefix: string, label: string, offset: number) => {
    if (
      label.length > 100 ||
      label.trim().split(/\s+/).length > 12 ||
      !reasoningHeading.test(label.trim()) ||
      offset + match.length >= end ||
      /^(?: {4}|\t)/.test(visible.slice(visible.lastIndexOf("\n", offset - 1) + 1, offset)) ||
      literals.some((literal) => offset >= literal.start && offset < literal.end)
    ) {
      return match
    }
    // A bridge can concatenate phases (`...done.**Checking sources**\n...`).
    // Keep every prose character and insert only the missing paragraph break.
    const newline = match.includes("\r\n") ? "\r\n" : "\n"
    if (prefix.trim()) return prefix + newline + newline
    if (!offset || visible.slice(0, offset).endsWith(newline + newline)) return ""
    return newline
  })
}

export type ToolOutcome = "pending" | "running" | "done" | "error" | "cancelled"

/** Where a call is in its life. An abort is a cancellation, not a failure of the tool. */
export function toolOutcome(status: string | undefined, error?: string, exit?: unknown): ToolOutcome {
  if (status === "completed") return typeof exit === "number" && exit !== 0 ? "error" : "done"
  if (status === "error") return /\b(?:aborted|cancel+ed)\b/i.test(error ?? "") ? "cancelled" : "error"
  if (status === "running") return "running"
  return "pending"
}

const running: Record<string, UiI18nKey> = {
  read: "ui.tool.running.read",
  list: "ui.tool.running.list",
  glob: "ui.tool.running.glob",
  grep: "ui.tool.running.grep",
  codesearch: "ui.tool.running.codesearch",
  webfetch: "ui.tool.running.webfetch",
  websearch: "ui.tool.running.websearch",
  bash: "ui.tool.running.bash",
  edit: "ui.tool.running.edit",
  multiedit: "ui.tool.running.edit",
  write: "ui.tool.running.write",
  apply_patch: "ui.tool.running.patch",
}

/** The present-tense label a live call shows in place of its noun title. */
export function runningLabel(tool: string): UiI18nKey | undefined {
  return running[tool]
}

/** The first line of a failure, for the collapsed row. */
export function errorLine(value: string | undefined) {
  const line = (value ?? "")
    .replace(/^Error:\s*/, "")
    .split(/\r?\n/)
    .find((item) => item.trim())
  return line?.trim() ?? ""
}

export function lineCount(value: string | undefined) {
  if (!value) return 0
  const lines = value.split(/\r?\n/)
  return lines.at(-1) === "" ? lines.length - 1 : lines.length
}

/** The shell tool appends a metadata trailer on sandbox warnings, timeouts, and aborts; it is not output. */
export function stripBashMetadata(value?: string) {
  return (value ?? "").replace(/\s*<bash_metadata>[\s\S]*?<\/bash_metadata>\s*$/g, "")
}

export type ToolSummary = { key: UiI18nKey; params: UiI18nParams }

const plural = (name: "lines" | "matches" | "files", count: number): ToolSummary => ({
  key: `ui.tool.summary.${name}.${count === 1 ? "one" : "other"}`,
  params: { count },
})

/**
 * One quiet receipt for a finished call: what it produced, in the units the
 * tool itself reports (exit code, matches, files, lines). Nothing is guessed
 * for tools whose body already says it (diffs, kernels, delegation).
 */
export function toolSummary(input: {
  tool: string
  status?: string
  output?: string
  metadata?: Record<string, unknown>
}): ToolSummary[] {
  if (input.status !== "completed") return []
  const metadata = input.metadata ?? {}
  const output = input.output ?? ""
  switch (input.tool) {
    case "bash": {
      const exit = typeof metadata.exit === "number" && metadata.exit !== 0 ? metadata.exit : undefined
      const lines = lineCount(stripBashMetadata(output))
      return [
        ...(exit === undefined ? [] : [{ key: "ui.tool.summary.exit" as const, params: { code: exit } }]),
        ...(lines > 0 ? [plural("lines", lines)] : []),
      ]
    }
    case "grep":
      return typeof metadata.matches === "number" ? [plural("matches", metadata.matches)] : []
    case "glob":
    case "list":
      return typeof metadata.count === "number" ? [plural("files", metadata.count)] : []
    case "read": {
      const lines = output.match(/^\d{5}\| /gm)?.length ?? 0
      return lines > 0 ? [plural("lines", lines)] : []
    }
    case "webfetch":
    case "websearch":
    case "codesearch": {
      const lines = lineCount(output)
      return lines > 0 ? [plural("lines", lines)] : []
    }
    default:
      return []
  }
}

export type TaskPhase =
  | "preparing"
  | "queued"
  | "running"
  | "failed_to_start"
  | "failed"
  | "partial"
  | "timed_out"
  | "cancelled"
  | "completed"

/**
 * The backend records a Task part as soon as the model starts emitting its
 * arguments and binds a child session only once dispatch succeeds, so a child
 * id is the only proof that a worker exists. `activeMs` first appears when the
 * child holds its capacity slot and provider work begins; before that the
 * worker is queued.
 */
export function taskPhase(input: { status?: string; error?: string; metadata?: Record<string, unknown> }): TaskPhase {
  const metadata = input.metadata ?? {}
  const child = typeof metadata.sessionId === "string" && metadata.sessionId !== ""
  if (input.status === "error") {
    if (metadata.cancelled === true || toolOutcome("error", input.error) === "cancelled") return "cancelled"
    return child ? "failed" : "failed_to_start"
  }
  if (input.status === "completed") {
    if (metadata.outcome === "partial") return "partial"
    if (metadata.outcome === "timed_out") return "timed_out"
    if (metadata.outcome === "error") return "failed"
    return "completed"
  }
  if (input.status === "running" && child) return metadata.activeMs === undefined ? "queued" : "running"
  return "preparing"
}

/** The outcome vocabulary the delegation card is styled by. */
export function taskOutcome(
  phase: TaskPhase,
): "pending" | "running" | "error" | "partial" | "timed_out" | "cancelled" | "completed" {
  if (phase === "preparing" || phase === "queued") return "pending"
  if (phase === "failed_to_start" || phase === "failed") return "error"
  return phase
}

export type PendingOperation = { id: string; tool: string; title: string; started: boolean }

/**
 * Calls a stop left unfinished: still live, or closed by the runtime as
 * cancelled. `started` says whether the call had begun executing; a call that
 * never started took no action.
 */
export function pendingOperations(
  parts: ReadonlyArray<{
    id: string
    type: string
    tool?: string
    state?: { status?: string; title?: string; input?: unknown; error?: string; metadata?: unknown }
  }>,
): PendingOperation[] {
  const result: PendingOperation[] = []
  for (const part of parts) {
    if (part.type !== "tool" || !part.state) continue
    const state = part.state
    const metadata = (state.metadata ?? {}) as Record<string, unknown>
    const live = state.status === "running" || state.status === "pending"
    const cancelled =
      state.status === "error" && (metadata.cancelled === true || toolOutcome("error", state.error) === "cancelled")
    if (!live && !cancelled) continue
    const input = (state.input ?? {}) as Record<string, unknown>
    const description = typeof input.description === "string" ? input.description : ""
    const started = live
      ? state.status === "running"
      : metadata.started !== false && !/had not started/i.test(state.error ?? "")
    result.push({
      id: part.id,
      tool: part.tool ?? "",
      title: state.title || description || humanizeToolName(part.tool ?? ""),
      started,
    })
  }
  return result
}

export function toolErrorDisplay(tool: string, value: string) {
  const cleaned = value.replace(/^Error:\s*/, "")
  if (toolOutcome("error", cleaned) === "cancelled") {
    return { title: `${humanizeToolName(tool)} cancelled`, message: cleaned }
  }
  const malformed = /(?:tool was called with invalid arguments|received invalid arguments or incomplete input)/i.test(
    cleaned,
  )
  if (malformed) {
    return {
      title: `Incomplete ${sentenceCaseLabel(tool)} call`,
      message: tool.toLowerCase() === "bash" ? "No command was run." : "No action was taken.",
      details: cleaned,
    }
  }
  const [title, ...rest] = cleaned.split(": ")
  if (title && title.length < 30 && rest.length) {
    return { title, message: rest.join(": ") }
  }
  return { title: `${humanizeToolName(tool)} failed`, message: cleaned }
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

export function artifactTypeLabel(artifact: Pick<SavedArtifact, "kind" | "path" | "mimeType">): string {
  if (artifact.mimeType === "application/pdf" || artifact.path.toLowerCase().endsWith(".pdf")) return "PDF"
  return sentenceCaseLabel(artifact.kind)
}

const record = (value: unknown): Record<string, unknown> | undefined => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

export function sessionErrorText(value: unknown): string {
  const error = record(value)
  const data = record(error?.data)
  const message = typeof data?.message === "string" ? data.message : "Request failed"
  const body = typeof data?.responseBody === "string" ? data.responseBody : ""
  if (!body.includes('"error":"insufficient_balance"')) return message

  const required = body.match(/"required_cents":\s*(\d+)/)?.[1]
  const available = body.match(/"available_cents":\s*(\d+)/)?.[1]
  if (!required || !available) return "The connected provider account has insufficient balance for this step."
  return `The connected provider account needs $${(Number(required) / 100).toFixed(2)} for this step; $${(Number(available) / 100).toFixed(2)} is available.`
}

export type SessionErrorDisplay = {
  state: "paused" | "stopped" | "error"
  /**
   * Why a stopped turn ended, as far as the runtime recorded it: a Stop press,
   * an interruption the runtime named (a credential revision), a wait the
   * runtime gave up on, or a provider that stopped answering.
   */
  reason?: "user" | "interrupted" | "timeout" | "provider"
  title?: string
  message: string
  action?: "retry"
}

/**
 * A Stop press aborts the turn's controller without a reason, so the SDK's
 * generic abort text is the only record of it. Every other abort names its
 * cause in the recorded message.
 */
const genericAbort = /^(?:the operation was aborted|signal is aborted without reason|aborted)\.?$/i

/**
 * A turn that ended early is presented by what the runtime recorded, never by
 * a generic failure: nothing here implies completed work was undone or that
 * the turn resumes on its own.
 */
export function sessionErrorDisplay(value: unknown): SessionErrorDisplay {
  const error = record(value)
  const data = record(error?.data)
  const metadata = record(data?.metadata)
  const state = metadata?.openscience_state ?? data?.openscience_state
  const action = metadata?.action ?? data?.action
  if (state === "paused" && action === "retry") {
    return { state: "paused", title: "Paused", message: sessionErrorText(value), action: "retry" }
  }
  if (error?.name === "MessageAbortedError") {
    const recorded = typeof data?.message === "string" ? data.message.trim() : ""
    if (!recorded || genericAbort.test(recorded)) {
      return {
        state: "stopped",
        reason: "user",
        title: "Stopped",
        message:
          "Stopped at your request. Completed steps and written files are kept; nothing continues automatically.",
      }
    }
    return { state: "stopped", reason: "interrupted", title: "Stopped", message: recorded }
  }
  if (state === "stopped") {
    const code = typeof metadata?.code === "string" ? metadata.code : ""
    return {
      state: "stopped",
      reason: /timeout|timed_out/i.test(code) ? "timeout" : "provider",
      title: "Stopped",
      message: sessionErrorText(value),
    }
  }
  return { state: "error", message: sessionErrorText(value) }
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
  const artifacts = new Map<string, SavedArtifact>()
  for (const part of parts) {
    if (part.type !== "tool" || part.tool !== "artifact" || part.state?.status !== "completed") continue
    const metadata = record(part.state.metadata)
    const artifact = savedArtifact(metadata?.savedArtifact)
    if (!artifact) continue
    const current = artifacts.get(artifact.id)
    if (!current || artifact.version >= current.version) artifacts.set(artifact.id, artifact)
  }
  return [...artifacts.values()]
}

const filename = (value: string) => value.replaceAll("\\", "/").split("/").pop() || value
const absolute = /^(?:\/|[A-Za-z]:[\\/])/

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
 * Completed file receipts, preferring the runtime-resolved target over the
 * requested input path. Canonical-only mode supplies precise write/edit/patch
 * targets for bare chat links; it never guesses paths from shell or kernel code.
 *
 * Files a shell command or kernel changed arrive as `patch` parts: the backend
 * diffs the project after each step and records the real paths, so they are
 * receipts too. `resolve` runs them through the same host-path resolver the
 * chat's file links use; a path it does not accept is left out.
 */
export function writtenFiles(
  parts: ReadonlyArray<{
    type: string
    tool?: string
    state?: { status?: string; input?: unknown; metadata?: unknown }
    files?: unknown
  }>,
  options?: { canonicalOnly?: boolean; resolve?: (path: string) => string | undefined },
): string[] {
  const files: string[] = []
  const seen = new Set<string>()
  const push = (value: unknown) => {
    if (typeof value !== "string" || !value || seen.has(value)) return
    if (options?.canonicalOnly && !absolute.test(value)) return
    seen.add(value)
    files.push(value)
  }
  for (const part of parts) {
    if (part.type === "patch") {
      // The backend records patch entries as absolute worktree paths; anything
      // else is not a receipt.
      for (const file of Array.isArray(part.files) ? part.files : []) {
        if (typeof file !== "string" || !absolute.test(file)) continue
        push(options?.resolve ? options.resolve(file) : file)
      }
      continue
    }
    if (part.type !== "tool" || part.state?.status !== "completed") continue
    const input = (part.state.input ?? {}) as Record<string, unknown>
    const metadata = (part.state.metadata ?? {}) as Record<string, unknown>
    if (part.tool === "write" || part.tool === "edit" || part.tool === "multiedit") {
      const diff = metadata.filediff
      const canonical =
        part.tool === "edit" && diff && typeof diff === "object" && "file" in diff ? diff.file : metadata.filepath
      push(typeof canonical === "string" ? canonical : options?.canonicalOnly ? undefined : input.filePath)
    }
    if (options?.canonicalOnly && part.tool !== "apply_patch") continue
    if (["notebook", "python", "r", "rkernel"].includes(part.tool ?? "")) {
      for (const file of Array.isArray(metadata.files) ? metadata.files : []) push(file)
    }
    if (part.tool === "generate_image") push(metadata.filepath)
    if (part.tool === "webfetch" && metadata.download && typeof metadata.download === "object") {
      push((metadata.download as Record<string, unknown>).path)
    }
    if (part.tool !== "apply_patch") continue
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
}): string | undefined {
  const meta = source.metadata?.name
  if (typeof meta === "string" && meta) return meta
  const input = source.input?.name
  if (typeof input === "string" && input) return input
  const title = source.title
  if (typeof title === "string" && title.startsWith("Loaded skill: ")) return title.slice("Loaded skill: ".length)
  return undefined
}

const loadedPrefix = "Loaded skill: "

/**
 * Only the completed load result proves that instructions were delivered: it
 * records the skill's name with its directory and instruction hash, where a
 * discovery result carries the query as `name` and no directory. The title
 * prefix remains the fallback for transcripts recorded before that metadata.
 * Never infer a load from requested inputs.
 */
export function loadedSkillName(source: {
  metadata?: Record<string, unknown>
  title?: string
  status?: string
}): string | undefined {
  if (source.status !== "completed" || source.metadata?.ok === false) return
  const metadata = source.metadata ?? {}
  const name = typeof metadata.name === "string" ? metadata.name.trim() : ""
  const recorded = typeof metadata.contentHash === "string" || (typeof metadata.dir === "string" && metadata.dir !== "")
  if (recorded && name) return name
  const title = source.title?.startsWith(loadedPrefix) ? source.title.slice(loadedPrefix.length).trim() : ""
  if (!title) return
  return name || title
}

export function skillActivity(source: {
  metadata?: Record<string, unknown>
  input?: Record<string, unknown>
  title?: string
  status?: string
}): { title: string; subtitle?: string } {
  if (source.status === "error" || source.metadata?.ok === false) {
    const name = source.input?.name
    return typeof name === "string" && name
      ? { title: "Skill load failed", subtitle: name }
      : { title: "Skill lookup failed" }
  }
  // Models may send discovery fields with an exact load. The completed result
  // identifies what actually happened, rather than the optional input fields.
  const loaded = loadedSkillName(source)
  if (loaded) return { title: `Loaded skill: ${loaded}` }
  const search =
    typeof source.input?.query === "string" ||
    typeof source.input?.category === "string" ||
    source.title?.startsWith("Skill matches:") ||
    source.title?.startsWith("Skills in category:")
  if (search) {
    const matches = Array.isArray(source.metadata?.matches) ? source.metadata.matches.length : 0
    if (source.status !== "completed") return { title: "Finding relevant skills" }
    return matches > 0
      ? { title: `Found ${matches} relevant ${matches === 1 ? "skill" : "skills"}` }
      : { title: "No matching skills found" }
  }

  const names = Array.isArray(source.metadata?.names)
    ? source.metadata.names.filter((name): name is string => typeof name === "string" && !!name)
    : []
  if (names.length > 1) return { title: `${names.length} skills`, subtitle: names.join(" · ") }
  const name = skillName(source)
  if (source.status === "completed") return { title: "Skill result", ...(name ? { subtitle: name } : {}) }
  return name ? { title: `Loading ${name}` } : { title: "Finding relevant skills" }
}

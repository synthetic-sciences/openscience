import path from "node:path"
import crypto from "node:crypto"
import type { Tool } from "@/tool/tool"
import { MessageV2 } from "./message-v2"

const FAILURE_PREFIX = "[openscience-tool-failure]"
type WebFetchFailure = {
  version: 1
  code: "webfetch_terminal_status" | "webfetch_text_oversize" | "webfetch_download_oversize"
  tool: "webfetch"
  normalized_url: string
  status_code?: 404 | 405
  attempted_max_bytes?: number
  declared_size_bytes?: number
  safe_capacity_bytes?: number
  limit_kind?: "disk" | "legacy"
}

type KernelFailure = {
  version: 1
  code: "kernel_timeout"
  tool: "python" | "r"
  environment: string
  timeout_ms: number
}

type Failure = WebFetchFailure | KernelFailure

type RetryGuardMetadata =
  | { version: 1; kind: "failure"; failure: Failure }
  | { version: 1; kind: "blocked"; details: Record<string, unknown> }

const METADATA_KEY = "openscienceRetryGuard"

class RetryGuardError extends Error {
  constructor(
    message: string,
    readonly retryGuard: RetryGuardMetadata,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = retryGuard.kind === "failure" ? "ToolFailureError" : "ToolRetryBlockedError"
  }
}

type HistoryEvent = {
  kind: "error"
  at: number
  tool: string
  input: Record<string, unknown>
  error: string
  failure?: Failure
  callID?: string
}

type SessionHistory = {
  seeded: boolean
  events: Map<string, HistoryEvent>
  contexts: WeakSet<MessageV2.WithParts[]>
  webFetchMigrations: Set<string>
  ordered?: HistoryEvent[]
}

const SESSION_CACHE_LIMIT = 128
const sessionHistory = new Map<string, SessionHistory>()
const contextHistory = new WeakMap<MessageV2.WithParts[], HistoryEvent[]>()

function cache(sessionID: string) {
  const found = sessionHistory.get(sessionID)
  if (found) {
    sessionHistory.delete(sessionID)
    sessionHistory.set(sessionID, found)
    return found
  }
  const result: SessionHistory = {
    seeded: false,
    events: new Map(),
    contexts: new WeakSet(),
    webFetchMigrations: new Set(),
  }
  sessionHistory.set(sessionID, result)
  while (sessionHistory.size > SESSION_CACHE_LIMIT) sessionHistory.delete(sessionHistory.keys().next().value!)
  return result
}

function eventKey(event: HistoryEvent) {
  if (event.callID) return `${event.tool}:${event.callID}:${event.kind}`
  return `${event.tool}:${event.kind}:${event.at}:${JSON.stringify(event.input)}`
}

function add(history: SessionHistory, items: HistoryEvent[]) {
  for (const event of items) {
    const key = eventKey(event)
    if (history.events.has(key)) continue
    history.events.set(key, event)
    history.ordered = undefined
  }
}

function text(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function annotated(failure: Failure, message: string, cause?: unknown) {
  return new RetryGuardError(message, { version: 1, kind: "failure", failure }, { cause })
}

function blocked(data: Record<string, unknown>, guidance: string) {
  return new RetryGuardError(guidance, {
    version: 1,
    kind: "blocked",
    details: { version: 1, ...data },
  })
}

function parseFailure(error: string): Failure | undefined {
  const line = error.split("\n", 1)[0]
  if (!line?.startsWith(FAILURE_PREFIX)) return
  try {
    return JSON.parse(line.slice(FAILURE_PREFIX.length)) as Failure
  } catch {
    return
  }
}

function metadataFailure(metadata: Record<string, unknown> | undefined): Failure | undefined {
  const value = metadata?.[METADATA_KEY]
  if (!value || typeof value !== "object") return
  const envelope = value as Partial<RetryGuardMetadata>
  if (envelope.version !== 1 || envelope.kind !== "failure" || !envelope.failure) return
  const failure = envelope.failure as Partial<Failure>
  if (failure.version !== 1 || !["webfetch", "python", "r"].includes(String(failure.tool))) return
  return envelope.failure
}

function stateTime(part: MessageV2.ToolPart) {
  if (part.state.status === "pending") return 0
  return part.state.status === "running" ? part.state.time.start : part.state.time.end
}

function messageEvents(messages: MessageV2.WithParts[]): HistoryEvent[] {
  const found = contextHistory.get(messages)
  if (found) return found
  const result = messages.flatMap((message) =>
    message.parts.flatMap((part): HistoryEvent[] => {
      if (part.type !== "tool" || part.state.status === "pending" || part.state.status === "running") return []
      if (!["webfetch", "python", "notebook", "r", "rkernel", "apply_patch"].includes(part.tool)) return []
      if (part.state.status !== "error") return []
      return [
        {
          kind: "error",
          at: stateTime(part),
          tool: part.tool,
          input: part.state.input,
          error: part.state.error,
          failure: metadataFailure(part.state.metadata),
          callID: part.callID,
        },
      ]
    }),
  )
  contextHistory.set(messages, result)
  return result
}

async function events(ctx: Tool.Context): Promise<HistoryEvent[]> {
  const history = cache(ctx.sessionID)
  // Tool contexts normally contain the compacted model view. Read the durable
  // session stream as well so a terminal failure remains a guard after context
  // compaction or a process restart. This O(session history) seed happens once
  // per live/retained session cache, not on every tool call. The same context
  // array is parsed once through the WeakMap above.
  if (!history.seeded && ctx.sessionID.startsWith("ses_")) {
    try {
      for await (const message of MessageV2.stream(ctx.sessionID)) add(history, messageEvents([message]))
    } catch {
      // A retry guard must fail open when old/synthetic storage is unavailable;
      // the supplied live context still covers the current run.
    }
  }
  history.seeded = true
  if (!history.contexts.has(ctx.messages)) {
    add(history, messageEvents(ctx.messages))
    history.contexts.add(ctx.messages)
  }
  return (history.ordered ??= [...history.events.values()].sort((a, b) => a.at - b.at))
}

export namespace ToolRetryGuard {
  function patchHash(value: string) {
    return crypto.createHash("sha256").update(value.replace(/\r\n?/g, "\n")).digest("hex")
  }

  export async function assertApplyPatch(ctx: Tool.Context, patchText: string) {
    const expected = patchHash(patchText)
    const previous = (await events(ctx))
      .filter((event): event is Extract<HistoryEvent, { kind: "error" }> => event.kind === "error")
      .filter((event) => event.tool === "apply_patch")
      .filter((event) => /apply_patch verification failed/i.test(event.error))
      .findLast(
        (event) =>
          typeof event.input.patchText === "string" &&
          patchHash(event.input.patchText) === expected &&
          !userTurnAfter(ctx, event.at),
      )
    if (!previous) return
    throw blocked(
      {
        code: "apply_patch_reread_required",
        tool: "apply_patch",
        prior_call_id: previous.callID,
        patch_sha256: expected,
      },
      "This exact patch already failed verification in the current user turn. It was stopped before another file write or approval. Re-read the current file around the intended edit and construct a new patch from the observed text; use a smaller anchored hunk if the file changed.",
    )
  }

  /** WHATWG canonicalization lower-cases the host/scheme, removes default
   * ports, and normalizes escapes. Fragments are client-only and therefore do
   * not distinguish network resources; query text and path remain intact. */
  export function normalizeURL(value: string) {
    const url = new URL(value)
    url.hash = ""
    return url.href
  }

  function statusFailure(input: Record<string, unknown>, error: string): WebFetchFailure | undefined {
    const status = /status code:\s*(404|405)\b/i.exec(error)?.[1]
    if (!status || typeof input.url !== "string") return
    return {
      version: 1,
      code: "webfetch_terminal_status",
      tool: "webfetch",
      normalized_url: normalizeURL(input.url),
      status_code: Number(status) as 404 | 405,
    }
  }

  function oldOversizeFailure(input: Record<string, unknown>, error: string): WebFetchFailure | undefined {
    if (typeof input.url !== "string" || typeof input.output_path !== "string") return
    if (
      !/Download exceeds max_bytes|Download exceeds the current safe workspace capacity|Download could not continue because workspace storage returned/i.test(
        error,
      )
    )
      return
    const diskCapacity = /(?:safe workspace capacity of|disk-derived workspace capacity is) [^(]*\((\d+) bytes\)/i.exec(
      error,
    )?.[1]
    return {
      version: 1,
      code: "webfetch_download_oversize",
      tool: "webfetch",
      normalized_url: normalizeURL(input.url),
      attempted_max_bytes: typeof input.max_bytes === "number" ? input.max_bytes : undefined,
      safe_capacity_bytes: diskCapacity ? Number(diskCapacity) : undefined,
      limit_kind: diskCapacity ? "disk" : "legacy",
      // Older builds emitted exact server Content-Length only for byte-sized
      // declared failures (`9 bytes > 8 bytes`). Rounded KiB/MiB and chunked
      // boundary messages are not exact evidence and intentionally stay unset.
      declared_size_bytes: (() => {
        const exact = /Download exceeds max_bytes \((\d+) bytes\s*>\s*\d+ bytes\)/i.exec(error)?.[1]
        return exact ? Number(exact) : undefined
      })(),
    }
  }

  function textOversizeFailure(input: Record<string, unknown>, error: string): WebFetchFailure | undefined {
    if (typeof input.url !== "string" || typeof input.output_path === "string") return
    if (!/Response is too large for Web fetch|Response too large \(exceeds 5MB limit\)/i.test(error)) return
    return {
      version: 1,
      code: "webfetch_text_oversize",
      tool: "webfetch",
      normalized_url: normalizeURL(input.url),
    }
  }

  function webFailure(event: Extract<HistoryEvent, { kind: "error" }>) {
    if (event.failure?.tool === "webfetch") return event.failure as WebFetchFailure
    const parsed = parseFailure(event.error)
    if (parsed?.tool === "webfetch") return parsed as WebFetchFailure
    return (
      statusFailure(event.input, event.error) ??
      textOversizeFailure(event.input, event.error) ??
      oldOversizeFailure(event.input, event.error)
    )
  }

  function userTurnAfter(ctx: Tool.Context, at: number) {
    return ctx.messages.some((message) => message.info.role === "user" && message.info.time.created > at)
  }

  export async function assertWebFetch(
    ctx: Tool.Context,
    input: {
      url: string
      output_path?: string
    },
  ) {
    const normalized = normalizeURL(input.url)
    const history = await events(ctx)
    const failures = history
      .filter((event): event is Extract<HistoryEvent, { kind: "error" }> => event.kind === "error")
      .filter((event) => event.tool === "webfetch")
      .map((event) => ({ event, failure: webFailure(event) }))
      .filter((item): item is { event: Extract<HistoryEvent, { kind: "error" }>; failure: WebFetchFailure } =>
        Boolean(item.failure),
      )
      .filter((item) => item.failure.normalized_url === normalized)

    const terminal = failures.findLast((item) => item.failure.code === "webfetch_terminal_status")
    if (terminal) {
      throw blocked(
        {
          code: "webfetch_terminal_url",
          tool: "webfetch",
          normalized_url: normalized,
          status_code: terminal.failure.status_code,
          prior_call_id: terminal.event.callID,
        },
        `WebFetch already received deterministic HTTP ${terminal.failure.status_code} for this normalized URL in this session. ` +
          "The repeat was stopped before permission or network access. Change the path/query or verify the endpoint with a listing or metadata request; changing timeout, format, fragment, or output filename is not a new URL.",
      )
    }

    const textOversize = failures.findLast((item) => item.failure.code === "webfetch_text_oversize")
    if (textOversize && !input.output_path) {
      throw blocked(
        {
          code: "webfetch_text_strategy_change_required",
          tool: "webfetch",
          normalized_url: normalized,
          prior_call_id: textOversize.event.callID,
        },
        "This exact URL already exceeded the WebFetch body-response limit in this session. The repeated text/markdown/html transfer was stopped before permission or network access. Use output_path for a bounded brokered download, request a genuinely smaller paginated URL, or use a metadata/listing endpoint; changing only the response format is not a new strategy.",
      )
    }

    const oversize = failures.findLast((item) => item.failure.code === "webfetch_download_oversize")
    if (!oversize || !input.output_path) return
    // One migration attempt is safe for any pre-redesign max_bytes failure,
    // including calls where the agent supplied that retired field. Record the
    // allowance before network/permission work so an unrelated failure cannot
    // turn migration into a same-turn loop. If the disk-policy call itself
    // reaches capacity, its new disk failure also becomes the latest guard.
    if (oversize.failure.limit_kind !== "disk") {
      if (userTurnAfter(ctx, oversize.event.at)) return
      const migration = `${normalized}:${eventKey(oversize.event)}`
      const history = cache(ctx.sessionID)
      if (!history.webFetchMigrations.has(migration)) {
        history.webFetchMigrations.add(migration)
        return
      }
      throw blocked(
        {
          code: "webfetch_legacy_capacity_migration_used",
          tool: "webfetch",
          normalized_url: normalized,
          prior_call_id: oversize.event.callID,
          legacy_max_bytes: oversize.failure.attempted_max_bytes,
        },
        "This URL already used its one same-turn migration from the retired per-call cap policy to the live disk-derived policy. " +
          "The repeat was stopped before permission or network access. Do not invent cap/evidence fields; wait for a new user turn or use a smaller or paginated source.",
      )
    }
    // A later user turn may retry after actually freeing disk or selecting a
    // different operational strategy. Within one assistant turn, repeated
    // calls are stopped before permission and network access.
    if (userTurnAfter(ctx, oversize.event.at)) return
    throw blocked(
      {
        code: "webfetch_download_capacity_strategy_required",
        tool: "webfetch",
        normalized_url: normalized,
        prior_call_id: oversize.event.callID,
        safe_capacity_bytes: oversize.failure.safe_capacity_bytes,
        legacy_max_bytes: oversize.failure.attempted_max_bytes,
      },
      `This URL already exceeded the live safe workspace capacity${
        oversize.failure.safe_capacity_bytes === undefined ? "" : ` of ${oversize.failure.safe_capacity_bytes} bytes`
      } in this assistant turn. The unchanged retry was stopped before permission or network access. ` +
        "Do not invent a per-call byte cap or repeat the transfer. Use a smaller or paginated source, free disk space, a provider-native dataset client, or a dedicated approved transfer path.",
    )
  }

  export function annotateWebFetch(
    ctx: Tool.Context,
    input: Record<string, unknown> & { url: string },
    error: unknown,
    details?: { safeCapacityBytes?: number; declaredSizeBytes?: number },
  ) {
    const message = text(error)
    const failure =
      statusFailure(input, message) ??
      textOversizeFailure(input, message) ??
      (details || oldOversizeFailure(input, message)
        ? ({
            version: 1,
            code: "webfetch_download_oversize",
            tool: "webfetch",
            normalized_url: normalizeURL(input.url),
            attempted_max_bytes: typeof input.max_bytes === "number" ? input.max_bytes : undefined,
            declared_size_bytes: details?.declaredSizeBytes,
            safe_capacity_bytes: details?.safeCapacityBytes,
            limit_kind: details?.safeCapacityBytes !== undefined ? "disk" : "legacy",
          } satisfies WebFetchFailure)
        : undefined)
    if (!failure) return error instanceof Error ? error : new Error(message)
    const result = annotated(failure, message, error)
    add(cache(ctx.sessionID), [
      {
        kind: "error",
        at: Date.now(),
        tool: "webfetch",
        input,
        error: result.message,
        failure,
        callID: ctx.callID,
      },
    ])
    return result
  }

  /** SessionProcessor persists this alongside ToolStateError. The public
   * Error.message stays human-readable; durable replay state never leaks into
   * error cards or provider-visible tool error text. */
  export function errorMetadata(error: unknown): Record<string, unknown> | undefined {
    if (!(error instanceof RetryGuardError)) return
    return { [METADATA_KEY]: error.retryGuard }
  }

  type KernelInput = {
    code: string
    source?: string
    environment: string
  }

  function canonicalResource(value: string) {
    const trimmed = value.trim()
    if (/^https?:\/\//i.test(trimmed)) {
      try {
        return normalizeURL(trimmed)
      } catch {
        return trimmed.toLowerCase()
      }
    }
    if (/^[A-Za-z]:[\\/]/.test(trimmed)) return path.win32.normalize(trimmed).toLowerCase()
    // Code cells do not carry a trustworthy workspace base here, so normalize
    // dot segments lexically instead of resolving against the server cwd.
    // This still makes `wide.tsv`, `./wide.tsv`, and
    // `./data/../wide.tsv` one resource without conflating different parents.
    // POSIX and default macOS volumes may be case-sensitive. Preserve local
    // path case so distinct `Tumor.csv` / `tumor.csv` resources are never
    // collapsed; Windows paths alone use case-folded identity above.
    return path.posix.normalize(trimmed.replaceAll("\\", "/"))
  }

  const resources = (code: string) =>
    new Set(
      Array.from(code.matchAll(/(["'])(.*?)\1/gs), (match) => match[2]!)
        .filter(
          (value) =>
            /^(?:https?:\/\/|[A-Za-z]:[\\/])/.test(value) ||
            value.includes("/") ||
            /\.(?:csv|tsv|txt|jsonl?|parquet|arrow|feather|xlsx?|h5ad|h5|rds|rdata|zip|gz|bz2|xz)\b/i.test(value),
        )
        .map(canonicalResource),
    )

  const tokens = (code: string) =>
    new Set(Array.from(code.toLowerCase().matchAll(/[a-z_][\w.]*|\d+(?:\.\d+)?/g), (match) => match[0]))

  const STRATEGY_CALL =
    /(?:^|\.|::)(?:scan_csv|scan_parquet|read_csv_arrow|read_delim_chunked|read_csv_chunked|fread|vroom|open_csv|open_dataset|dataset|parquet_file)$/
  const CHUNKABLE_CALL =
    /(?:^|\.|::)(?:read_csv|read_table|read_delim|read_fwf|read_json|read_excel|readrds|read\.csv|read\.table|read\.delim)$/

  function executableStructure(code: string) {
    let output = ""
    let quote: "'" | '"' | "`" | "'''" | '"""' | undefined
    let escaped = false
    for (let index = 0; index < code.length; index++) {
      const char = code[index]!
      if (quote) {
        if ((quote === "'''" || quote === '"""') && code.startsWith(quote, index)) {
          output += " ".repeat(quote.length)
          index += quote.length - 1
          quote = undefined
          continue
        }
        if (escaped) {
          escaped = false
          output += " "
          continue
        }
        if (char === "\\") {
          escaped = true
          output += " "
          continue
        }
        if (quote.length === 1 && char === quote) quote = undefined
        output += char === "\n" ? "\n" : " "
        continue
      }
      if (char === "'" || char === '"' || char === "`") {
        const triple = char !== "`" && code.startsWith(char.repeat(3), index)
        quote = triple ? (char.repeat(3) as "'''" | '"""') : char
        output += triple ? "   " : " "
        if (triple) index += 2
        continue
      }
      if (char === "#") {
        while (index < code.length && code[index] !== "\n") index++
        output += "\n"
        continue
      }
      output += char
    }
    return output
  }

  function executableCalls(code: string) {
    const structure = executableStructure(code)
    const result: { name: string; args: string; start: number; end: number; structure: string }[] = []
    const starts = structure.matchAll(/\b([A-Za-z_][\w]*(?:(?:\.|::)[A-Za-z_][\w]*)*)\s*\(/g)
    for (const match of starts) {
      const name = match[1]!.toLowerCase()
      const open = match.index! + match[0].lastIndexOf("(")
      let depth = 0
      let end = structure.length
      for (let index = open; index < structure.length; index++) {
        if (structure[index] === "(") depth++
        if (structure[index] !== ")") continue
        depth--
        if (depth !== 0) continue
        end = index
        break
      }
      result.push({ name, args: structure.slice(open + 1, end).toLowerCase(), start: match.index!, end, structure })
    }
    return result
  }

  function canonicalOperation(name: string) {
    const strategy = STRATEGY_CALL.exec(name)?.[0]?.replace(/^(?:\.|::)/, "")
    if (strategy) {
      if (
        ["scan_csv", "read_csv_arrow", "read_delim_chunked", "read_csv_chunked", "fread", "vroom", "open_csv"].includes(
          strategy,
        )
      ) {
        return "strategy:tabular"
      }
      return "strategy:dataset"
    }
    const chunkable = CHUNKABLE_CALL.exec(name)?.[0]
      ?.replace(/^(?:\.|::)/, "")
      .replaceAll(".", "_")
    if (chunkable) {
      if (["read_csv", "read_table", "read_delim", "read_fwf"].includes(chunkable)) return "reader:tabular"
      return `reader:${chunkable}`
    }
    return name
  }

  const calls = (code: string) =>
    new Set(
      executableCalls(code)
        .map(({ name }) => canonicalOperation(name))
        .filter((value) => !["if", "for", "while", "with", "function"].includes(value)),
    )

  /** Only executable call structure counts as a new bounded strategy. Raw
   * identifiers are deliberately ignored: `# streaming`, `note='chunk_size'`,
   * or an unused `chunk_size = 10` must not authorize the same operation. */
  const strategyMarkers = (code: string) => {
    const result = new Set<string>()
    for (const { name, args } of executableCalls(code)) {
      if (STRATEGY_CALL.test(name)) result.add(canonicalOperation(name))
      if (CHUNKABLE_CALL.test(name) && /\b(?:chunksize|chunk_size|batch_size|iterator|streaming)\s*=/.test(args)) {
        result.add(`chunked:${canonicalOperation(name)}`)
      }
    }
    return result
  }

  const LIGHTWEIGHT_CALL =
    /(?:^|\.|::)(?:print|cat|summary|head|tail|str|glimpse|tolist|to_string|collect_schema|schema|names|dim)$/

  /** Unbounded loaders that can still repeat the timed-out I/O. Downstream
   * transforms are intentionally ignored: `groupby().sum()` may remain when
   * the reader itself becomes chunked, while appending a lazy scan beside an
   * unchanged full reader must not authorize the cell. */
  const unboundedLoaders = (code: string) =>
    new Set(
      executableCalls(code).flatMap(({ name, args }) => {
        if (LIGHTWEIGHT_CALL.test(name) || STRATEGY_CALL.test(name) || !CHUNKABLE_CALL.test(name)) return []
        if (CHUNKABLE_CALL.test(name) && /\b(?:chunksize|chunk_size|batch_size|iterator|streaming)\s*=/.test(args)) {
          return []
        }
        return [canonicalOperation(name)]
      }),
    )

  function boundedExpression(value: string) {
    return (
      // Numeric index or a slice with an explicit finite upper bound. Open
      // ended `[start:]` slices are deliberately not treated as bounded.
      /\[\s*\d+\s*\]|\[\s*(?:\d+\s*)?:\s*\d+\s*(?::\s*\d+\s*)?\]/.test(value) ||
      // An explicit numeric partition/fold selector in bracket form.
      /\[[^\]\n]*(?:==|!=)\s*(?:\d+|true|false)[^\]\n]*\]/.test(value)
    )
  }

  function boundedCall(name: string, args: string) {
    if (/(?:^|\.|::)(?:head|sample)$/.test(name)) {
      return /^\s*\d+\b/.test(args) || /\bn\s*=\s*\d+\b/.test(args)
    }
    return /(?:^|\.|::)(?:take|slice|partition)$/.test(name) && /^\s*\d+\b/.test(args)
  }

  function leadingOperands(args: string) {
    const result: string[] = []
    let start = 0
    let depth = 0
    for (let index = 0; index <= args.length; index++) {
      const char = args[index]
      if (char === "(" || char === "[" || char === "{") depth++
      else if (char === ")" || char === "]" || char === "}") depth--
      if (index < args.length && (char !== "," || depth !== 0)) continue
      const operand = args.slice(start, index).trim()
      if (!operand || /(^|[^=!<>])=(?!=)/.test(operand)) break
      result.push(operand)
      start = index + 1
    }
    return result
  }

  /** Retained operations that now consume an explicitly bounded subset. The
   * selector must occur inside the call arguments or earlier in the same
   * executable method chain/statement. A separate appended `head()`/`sample()`
   * cannot authorize an unchanged expensive operation. */
  function boundedOperations(code: string, retained: Set<string>) {
    const result = new Set<string>()
    for (const call of executableCalls(code)) {
      const operation = canonicalOperation(call.name)
      if (!retained.has(operation)) continue
      // Bracket selectors count only in leading positional data operands.
      // An indexed tuning kwarg (`verbose=flags[0]`) or list-valued callback
      // does not make unchanged training/aggregation work bounded.
      if (leadingOperands(call.args).some(boundedExpression)) {
        result.add(operation)
        continue
      }
      const statementStart = Math.max(
        call.structure.lastIndexOf("\n", call.start),
        call.structure.lastIndexOf(";", call.start),
      )
      const prefix = call.structure.slice(statementStart + 1, call.start)
      if (boundedExpression(prefix)) {
        result.add(operation)
        continue
      }
      const prefixCalls = executableCalls(prefix)
      if (prefixCalls.some((item) => boundedCall(item.name, item.args))) result.add(operation)
    }
    return result
  }

  function overlap(a: Set<string>, b: Set<string>) {
    if (!a.size || !b.size) return 0
    let shared = 0
    for (const value of a) if (b.has(value)) shared++
    return shared / Math.min(a.size, b.size)
  }

  export function kernelSimilarity(a: KernelInput, b: KernelInput) {
    const normalizedA = a.code.replace(/\s+/g, " ").trim()
    const normalizedB = b.code.replace(/\s+/g, " ").trim()
    const operationsA = calls(a.code)
    const operationsB = calls(b.code)
    const resourcesA = resources(a.code)
    const resourcesB = resources(b.code)
    const sharedResources = [...resourcesA].filter((value) => resourcesB.has(value))
    const operationOverlap = overlap(operationsA, operationsB)
    const resourceOverlap = overlap(resourcesA, resourcesB)
    const tokenOverlap = overlap(tokens(a.code), tokens(b.code))
    const explicitSource = Boolean(a.source && b.source && a.source === b.source)
    const resourcesConflict = resourcesA.size > 0 && resourcesB.size > 0 && resourceOverlap === 0
    const previousStrategies = strategyMarkers(a.code)
    const proposedStrategies = strategyMarkers(b.code)
    const introducedStrategy = [...proposedStrategies].some((value) => !previousStrategies.has(value))
    const priorUnbounded = unboundedLoaders(a.code)
    const proposedUnbounded = unboundedLoaders(b.code)
    const retainedUnbounded = [...priorUnbounded].filter((value) => proposedUnbounded.has(value))
    const boundedRetained = boundedOperations(b.code, operationsA)
    const changedStrategy = (introducedStrategy || boundedRetained.size > 0) && retainedUnbounded.length === 0
    const same =
      normalizedA === normalizedB ||
      (!changedStrategy &&
        ((!resourcesConflict && explicitSource && operationOverlap >= 0.65 && tokenOverlap >= 0.5) ||
          (resourceOverlap >= 0.5 && operationOverlap >= 0.65 && tokenOverlap >= 0.5) ||
          (!resourcesA.size &&
            !resourcesB.size &&
            operationOverlap >= 0.85 &&
            tokenOverlap >= 0.6 &&
            operationsA.size > 0 &&
            operationsB.size > 0)))
    const score =
      normalizedA === normalizedB ? 1 : 0.45 * operationOverlap + 0.35 * resourceOverlap + 0.2 * tokenOverlap
    return { same, score, sharedResources, changedStrategy }
  }

  function kernelTool(language: "python" | "r", tool: string) {
    return language === "python" ? tool === "python" || tool === "notebook" : tool === "r" || tool === "rkernel"
  }

  function timedOut(event: Extract<HistoryEvent, { kind: "error" }>, language: "python" | "r") {
    if (!kernelTool(language, event.tool)) return false
    const parsed = event.failure ?? parseFailure(event.error)
    return parsed?.code === "kernel_timeout" || /Cell execution timed out after\s+\d+s/i.test(event.error)
  }

  export async function assertKernel(ctx: Tool.Context, input: KernelInput & { language: "python" | "r" }) {
    const history = await events(ctx)
    const unresolved = history
      .filter((event): event is Extract<HistoryEvent, { kind: "error" }> => event.kind === "error")
      .filter((event) => timedOut(event, input.language))
    for (const previous of unresolved) {
      if (typeof previous.input.code !== "string") continue
      const priorInput = {
        code: previous.input.code,
        source: typeof previous.input.source === "string" ? previous.input.source : undefined,
        environment:
          typeof previous.input.environment === "string"
            ? previous.input.environment
            : input.language === "python"
              ? "python"
              : "r",
      }
      const similarity = kernelSimilarity(priorInput, input)
      if (!similarity.same) continue
      const timeout = Number(previous.input.timeout)
      throw blocked(
        {
          code: "kernel_strategy_change_required",
          tool: input.language,
          prior_call_id: previous.callID,
          prior_timeout_ms: Number.isFinite(timeout) ? timeout : undefined,
          similarity: Number(similarity.score.toFixed(3)),
          shared_resources: similarity.sharedResources,
        },
        `A prior ${input.language === "python" ? "Python" : "R"} execution timed out on a substantially similar source and operation. ` +
          "This retry was stopped before starting a new kernel; increasing the timeout or making a cosmetic code edit is not a changed strategy. " +
          "Run a bounded, materially different preflight first (for example file size/schema, raw-byte or line-width sampling, chunk geometry, or one partition), then use a chunked/lazy/partitioned operation. " +
          "A health probe or preflight remains available because it is a different operation, but it does not erase the prior timeout or authorize the same expensive operation again. The timed-out runtime remains retired, so normal recovery calls are still available.",
      )
    }
  }

  export function annotateKernelTimeout(
    ctx: Tool.Context,
    input: Record<string, unknown>,
    language: "python" | "r",
    environment: string,
    error: unknown,
  ) {
    const message = text(error)
    if (!/Cell execution timed out after\s+\d+s/i.test(message))
      return error instanceof Error ? error : new Error(message)
    const seconds = Number(/Cell execution timed out after\s+(\d+)s/i.exec(message)?.[1])
    const failure: KernelFailure = {
      version: 1,
      code: "kernel_timeout",
      tool: language,
      environment,
      timeout_ms: Number.isFinite(seconds) ? seconds * 1000 : Number(input.timeout) || 120_000,
    }
    const result = annotated(failure, message, error)
    add(cache(ctx.sessionID), [
      {
        kind: "error",
        at: Date.now(),
        tool: language,
        input,
        error: result.message,
        failure,
        callID: ctx.callID,
      },
    ])
    return result
  }
}

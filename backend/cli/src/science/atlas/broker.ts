import path from "node:path"
import os from "node:os"
import fs from "node:fs/promises"
import { SafeFileIO } from "@/file/safe-io"
import { API_BASE, OpenScience } from "@/openscience"
import { SessionFilesystem } from "@/session/filesystem"
import { AuthoritySignal } from "@/project/authority-signal"

export type AtlasBrokerInput = {
  operation:
    | "brief"
    | "node"
    | "tree"
    | "search"
    | "ask"
    | "usage"
    | "library_list"
    | "library_summary"
    | "library_show"
    | "library_tree"
    | "library_read"
    | "library_grep"
    | "library_subscribe"
    | "library_add"
    | "library_add_local"
    | "library_sync_local"
  sessionID?: string
  project?: string
  node?: string
  query?: string
  full?: boolean
  mode?: "universal" | "targeted" | "web" | "deep"
  topK?: number
  sourceIDs?: string[]
  localSourceIDs?: string[]
  sourceID?: string
  sourceType?: "repository" | "documentation" | "research_paper" | "huggingface_dataset"
  sourceStatus?: string
  url?: string
  repository?: string
  displayName?: string
  folder?: string
  authorization?: SessionFilesystem.Authorization
  authorizationOwnership?: "borrowed" | "owned"
  sourcePath?: string
  pattern?: string
  pathPrefix?: string
  depth?: number
  limit?: number
  offset?: number
  maxFileBytes?: number
  maxFiles?: number
  maxTotalBytes?: number
  projection?: string
  maxNodes?: number
  maxDepth?: number
}

export class AtlasBrokerError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = "AtlasBrokerError"
  }
}

const timeout = Number(process.env["OPENSCIENCE_ATLAS_TIMEOUT_MS"]) || 60_000
const DEFAULT_FILE_BYTES = 1_048_576
const DEFAULT_TOTAL_BYTES = 20 * 1_048_576
const DEFAULT_FILES = 2_000
const MAX_FILE_BYTES = 4 * 1_048_576
const MAX_TOTAL_BYTES = 100 * 1_048_576
const MAX_FILES = 5_000
const MAX_GIT_BYTES = 16 * 1_048_576
const MAX_CANDIDATES = 40_000
const MIN_CANDIDATES = 1_024
const MAX_ENTRIES = 200_000
const skippedDirectories = new Set([
  ".git",
  ".openscience",
  ".atlas",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
])

const required = (value: string | undefined, name: string) => {
  const result = value?.trim()
  if (!result) throw new AtlasBrokerError(`${name} is required`)
  return result
}

const sources = (values: string[] | undefined) => {
  if (!values?.length) return
  if (values.length > 100) throw new AtlasBrokerError("source_ids accepts at most 100 Gateway identifiers")
  const result = new Set<string>()
  for (const raw of values) {
    const value = raw.trim()
    const normalized = value.replaceAll("\\", "/")
    const segments = normalized.split("/")
    const local =
      !value ||
      value.length > 512 ||
      value.includes("\0") ||
      path.isAbsolute(value) ||
      /^[A-Za-z]:[\\/]/.test(value) ||
      normalized.startsWith("~/") ||
      segments.includes(".") ||
      segments.includes("..")
    if (local) throw new AtlasBrokerError("source_ids must contain Gateway identifiers, not local folder paths")
    result.add(value)
  }
  return [...result]
}

const bounded = (value: number | undefined, fallback: number, maximum: number, name: string) => {
  if (value === undefined) return fallback
  if (!Number.isInteger(value) || value < 1 || value > maximum) {
    throw new AtlasBrokerError(`${name} must be an integer between 1 and ${maximum}`)
  }
  return value
}

const within = (root: string, target: string) => {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

const secret = (relative: string) => {
  const normalized = relative.replaceAll("\\", "/").toLowerCase()
  const segments = normalized.split("/")
  const name = segments.at(-1) ?? ""
  if (name === ".env") return true
  if (name.startsWith(".env.") && !name.endsWith(".example") && !name.endsWith(".sample")) return true
  if ([".netrc", ".npmrc", ".pypirc", ".git-credentials", "credentials.json", "id_ed25519", "id_rsa"].includes(name)) {
    return true
  }
  if ([".pem", ".key", ".p12", ".pfx"].some((extension) => name.endsWith(extension))) return true
  if ([".ssh", ".gnupg", ".aws"].some((directory) => segments.includes(directory))) return true
  if (normalized.endsWith(".docker/config.json")) return true
  return normalized.includes(".config/gcloud/")
}

const binary = (bytes: Uint8Array) => bytes.subarray(0, 8_000).includes(0)

async function command(input: { args: string[]; maxBytes: number; signal?: AbortSignal }) {
  input.signal?.throwIfAborted()
  const proc = Bun.spawn(input.args, {
    stdout: "pipe",
    stderr: "ignore",
    env: {
      PATH: process.env.PATH ?? "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: os.devNull,
      GIT_TERMINAL_PROMPT: "0",
    },
  })
  const reader = proc.stdout.getReader()
  const state = { chunks: [] as Uint8Array[], exited: false, size: 0, truncated: false }
  const abort = () => proc.kill()
  input.signal?.addEventListener("abort", abort, { once: true })
  try {
    input.signal?.throwIfAborted()
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      const remaining = input.maxBytes - state.size
      if (remaining <= 0) {
        state.truncated = true
        proc.kill()
        break
      }
      const bytes = chunk.value.subarray(0, remaining)
      state.chunks.push(bytes)
      state.size += bytes.byteLength
      if (bytes.byteLength === chunk.value.byteLength) continue
      state.truncated = true
      proc.kill()
      break
    }
    const code = await proc.exited
    state.exited = true
    input.signal?.throwIfAborted()
    return { bytes: Buffer.concat(state.chunks), code, truncated: state.truncated }
  } finally {
    if (!state.exited) proc.kill()
    input.signal?.removeEventListener("abort", abort)
    reader.releaseLock()
  }
}

async function gitFiles(root: string, limit: number, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const git = Bun.which("git")
  if (!git) return
  const base = await command({
    args: [
      git,
      "-c",
      "core.fsmonitor=false",
      "-c",
      `core.hooksPath=${os.devNull}`,
      "-C",
      root,
      "rev-parse",
      "--show-toplevel",
    ],
    maxBytes: 64 * 1024,
    signal,
  }).catch(() => undefined)
  if (!base || base.code !== 0 || base.truncated) return
  const top = await fs.realpath(base.bytes.toString().trim()).catch(() => undefined)
  if (!top || !within(top, root)) return
  const kind = top === root ? "git-root" : "git-nested"
  const listed = await command({
    args: [
      git,
      "-c",
      "core.fsmonitor=false",
      "-c",
      `core.hooksPath=${os.devNull}`,
      "-C",
      root,
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ".",
    ],
    maxBytes: MAX_GIT_BYTES,
    signal,
  }).catch(() => undefined)
  if (!listed || (listed.code !== 0 && !listed.truncated)) return
  const values = listed.bytes.toString().split("\0")
  if (listed.truncated) values.pop()
  const paths = values.filter(Boolean).slice(0, limit)
  return {
    paths: paths.toSorted((left, right) => left.localeCompare(right)),
    kind,
    truncated: listed.truncated || values.filter(Boolean).length > limit,
  }
}

async function walkedFiles(root: string, candidates: number, entries: number, signal?: AbortSignal) {
  const files: string[] = []
  const queue = [""]
  const state = { cursor: 0, entries: 0, unavailable: 0, truncated: false }
  while (state.cursor < queue.length && files.length < candidates && state.entries < entries) {
    signal?.throwIfAborted()
    const relative = queue[state.cursor++] ?? ""
    const target = relative ? path.join(root, relative) : root
    const before = await Promise.all([fs.lstat(target), fs.realpath(target)]).catch(() => undefined)
    if (
      !before ||
      !before[0].isDirectory() ||
      before[0].isSymbolicLink() ||
      before[1] !== target ||
      !within(root, before[1])
    ) {
      state.unavailable++
      continue
    }
    const directory = await fs.opendir(target).catch(() => undefined)
    if (!directory) {
      state.unavailable++
      continue
    }
    const listed = await (async () => {
      const result: Array<{ name: string; directory: boolean }> = []
      for await (const entry of directory) {
        signal?.throwIfAborted()
        if (state.entries >= entries) {
          state.truncated = true
          break
        }
        state.entries++
        result.push({ name: entry.name, directory: entry.isDirectory() })
      }
      return result
    })().catch(() => {
      state.unavailable++
      return undefined
    })
    if (!listed) continue
    const after = await Promise.all([fs.lstat(target), fs.realpath(target)]).catch(() => undefined)
    if (
      !after ||
      !after[0].isDirectory() ||
      after[0].isSymbolicLink() ||
      after[1] !== target ||
      after[0].dev !== before[0].dev ||
      after[0].ino !== before[0].ino
    ) {
      state.unavailable++
      continue
    }
    for (const entry of listed.toSorted((left, right) => left.name.localeCompare(right.name))) {
      signal?.throwIfAborted()
      const child = relative ? path.join(relative, entry.name) : entry.name
      if (entry.directory) {
        if (!skippedDirectories.has(entry.name)) queue.push(child)
        continue
      }
      if (files.length >= candidates) {
        state.truncated = true
        break
      }
      files.push(child)
    }
  }
  if (state.cursor < queue.length || files.length >= candidates || state.entries >= entries) state.truncated = true
  return { paths: files, truncated: state.truncated, unavailable: state.unavailable, entries: state.entries }
}

type CollectionInput = {
  sessionID: string
  folder: string
  authorization?: SessionFilesystem.Authorization
  authorizationOwnership?: "borrowed" | "owned"
  maxFileBytes?: number
  maxFiles?: number
  maxTotalBytes?: number
  signal?: AbortSignal
}

async function collect(input: CollectionInput) {
  const incoming = { transferred: false, released: false }
  const incomingOwnership = input.authorizationOwnership ?? "borrowed"
  const releaseIncoming = () => {
    if (!input.authorization || incomingOwnership !== "owned" || incoming.released) return
    incoming.released = true
    SessionFilesystem.releaseAuthorization(input.authorization)
  }
  using incomingCleanup = {
    [Symbol.dispose]() {
      if (!incoming.transferred) releaseIncoming()
    },
  }
  input.signal?.throwIfAborted()
  if (
    input.authorization &&
    (input.authorization.sessionID !== input.sessionID ||
      input.authorization.path !== input.folder ||
      input.authorization.access !== "read")
  ) {
    throw new SessionFilesystem.DeniedError({ sessionID: input.sessionID, path: input.folder, access: "read" })
  }
  const approval = await (async () => {
    if (input.authorization) {
      const authorized = await SessionFilesystem.revalidateAuthorization(input.authorization, {
        path: input.folder,
        access: "read",
      })
      return {
        authorization: input.authorization,
        authorizationOwnership: input.authorizationOwnership ?? ("borrowed" as const),
        authorized,
      }
    }
    const authorized = await SessionFilesystem.authorize({
      sessionID: input.sessionID,
      path: input.folder,
      access: "read",
    })
    const authorization = await SessionFilesystem.bindAuthorization({
      sessionID: input.sessionID,
      access: "read",
      authorized,
    })
    return { authorization, authorizationOwnership: "owned" as const, authorized }
  })()
  const lifecycle = { released: false, transferred: false }
  const release = () => {
    if (lifecycle.released || approval.authorizationOwnership !== "owned") return
    lifecycle.released = true
    SessionFilesystem.releaseAuthorization(approval.authorization)
  }
  using cleanup = {
    [Symbol.dispose]() {
      if (!lifecycle.transferred) release()
    },
  }
  incoming.transferred = true
  const root = await fs.realpath(approval.authorized.path)
  const rootStat = await fs.lstat(root)
  if (!rootStat.isDirectory()) throw new AtlasBrokerError(`not a directory: ${input.folder}`)

  const maxFileBytes = bounded(input.maxFileBytes, DEFAULT_FILE_BYTES, MAX_FILE_BYTES, "max_file_bytes")
  const maxFiles = bounded(input.maxFiles, DEFAULT_FILES, MAX_FILES, "max_files")
  const maxTotalBytes = bounded(input.maxTotalBytes, DEFAULT_TOTAL_BYTES, MAX_TOTAL_BYTES, "max_total_bytes")
  const candidates = Math.min(MAX_CANDIDATES, Math.max(MIN_CANDIDATES, maxFiles * 8))
  const entries = Math.min(MAX_ENTRIES, candidates * 5)
  const listed = await gitFiles(root, candidates, input.signal)
  const fallback = !listed || (listed.kind === "git-nested" && listed.paths.length === 0)
  const walked = fallback ? await walkedFiles(root, candidates, entries, input.signal) : undefined
  const discovery = walked
    ? {
        method: listed ? "walk-nested-fallback" : "walk",
        candidates: walked.paths.length,
        entries: walked.entries,
        truncated: walked.truncated || Boolean(listed?.truncated),
        unavailable: walked.unavailable,
      }
    : {
        method: listed?.kind ?? "git-root",
        candidates: listed?.paths.length ?? 0,
        entries: listed?.paths.length ?? 0,
        truncated: Boolean(listed?.truncated),
        unavailable: 0,
      }
  const paths = walked?.paths ?? listed?.paths ?? []
  const files: Array<{ path: string; content: string }> = []
  const omitted = {
    aggregate_limit: 0,
    binary: 0,
    enumeration_limit: discovery.truncated ? 1 : 0,
    file_limit: 0,
    invalid_path: 0,
    oversized: 0,
    secret: 0,
    symlink: 0,
    unavailable: discovery.unavailable,
  }
  const size = { total: 0 }

  for (const relative of paths) {
    input.signal?.throwIfAborted()
    const segments = relative.replaceAll("\\", "/").split("/")
    if (segments.some((segment) => skippedDirectories.has(segment))) {
      omitted.invalid_path++
      continue
    }
    if (secret(relative)) {
      omitted.secret++
      continue
    }
    if (files.length >= maxFiles) {
      omitted.file_limit++
      continue
    }
    const target = path.resolve(root, relative)
    if (!within(root, target)) {
      omitted.invalid_path++
      continue
    }
    const stat = await fs.lstat(target).catch(() => undefined)
    if (!stat) {
      omitted.unavailable++
      continue
    }
    if (stat.isSymbolicLink()) {
      omitted.symlink++
      continue
    }
    if (!stat.isFile()) {
      omitted.unavailable++
      continue
    }
    const canonical = await fs.realpath(target).catch(() => undefined)
    if (!canonical || !within(root, canonical)) {
      omitted.invalid_path++
      continue
    }
    if (canonical !== target) {
      omitted.symlink++
      continue
    }
    if (stat.size > maxFileBytes) {
      omitted.oversized++
      continue
    }
    if (size.total + stat.size > maxTotalBytes) {
      omitted.aggregate_limit++
      continue
    }
    const read = await SafeFileIO.read(canonical, { maxBytes: maxFileBytes }).then(
      (snapshot) => ({ snapshot }),
      (error: unknown) => ({ error }),
    )
    if ("error" in read) {
      if (read.error instanceof SafeFileIO.LimitError) omitted.oversized++
      else omitted.unavailable++
      continue
    }
    if (
      read.snapshot.dev !== stat.dev ||
      read.snapshot.ino !== stat.ino ||
      read.snapshot.size !== stat.size ||
      read.snapshot.mtimeMs !== stat.mtimeMs
    ) {
      omitted.unavailable++
      continue
    }
    const after = await Promise.all([fs.lstat(target), fs.realpath(target)]).catch(() => undefined)
    if (!after) {
      omitted.unavailable++
      continue
    }
    if (after[0].isSymbolicLink() || after[1] !== canonical || !within(root, after[1])) {
      omitted.symlink++
      continue
    }
    if (
      !after[0].isFile() ||
      after[0].dev !== read.snapshot.dev ||
      after[0].ino !== read.snapshot.ino ||
      after[0].size !== read.snapshot.size ||
      after[0].mtimeMs !== read.snapshot.mtimeMs
    ) {
      omitted.unavailable++
      continue
    }
    if (binary(read.snapshot.bytes)) {
      omitted.binary++
      continue
    }
    if (size.total + read.snapshot.bytes.length > maxTotalBytes) {
      omitted.aggregate_limit++
      continue
    }
    size.total += read.snapshot.bytes.length
    files.push({
      path: path.relative(root, canonical).split(path.sep).join("/"),
      content: read.snapshot.bytes.toString(),
    })
  }
  if (!files.length) {
    throw new AtlasBrokerError(
      `No indexable text files found under ${input.folder}: ${JSON.stringify({ omitted, discovery })}`,
    )
  }
  lifecycle.transferred = true
  return {
    authorization: approval.authorization,
    authorizationOwnership: approval.authorizationOwnership,
    discovery,
    files,
    omitted,
    root,
    totalBytes: size.total,
    [Symbol.dispose]: release,
  }
}

export async function collectLocalFolder(input: Omit<CollectionInput, "authorization" | "authorizationOwnership">) {
  using result = await collect(input)
  return {
    discovery: result.discovery,
    files: result.files,
    omitted: result.omitted,
    root: result.root,
    totalBytes: result.totalBytes,
  }
}

const query = (values: Record<string, string | number | boolean | undefined>) => {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value))
  }
  const suffix = params.toString()
  return suffix ? `?${suffix}` : ""
}

async function request(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  preflight?: () => Promise<void>,
) {
  const session = await OpenScience.getSession()
  if (!session?.api_key) throw new AtlasBrokerError("Sign in to Gateway before using the host broker.", 401)
  const limit = AbortSignal.timeout(timeout)
  const send = async () => {
    await preflight?.()
    signal?.throwIfAborted()
    return fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${session.api_key}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: signal ? AbortSignal.any([signal, limit]) : limit,
    })
  }
  const response = preflight ? await AuthoritySignal.exclusive(send) : await send()
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new AtlasBrokerError(detail || `Gateway request failed with HTTP ${response.status}`, response.status)
  }
  return response.json() as Promise<unknown>
}

export async function atlasRequest(method: string, path: string, body?: unknown, signal?: AbortSignal) {
  return request(method, path, body, signal)
}

export namespace AtlasBroker {
  export async function run(input: AtlasBrokerInput, signal?: AbortSignal) {
    const incoming = { transferred: false, released: false }
    const release = () => {
      if (!input.authorization || input.authorizationOwnership !== "owned" || incoming.released) return
      incoming.released = true
      SessionFilesystem.releaseAuthorization(input.authorization)
    }
    using cleanup = {
      [Symbol.dispose]() {
        if (!incoming.transferred) release()
      },
    }
    const local = input.operation === "library_add_local" || input.operation === "library_sync_local"
    if (!local && (input.authorization || input.authorizationOwnership)) {
      throw new AtlasBrokerError("filesystem authorization is accepted only for local folder operations")
    }
    if (input.operation === "library_list") {
      return atlasRequest(
        "GET",
        `/api/v1/sources${query({
          type: input.sourceType,
          status: input.sourceStatus,
          limit: input.limit,
          offset: input.offset,
        })}`,
        undefined,
        signal,
      )
    }
    if (input.operation === "library_summary") {
      return atlasRequest("GET", "/api/v1/sources/summary", undefined, signal)
    }
    if (input.operation === "library_show") {
      const source = required(input.sourceID, "source_id")
      return atlasRequest("GET", `/api/v1/sources/${encodeURIComponent(source)}`, undefined, signal)
    }
    if (input.operation === "library_tree") {
      const source = required(input.sourceID, "source_id")
      return atlasRequest(
        "GET",
        `/api/v1/sources/${encodeURIComponent(source)}/tree${query({
          path: input.sourcePath,
          depth: input.depth,
        })}`,
        undefined,
        signal,
      )
    }
    if (input.operation === "library_read") {
      const source = required(input.sourceID, "source_id")
      return atlasRequest(
        "GET",
        `/api/v1/sources/${encodeURIComponent(source)}/content${query({ path: input.sourcePath })}`,
        undefined,
        signal,
      )
    }
    if (input.operation === "library_grep") {
      const source = required(input.sourceID, "source_id")
      const pattern = required(input.pattern, "pattern")
      return atlasRequest(
        "POST",
        `/api/v1/sources/${encodeURIComponent(source)}/grep`,
        { pattern, ...(input.pathPrefix ? { path_prefix: input.pathPrefix } : {}) },
        signal,
      )
    }
    if (input.operation === "library_subscribe") {
      const url = required(input.url, "url")
      return atlasRequest(
        "POST",
        "/api/v1/sources/subscribe",
        {
          url,
          ...(input.sourceType ? { type: input.sourceType } : {}),
          ...(input.displayName ? { display_name: input.displayName } : {}),
        },
        signal,
      )
    }
    if (input.operation === "library_add") {
      const type = required(input.sourceType, "source_type")
      if (!input.url?.trim() && !input.repository?.trim()) {
        throw new AtlasBrokerError("url or repository is required")
      }
      return atlasRequest(
        "POST",
        "/api/v1/sources",
        {
          type,
          ...(input.url?.trim() ? { url: input.url.trim() } : {}),
          ...(input.repository?.trim() ? { repository: input.repository.trim() } : {}),
          ...(input.displayName?.trim() ? { display_name: input.displayName.trim() } : {}),
        },
        signal,
      )
    }
    if (input.operation === "library_add_local" || input.operation === "library_sync_local") {
      const sessionID = required(input.sessionID, "session_id")
      const folder = required(input.folder, "folder")
      incoming.transferred = true
      using collection = await collect({
        sessionID,
        folder,
        authorization: input.authorization,
        authorizationOwnership: input.authorizationOwnership,
        maxFileBytes: input.maxFileBytes,
        maxFiles: input.maxFiles,
        maxTotalBytes: input.maxTotalBytes,
        signal,
      })
      const body =
        input.operation === "library_add_local"
          ? {
              type: "local_folder",
              display_name: input.displayName?.trim() || path.basename(collection.root),
              add_as_global_source: false,
              files: collection.files,
            }
          : { files: collection.files }
      const target =
        input.operation === "library_add_local"
          ? "/api/v1/sources"
          : `/api/v1/sources/${encodeURIComponent(required(input.sourceID, "source_id"))}/sync`
      const result = await request("POST", target, body, signal, async () => {
        await SessionFilesystem.revalidateAuthorization(collection.authorization, {
          path: collection.root,
          access: "read",
        })
      })
      return {
        source: result,
        collection: {
          files: collection.files.length,
          bytes: collection.totalBytes,
          discovery: collection.discovery,
          omitted: collection.omitted,
        },
      }
    }
    if (input.operation === "brief") {
      const project = required(input.project, "project")
      return atlasRequest(
        "GET",
        `/api/v1/projects/${encodeURIComponent(project)}/brief${query({ full: input.full || undefined })}`,
        undefined,
        signal,
      )
    }
    if (input.operation === "node") {
      const node = required(input.node, "node")
      return atlasRequest(
        "GET",
        `/api/v1/nodes/${encodeURIComponent(node)}${query({ projection: input.projection })}`,
        undefined,
        signal,
      )
    }
    if (input.operation === "tree") {
      const node = required(input.node, "node")
      return atlasRequest(
        "GET",
        `/api/v1/nodes/${encodeURIComponent(node)}/tree${query({
          projection: input.projection,
          max_nodes: input.maxNodes,
          max_depth: input.maxDepth,
        })}`,
        undefined,
        signal,
      )
    }
    if (input.operation === "search") {
      const text = required(input.query, "query")
      const sourceIDs = sources(input.sourceIDs)
      const localSourceIDs = sources(input.localSourceIDs)
      return atlasRequest(
        "POST",
        "/api/v1/search",
        {
          query: text,
          ...(input.mode ? { mode: input.mode } : {}),
          ...(input.topK ? { top_k: input.topK } : {}),
          ...(sourceIDs?.length ? { data_sources: sourceIDs } : {}),
          ...(localSourceIDs?.length ? { local_folders: localSourceIDs } : {}),
        },
        signal,
      )
    }
    if (input.operation === "ask") {
      const text = required(input.query, "query")
      const sourceIDs = sources(input.sourceIDs)
      const localSourceIDs = sources(input.localSourceIDs)
      return atlasRequest(
        "POST",
        "/api/v1/documents/ask",
        {
          query: text,
          ...(input.topK ? { top_k: input.topK } : {}),
          ...(sourceIDs?.length ? { source_ids: sourceIDs } : {}),
          ...(localSourceIDs?.length ? { local_folders: localSourceIDs } : {}),
        },
        signal,
      )
    }
    return atlasRequest("GET", "/api/v1/usage/summary", undefined, signal)
  }
}

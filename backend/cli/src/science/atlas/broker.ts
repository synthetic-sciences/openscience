import path from "node:path"
import fs from "node:fs/promises"
import { API_BASE, OpenScience } from "@/openscience"
import { SessionFilesystem } from "@/session/filesystem"

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

async function gitFiles(root: string, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const git = Bun.which("git")
  if (!git) return
  const proc = Bun.spawn([git, "-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    stdout: "pipe",
    stderr: "ignore",
    env: {
      PATH: process.env.PATH ?? "",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  })
  const [text, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
  signal?.throwIfAborted()
  if (code !== 0) return
  return text
    .split("\0")
    .filter(Boolean)
    .toSorted((left, right) => left.localeCompare(right))
}

async function walkedFiles(root: string, signal?: AbortSignal) {
  const files: string[] = []
  const visit = async (relative: string): Promise<void> => {
    signal?.throwIfAborted()
    const entries = await fs.readdir(relative ? path.join(root, relative) : root, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      signal?.throwIfAborted()
      const child = relative ? path.join(relative, entry.name) : entry.name
      if (entry.isDirectory()) {
        if (!skippedDirectories.has(entry.name)) await visit(child)
        continue
      }
      files.push(child)
    }
  }
  await visit("")
  return files
}

export async function collectLocalFolder(input: {
  sessionID: string
  folder: string
  maxFileBytes?: number
  maxFiles?: number
  maxTotalBytes?: number
  signal?: AbortSignal
}) {
  input.signal?.throwIfAborted()
  const authorized = await SessionFilesystem.authorize({
    sessionID: input.sessionID,
    path: input.folder,
    access: "read",
  })
  const root = await fs.realpath(authorized.path)
  const rootStat = await fs.lstat(root)
  if (!rootStat.isDirectory()) throw new AtlasBrokerError(`not a directory: ${input.folder}`)

  const maxFileBytes = bounded(input.maxFileBytes, DEFAULT_FILE_BYTES, MAX_FILE_BYTES, "max_file_bytes")
  const maxFiles = bounded(input.maxFiles, DEFAULT_FILES, MAX_FILES, "max_files")
  const maxTotalBytes = bounded(input.maxTotalBytes, DEFAULT_TOTAL_BYTES, MAX_TOTAL_BYTES, "max_total_bytes")
  const listed = await gitFiles(root, input.signal)
  const paths = listed ?? (await walkedFiles(root, input.signal))
  const files: Array<{ path: string; content: string }> = []
  const omitted = {
    aggregate_limit: 0,
    binary: 0,
    file_limit: 0,
    invalid_path: 0,
    oversized: 0,
    secret: 0,
    symlink: 0,
    unavailable: 0,
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
    if (stat.size > maxFileBytes) {
      omitted.oversized++
      continue
    }
    const bytes = await Bun.file(canonical).bytes()
    if (binary(bytes)) {
      omitted.binary++
      continue
    }
    if (size.total + bytes.length > maxTotalBytes) {
      omitted.aggregate_limit++
      continue
    }
    size.total += bytes.length
    files.push({
      path: path.relative(root, canonical).split(path.sep).join("/"),
      content: Buffer.from(bytes).toString(),
    })
  }
  if (!files.length) {
    throw new AtlasBrokerError(`No indexable text files found under ${input.folder}: ${JSON.stringify(omitted)}`)
  }
  return { files, omitted, root, totalBytes: size.total }
}

const query = (values: Record<string, string | number | boolean | undefined>) => {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined) params.set(key, String(value))
  }
  const suffix = params.toString()
  return suffix ? `?${suffix}` : ""
}

export async function atlasRequest(method: string, path: string, body?: unknown, signal?: AbortSignal) {
  const session = await OpenScience.getSession()
  if (!session?.api_key) throw new AtlasBrokerError("Sign in to Gateway before using the host broker.", 401)
  const limit = AbortSignal.timeout(timeout)
  const response = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${session.api_key}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, limit]) : limit,
  })
  if (!response.ok) {
    const detail = await response.text().catch(() => "")
    throw new AtlasBrokerError(detail || `Gateway request failed with HTTP ${response.status}`, response.status)
  }
  return response.json() as Promise<unknown>
}

export namespace AtlasBroker {
  export async function run(input: AtlasBrokerInput, signal?: AbortSignal) {
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
      const collection = await collectLocalFolder({
        sessionID,
        folder,
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
      const result = await atlasRequest("POST", target, body, signal)
      return {
        source: result,
        collection: {
          files: collection.files.length,
          bytes: collection.totalBytes,
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

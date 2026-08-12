/**
 * Local, content-addressed provenance DAG.
 *
 * Records the lineage of a scientific investigation: which artifacts (files,
 * datasets, figures) were produced by which runs (tool/kernel executions),
 * from which inputs. Nodes are content-addressed (id = sha256 of canonical
 * payload) so identical content dedupes and lineage is verifiable.
 *
 * Persistence: a single JSON file under the app data dir. Small-scale by design
 * — this is a research notebook's audit trail, not a production graph DB.
 */
import path from "path"
import fs from "node:fs/promises"
import { realpathSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { Global } from "@/global"
import { FileLease } from "@/util/file-lease"
import { OpenScience } from "@/openscience"
import { ProjectLegacy } from "@/project/legacy"
import type { ProvenanceEnvelope } from "./envelope"

export type NodeKind = "artifact" | "run" | "source" | "claim"

/** Base fields shared by every node. */
export interface NodeBase {
  /** Content-addressed id (sha256 hex, 16-char prefix) unless caller supplies one. */
  id: string
  kind: NodeKind
  /** Human label. */
  label: string
  /** ISO timestamp the node was recorded. */
  recordedAt: string
  /** Arbitrary structured metadata. */
  meta?: Record<string, unknown>
}

/** A produced/consumed data artifact (file, dataset, figure, model, ...). */
export interface Artifact extends NodeBase {
  kind: "artifact"
  /** Artifact type discriminator, e.g. "dataset" | "figure" | "model" | "report". */
  artifactType: string
  /** On-disk path if materialized. */
  path?: string
  /** Content hash of the artifact bytes (may differ from node id). */
  contentHash?: string
  /** Byte size if known. */
  size?: number
  /** Portable, versioned facts for the exact immutable artifact bytes. */
  provenance?: ProvenanceEnvelope.Schema
}

/** A run: a tool/kernel/agent execution that consumes inputs and emits outputs. */
export interface Run extends NodeBase {
  kind: "run"
  /** Tool/kernel/command that executed, e.g. "notebook", "science_search". */
  tool: string
  /** Session this run belongs to. */
  sessionID?: string
  /** Serialized inputs (params) for reproducibility. */
  inputs?: Record<string, unknown>
  /** Exit status. */
  status?: "ok" | "error"
  /** Portable, versioned execution facts used by local artifacts and Atlas handoff. */
  provenance?: ProvenanceEnvelope.Schema
}

export type Node = Artifact | Run | NodeBase

export type EdgeRelation = "produced" | "consumed" | "derived-from" | "supports" | "refutes"

/** A directed, typed edge between two nodes. */
export interface Edge {
  from: string
  to: string
  relation: EdgeRelation
  meta?: Record<string, unknown>
}

export interface ProjectScope {
  projectID: string
  directory: string
}

interface ResolvedScope extends ProjectScope {
  ids: Set<string>
}

type NodeInput = Omit<Node, "id" | "recordedAt"> & { id?: string }

interface Graph {
  version: 1
  nodes: Record<string, Node>
  edges: Edge[]
}

const STORE_PATH = path.join(Global.Path.data, "provenance", "graph.json")
const lock = { current: Promise.resolve() as Promise<unknown> }

export class ProvenanceCorruptError extends Error {
  constructor(
    readonly filepath: string,
    readonly backup?: string,
    cause?: unknown,
  ) {
    super(
      backup
        ? `Provenance graph ${filepath} is corrupt. Refusing to overwrite it; the unmodified bytes were backed up to ${backup}.`
        : `Provenance graph ${filepath} is corrupt and cannot be read. Repair or remove it before continuing.`,
      cause === undefined ? undefined : { cause },
    )
    this.name = "ProvenanceCorruptError"
  }
}

async function sha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

/** Deterministic content id from a node's identifying payload. */
export async function contentId(payload: unknown): Promise<string> {
  const canonical = JSON.stringify(stable(payload))
  return (await sha256(canonical)).slice(0, 16)
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .toSorted(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => [key, stable(item)]),
  )
}

async function load(): Promise<Graph> {
  await OpenScience.refreshByokSecrets()
  const file = Bun.file(STORE_PATH)
  if (!(await file.exists())) return { version: 1, nodes: {}, edges: [] }
  const value = await file.json().catch((error) => {
    throw new ProvenanceCorruptError(STORE_PATH, undefined, error)
  })
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProvenanceCorruptError(STORE_PATH)
  }
  const record = value as Record<string, unknown>
  if (
    record.version !== 1 ||
    !record.nodes ||
    typeof record.nodes !== "object" ||
    Array.isArray(record.nodes) ||
    !Array.isArray(record.edges)
  ) {
    throw new ProvenanceCorruptError(STORE_PATH)
  }
  for (const [id, node] of Object.entries(record.nodes as Record<string, unknown>)) {
    if (!node || typeof node !== "object" || Array.isArray(node)) throw new ProvenanceCorruptError(STORE_PATH)
    const item = node as Record<string, unknown>
    if (
      item.id !== id ||
      !["artifact", "run", "source", "claim"].includes(String(item.kind)) ||
      typeof item.label !== "string" ||
      typeof item.recordedAt !== "string"
    ) {
      throw new ProvenanceCorruptError(STORE_PATH)
    }
  }
  for (const edge of record.edges) {
    if (!edge || typeof edge !== "object" || Array.isArray(edge)) throw new ProvenanceCorruptError(STORE_PATH)
    const item = edge as Record<string, unknown>
    if (
      typeof item.from !== "string" ||
      typeof item.to !== "string" ||
      !["produced", "consumed", "derived-from", "supports", "refutes"].includes(String(item.relation))
    ) {
      throw new ProvenanceCorruptError(STORE_PATH)
    }
  }
  return OpenScience.redactSensitive(value as Graph)
}

async function save(graph: Graph): Promise<void> {
  const folder = path.dirname(STORE_PATH)
  const temp = `${STORE_PATH}.${process.pid}.${randomUUID()}.tmp`
  const clean = OpenScience.redactSensitive(graph)
  await fs.mkdir(folder, { recursive: true })
  await (async () => {
    const file = await fs.open(temp, "wx", 0o600)
    await file
      .writeFile(JSON.stringify(clean, null, 2), "utf8")
      .then(() => file.sync())
      .finally(() => file.close())
    await fs.rename(temp, STORE_PATH)
    const directory = await fs.open(folder, "r").catch(() => undefined)
    await directory?.sync().catch(() => undefined)
    await directory?.close().catch(() => undefined)
  })().catch(async (error) => {
    await fs.unlink(temp).catch(() => undefined)
    throw error
  })
}

async function preserve(error: unknown): Promise<never> {
  if (!(error instanceof ProvenanceCorruptError)) throw error
  const backup = `${STORE_PATH}.corrupt-${process.pid}`
  const preserved = await fs
    .copyFile(STORE_PATH, backup)
    .then(() => fs.chmod(backup, 0o600))
    .then(() => backup)
    .catch(() => undefined)
  throw new ProvenanceCorruptError(STORE_PATH, preserved, error)
}

async function mutate<T>(fn: (graph: Graph) => Promise<T> | T): Promise<T> {
  const task = lock.current
    .catch(() => undefined)
    .then(async () => {
      await using lease = await FileLease.acquire(`${STORE_PATH}.lock`, 120_000)
      const graph = await load().catch(preserve)
      const result = await fn(graph)
      await save(graph)
      return result
    })
  lock.current = task
  return task
}

function canonical(input: string) {
  const resolved = path.resolve(input)
  const real = (() => {
    try {
      return realpathSync(resolved)
    } catch {
      return resolved
    }
  })()
  if (real.length > 1 && real.endsWith(path.sep)) return real.slice(0, -1)
  return real
}

function scoped(input: ProjectScope): ProjectScope {
  const projectID = input.projectID.trim()
  if (!projectID) throw new Error("A provenance project ID is required")
  return {
    projectID,
    directory: canonical(input.directory),
  }
}

async function resolve(input: ProjectScope): Promise<ResolvedScope> {
  const scope = scoped(input)
  return {
    ...scope,
    ids: new Set([scope.projectID, ...(await ProjectLegacy.ids(scope.projectID))]),
  }
}

function projects(node: Node) {
  const ids = new Set<string>()
  const metadata = node.meta?.projectID
  if (typeof metadata === "string" && metadata.trim()) ids.add(metadata.trim())
  if ("provenance" in node) {
    const identity = node.provenance?.identity.project_id
    if (identity?.status === "available" && identity.value.trim()) ids.add(identity.value.trim())
  }
  return ids
}

function own(node: Node, projectID: string): Node {
  const provenance = "provenance" in node ? node.provenance : undefined
  const identity = provenance?.identity.project_id
  return {
    ...node,
    meta: {
      ...node.meta,
      projectID,
    },
    ...(provenance && identity?.status === "available"
      ? {
          provenance: {
            ...provenance,
            identity: {
              ...provenance.identity,
              project_id: {
                ...identity,
                value: projectID,
              },
            },
          },
        }
      : {}),
  } as Node
}

function belongs(node: Node, directory: string): boolean {
  const root = canonical(directory)
  const nodeDirectory = node.meta?.directory
  if (typeof nodeDirectory === "string") return canonical(nodeDirectory) === root
  if (node.kind !== "artifact" || !("path" in node) || !node.path || !path.isAbsolute(node.path)) return false
  const relative = path.relative(root, canonical(node.path))
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function visible(node: Node, input: ProjectScope) {
  const owners = projects(node)
  if (owners.size) return owners.size === 1 && owners.has(input.projectID)
  return belongs(node, input.directory)
}

function select(graph: Graph, input: ProjectScope) {
  const scope = scoped(input)
  const nodes = Object.values(graph.nodes).filter((node) => visible(node, scope))
  const ids = new Set(nodes.map((node) => node.id))
  return {
    nodes,
    edges: graph.edges.filter((edge) => ids.has(edge.from) && ids.has(edge.to)),
  }
}

function rewrite(previous: Node | undefined, next: Node): Node {
  if (!previous) return next
  const before = projects(previous)
  const after = projects(next)
  if (before.size > 1 || after.size > 1) {
    throw new Error(`Provenance node ${next.id} has conflicting project ownership`)
  }
  const current = [...before][0]
  const incoming = [...after][0]
  if (current && incoming && current !== incoming) {
    throw new Error(`Provenance node ${next.id} belongs to another project`)
  }
  if (current && !incoming) {
    return {
      ...next,
      meta: {
        ...next.meta,
        projectID: current,
      },
    } as Node
  }
  if (!current && incoming) {
    const directory = next.meta?.directory
    if (typeof directory !== "string" || !belongs(previous, directory)) {
      throw new Error(`Legacy provenance node ${next.id} cannot be adopted from another directory`)
    }
  }
  return next
}

function adopt(node: Node, input: ResolvedScope) {
  const owners = projects(node)
  if (owners.size) {
    if ([...owners].every((projectID) => input.ids.has(projectID))) {
      if (owners.size === 1 && owners.has(input.projectID)) return node
      return own(node, input.projectID)
    }
    throw new Error(`Provenance node ${node.id} belongs to another project`)
  }
  if (!belongs(node, input.directory)) {
    throw new Error(`Legacy provenance node ${node.id} cannot be adopted from another directory`)
  }
  return own(node, input.projectID)
}

function migratable(node: Node, input: ResolvedScope) {
  const owners = projects(node)
  return (
    owners.size > 0 &&
    [...owners].every((projectID) => input.ids.has(projectID)) &&
    !(owners.size === 1 && owners.has(input.projectID))
  )
}

function migrate(graph: Graph, input: ResolvedScope) {
  for (const node of Object.values(graph.nodes)) {
    if (!migratable(node, input)) continue
    graph.nodes[node.id] = own(node, input.projectID)
  }
}

async function owned(input: ProjectScope) {
  const scope = await resolve(input)
  const graph = await load()
  if (!Object.values(graph.nodes).some((node) => migratable(node, scope))) {
    return { graph, scope }
  }
  return {
    graph: await mutate((current) => {
      migrate(current, scope)
      return current
    }),
    scope,
  }
}

export namespace Provenance {
  /** Record a node. If `id` is omitted it is content-addressed from the node body. */
  export async function record(node: NodeInput): Promise<Node> {
    return write(undefined, node)
  }

  /** Record a node under an explicit canonical project scope. */
  export async function recordOwned(input: ProjectScope, node: NodeInput): Promise<Node> {
    return write(await resolve(input), node)
  }

  async function write(scope: ResolvedScope | undefined, node: NodeInput): Promise<Node> {
    return mutate(async (graph) => {
      const clean = OpenScience.redactSensitive(
        scope
          ? {
              ...node,
              meta: {
                ...node.meta,
                directory: scope.directory,
                projectID: scope.projectID,
              },
            }
          : node,
      )
      const recordedAt = new Date().toISOString()
      const id = clean.id ?? (await contentId({ ...clean }))
      const previous = scope && graph.nodes[id] ? adopt(graph.nodes[id], scope) : graph.nodes[id]
      const candidate = { ...clean, id, recordedAt } as Node
      const full = rewrite(previous, scope ? adopt(candidate, scope) : candidate)
      graph.nodes[id] = full
      return full
    })
  }

  /** Link two existing nodes with a typed edge. */
  export async function link(edge: Edge): Promise<Edge> {
    return connect(undefined, edge)
  }

  /** Link project-owned nodes, adopting visible legacy directory nodes once. */
  export async function linkOwned(input: ProjectScope, edge: Edge): Promise<Edge> {
    return connect(await resolve(input), edge)
  }

  async function connect(scope: ResolvedScope | undefined, edge: Edge): Promise<Edge> {
    return mutate(async (graph) => {
      const clean = OpenScience.redactSensitive(edge)
      const source = graph.nodes[clean.from]
      const target = graph.nodes[clean.to]
      if (!source) throw new Error(`Provenance node ${clean.from} was not found`)
      if (!target) throw new Error(`Provenance node ${clean.to} was not found`)
      const from = scope ? adopt(source, scope) : source
      const to = scope ? adopt(target, scope) : target
      const sources = projects(from)
      const targets = projects(to)
      if (
        sources.size > 1 ||
        targets.size > 1 ||
        (sources.size === 1 && targets.size === 1 && [...sources][0] !== [...targets][0])
      ) {
        throw new Error("Provenance nodes from different projects cannot be linked")
      }
      graph.nodes[from.id] = from
      graph.nodes[to.id] = to
      const exists = graph.edges.some(
        (item) => item.from === clean.from && item.to === clean.to && item.relation === clean.relation,
      )
      if (!exists) graph.edges.push(clean)
      return clean
    })
  }

  /** Fetch a single node by id. */
  export async function get(id: string): Promise<Node | undefined> {
    const graph = await load()
    return graph.nodes[id]
  }

  /** Fetch a node only when its canonical project owns it (legacy directory fallback included). */
  export async function find(input: ProjectScope, id: string): Promise<Node | undefined> {
    const result = await owned(input)
    const node = result.graph.nodes[id]
    if (!node || !visible(node, result.scope)) return
    return node
  }

  /**
   * Query project lineage. Without `id`, returns the project graph. With `id`,
   * returns the node plus its connected project-owned lineage.
   */
  export async function query(input: ProjectScope, id?: string): Promise<{ nodes: Node[]; edges: Edge[] }> {
    const result = await owned(input)
    const graph = select(result.graph, result.scope)
    if (!id) return graph
    if (!graph.nodes.some((node) => node.id === id)) return { nodes: [], edges: [] }

    const seen = new Set<string>()
    const stack = [id]
    const edges: Edge[] = []
    while (stack.length) {
      const cur = stack.pop()!
      if (seen.has(cur)) continue
      seen.add(cur)
      for (const e of graph.edges) {
        if (e.to === cur || e.from === cur) {
          edges.push(e)
          const next = e.to === cur ? e.from : e.to
          if (!seen.has(next)) stack.push(next)
        }
      }
    }
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]))
    return {
      nodes: [...seen].map((node) => nodes.get(node)).filter((node): node is Node => Boolean(node)),
      edges,
    }
  }

  /** List all recorded nodes. */
  export async function list(): Promise<Node[]> {
    const graph = await load()
    return Object.values(graph.nodes)
  }

  /** Return only nodes owned by a canonical project, with directory fallback for legacy nodes. */
  export async function project(input: ProjectScope): Promise<{ nodes: Node[]; edges: Edge[] }> {
    const result = await owned(input)
    return select(result.graph, result.scope)
  }

  export const path_ = STORE_PATH
}

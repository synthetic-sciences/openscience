import { createStore } from "solid-js/store"
import type { ArtifactKind } from "./model"
import type { ArtifactInspection } from "@/science/renderers"
import { defaultWorkspaceScope, projectScope, workspaceScope } from "@/atlas/store/scope"

export type ArtifactContextKind = ArtifactKind | "file"

export interface ArtifactContext {
  id: string
  directory: string
  path: string
  name: string
  format: string
  kind: ArtifactContextKind
  scienceKind?: string
  inspection?: ArtifactInspection
}

export interface ArtifactContextInput {
  directory: string
  path: string
  format?: string
  scienceKind?: string
  inspection?: ArtifactInspection
}

export interface ArtifactStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

interface PersistedArtifacts {
  version: 1
  scopes: Record<string, ArtifactContext | undefined>
}

const STORAGE_KEY = "openscience-artifact-context-v1"

const kinds: Partial<Record<string, ArtifactContextKind>> = {
  csv: "dataset",
  tsv: "dataset",
  jsonl: "dataset",
  parquet: "dataset",
  arrow: "dataset",
  feather: "dataset",
  h5: "dataset",
  hdf5: "dataset",
  h5ad: "dataset",
  loom: "dataset",
  zarr: "dataset",
  png: "figure",
  jpg: "figure",
  jpeg: "figure",
  gif: "figure",
  webp: "figure",
  bmp: "figure",
  svg: "figure",
  pdf: "report",
  md: "report",
  markdown: "report",
  mdx: "report",
  tex: "report",
  latex: "report",
  docx: "report",
  pptx: "report",
  pdb: "structure",
  ent: "structure",
  cif: "structure",
  mmcif: "structure",
  bcif: "structure",
  pdbqt: "structure",
  gro: "structure",
  xyz: "structure",
  sdf: "structure",
  mol: "structure",
  mol2: "structure",
  smi: "structure",
  smiles: "structure",
  fa: "sequence",
  fasta: "sequence",
  faa: "sequence",
  fna: "sequence",
  ffn: "sequence",
  frn: "sequence",
  aln: "sequence",
  clustal: "sequence",
  bam: "genomics",
  cram: "genomics",
  sam: "genomics",
  vcf: "genomics",
  bcf: "genomics",
  bed: "genomics",
  gff: "genomics",
  gff3: "genomics",
  gtf: "genomics",
  bigwig: "genomics",
  bw: "genomics",
  bigbed: "genomics",
  mzml: "spectrum",
  mzxml: "spectrum",
  mgf: "spectrum",
  msp: "spectrum",
  onnx: "model",
  pt: "model",
  pth: "model",
  safetensors: "model",
  pkl: "model",
  joblib: "model",
  zip: "archive",
  tar: "archive",
  tgz: "archive",
  gz: "archive",
  bz2: "archive",
  xz: "archive",
  "7z": "archive",
}

const science: Partial<Record<string, ArtifactContextKind>> = {
  "protein-structure": "structure",
  "chem-2d": "structure",
  "chem-3d": "structure",
  sequence: "sequence",
  msa: "sequence",
  "genome-track": "genomics",
  pdf: "report",
  latex: "report",
}

function cleanDirectory(value: string): string {
  const next = value.replaceAll("\\", "/").replace(/\/+$/, "")
  return next || "/"
}

function cleanPath(value: string): string {
  return value
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+/g, "/")
}

function extension(value: string): string {
  const name = cleanPath(value).split("/").pop() ?? ""
  const index = name.lastIndexOf(".")
  return index > 0 ? name.slice(index + 1).toLowerCase() : ""
}

/** Resolve a persisted project-relative tab path for session-authorized I/O. */
export function resolveArtifactPath(directory: string, value: string): string {
  const file = cleanPath(value)
  if (file.startsWith("/") || /^[A-Za-z]:\//.test(file)) return file
  const root = cleanDirectory(directory)
  return root === "/" ? `/${file}` : `${root}/${file}`
}

export function inferArtifactKind(path: string, scienceKind?: string): ArtifactContextKind {
  if (scienceKind && science[scienceKind]) return science[scienceKind]
  return kinds[extension(path)] ?? "file"
}

export function createArtifactContext(input: ArtifactContextInput): ArtifactContext {
  const directory = cleanDirectory(input.directory)
  const path = cleanPath(input.path)
  const name = path.split("/").pop() || path
  const format = (input.format ?? extension(path)).replace(/^\./, "").toLowerCase()
  return {
    id: `artifact:${encodeURIComponent(directory)}::${encodeURIComponent(path)}`,
    directory,
    path,
    name,
    format,
    kind: inferArtifactKind(path, input.scienceKind),
    ...(input.scienceKind ? { scienceKind: input.scienceKind } : {}),
    ...(input.inspection ? { inspection: input.inspection } : {}),
  }
}

export function clearOwnedArtifact(current: ArtifactContext | undefined, owner: string): ArtifactContext | undefined {
  if (current?.id === owner) return
  return current
}

function record(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return
  return value as Record<string, unknown>
}

function restoreArtifact(value: unknown) {
  const row = record(value)
  if (!row || typeof row.directory !== "string" || typeof row.path !== "string") return
  return createArtifactContext({
    directory: row.directory,
    path: row.path,
    format: typeof row.format === "string" ? row.format : undefined,
    scienceKind: typeof row.scienceKind === "string" ? row.scienceKind : undefined,
  })
}

function restore(storage: ArtifactStorage | undefined) {
  if (!storage) return {}
  const raw = (() => {
    try {
      return storage.getItem(STORAGE_KEY)
    } catch {
      return null
    }
  })()
  if (!raw) return {}
  const parsed = (() => {
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return
    }
  })()
  const root = record(parsed)
  const scopes = record(root?.scopes)
  if (root?.version !== 1 || !scopes) return {}
  return Object.fromEntries(Object.entries(scopes).map(([scope, value]) => [scope, restoreArtifact(value)]))
}

function browserStorage(): ArtifactStorage | undefined {
  if (typeof localStorage === "undefined") return
  return localStorage
}

export function createArtifactState(options: { storage?: ArtifactStorage } = {}) {
  const storage = options.storage ?? browserStorage()
  const [store, setStore] = createStore({
    scope: defaultWorkspaceScope(),
    scopes: restore(storage) as Record<string, ArtifactContext | undefined>,
  })

  const persist = () => {
    if (!storage) return
    try {
      const scopes = Object.fromEntries(
        Object.entries(store.scopes).map(([scope, value]) => [
          scope,
          value
            ? {
                ...value,
                inspection: undefined,
              }
            : undefined,
        ]),
      )
      storage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          version: 1,
          scopes,
        } satisfies PersistedArtifacts),
      )
    } catch {}
  }

  const active = () => store.scopes[store.scope]
  const update = (value: ArtifactContext | undefined) => {
    setStore("scopes", store.scope, value)
    persist()
  }

  return {
    scope: () => store.scope,
    activateScope(project: string, session: string) {
      const scope = projectScope(project)
      const legacy = workspaceScope(project, session)
      if (!store.scopes[scope] && store.scopes[legacy]) {
        setStore("scopes", scope, store.scopes[legacy])
        persist()
      }
      setStore("scope", scope)
    },
    active,
    activate(value: ArtifactContext) {
      update(value)
    },
    clear(owner: string) {
      update(clearOwnedArtifact(active(), owner))
    },
  }
}

export const artifactContext = createArtifactState()

/**
 * File-tree state per project.
 *
 * Built from either a FileSystemDirectoryHandle (Chrome / Edge / Brave / Arc)
 * or a FileList from an <input type="file" webkitdirectory> (Safari /
 * Firefox fallback). Either way we only keep a lightweight tree of
 * { name, path, kind, size, ext } in memory — the underlying File or
 * directory handle is held separately and cleared on reload, since it
 * can't be persisted into localStorage.
 */

import { createSignal, createEffect } from "solid-js"
import { projectsStore } from "@/thesis/store/projects"

export type FileKind = "file" | "dir"

export interface FileNode {
  name: string
  path: string // path within the project, e.g. "src/main.ts"
  kind: FileKind
  size?: number
  ext?: string
  children?: FileNode[]
}

const STORAGE_KEY = "thesis-files-v1"

interface ProjectFiles {
  project_id: string
  // tree size cap so localStorage doesn't blow up for large repos
  truncated?: boolean
  total_files: number
  total_dirs: number
  root: FileNode[]
}

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".cache",
  "dist",
  "build",
  ".DS_Store",
  ".idea",
  ".vscode",
])

const MAX_NODES = 8000
const MAX_DEPTH = 12

function readAll(): Record<string, ProjectFiles> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return {}
    return JSON.parse(raw) ?? {}
  } catch {
    return {}
  }
}

function writeAll(map: Record<string, ProjectFiles>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(map))
  } catch {}
}

const [byProject, setByProject] = createSignal<Record<string, ProjectFiles>>(readAll())

createEffect(() => writeAll(byProject()))

const getExt = (name: string): string | undefined => {
  const i = name.lastIndexOf(".")
  if (i <= 0) return undefined
  return name.slice(i + 1).toLowerCase()
}

const sortChildren = (a: FileNode, b: FileNode): number => {
  if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1
  return a.name.localeCompare(b.name)
}

/** Build a tree from a FileSystemDirectoryHandle (Chromium browsers). */
async function walkHandle(
  dir: any,
  pathPrefix: string,
  depth: number,
  budget: { remaining: number; truncated: boolean },
): Promise<FileNode[]> {
  if (depth > MAX_DEPTH || budget.remaining <= 0) {
    budget.truncated = true
    return []
  }
  const out: FileNode[] = []
  try {
    for await (const [name, child] of (dir as any).entries() as AsyncIterable<[string, any]>) {
      if (SKIP_DIRS.has(name)) continue
      if (budget.remaining <= 0) {
        budget.truncated = true
        break
      }
      budget.remaining -= 1
      const path = pathPrefix ? `${pathPrefix}/${name}` : name
      if (child.kind === "directory") {
        const children = await walkHandle(child, path, depth + 1, budget)
        out.push({ name, path, kind: "dir", children })
      } else {
        let size: number | undefined
        try {
          const file = await child.getFile()
          size = file.size
        } catch {}
        out.push({ name, path, kind: "file", size, ext: getExt(name) })
      }
    }
  } catch {}
  out.sort(sortChildren)
  return out
}

/** Build a tree from a FileList (input type=file webkitdirectory). */
function walkFileList(files: FileList): {
  root: FileNode[]
  total_files: number
  total_dirs: number
  truncated: boolean
} {
  const total_files = Math.min(files.length, MAX_NODES)
  let total_dirs = 0
  const truncated = files.length > MAX_NODES

  // Build a nested map first.
  type DirMap = { dirs: Map<string, DirMap>; files: { name: string; size: number }[] }
  const root: DirMap = { dirs: new Map(), files: [] }

  for (let i = 0; i < total_files; i++) {
    const f = files[i]
    const rel = (f as any).webkitRelativePath as string
    if (!rel) continue
    const parts = rel.split("/")
    if (parts.length === 0) continue
    // parts[0] is the project folder name; skip it
    const inner = parts.slice(1)
    if (inner.some((p) => SKIP_DIRS.has(p))) continue
    if (inner.length === 0) {
      root.files.push({ name: f.name, size: f.size })
      continue
    }
    let cur = root
    for (let d = 0; d < inner.length - 1; d++) {
      const seg = inner[d]
      let next = cur.dirs.get(seg)
      if (!next) {
        next = { dirs: new Map(), files: [] }
        cur.dirs.set(seg, next)
        total_dirs += 1
      }
      cur = next
    }
    cur.files.push({ name: inner[inner.length - 1], size: f.size })
  }

  // Convert nested maps to FileNode arrays.
  const toNodes = (map: DirMap, pathPrefix: string): FileNode[] => {
    const out: FileNode[] = []
    for (const [name, sub] of map.dirs) {
      const path = pathPrefix ? `${pathPrefix}/${name}` : name
      out.push({ name, path, kind: "dir", children: toNodes(sub, path) })
    }
    for (const f of map.files) {
      const path = pathPrefix ? `${pathPrefix}/${f.name}` : f.name
      out.push({ name: f.name, path, kind: "file", size: f.size, ext: getExt(f.name) })
    }
    out.sort(sortChildren)
    return out
  }

  return { root: toNodes(root, ""), total_files, total_dirs, truncated }
}

export const filesStore = {
  forProject(projectId: string): ProjectFiles | null {
    return byProject()[projectId] ?? null
  },

  async setFromHandle(projectId: string, handle: any) {
    const budget = { remaining: MAX_NODES, truncated: false }
    const root = await walkHandle(handle, "", 0, budget)
    const counted = countTree(root)
    const next: ProjectFiles = {
      project_id: projectId,
      truncated: budget.truncated,
      total_files: counted.files,
      total_dirs: counted.dirs,
      root,
    }
    setByProject((prev) => ({ ...prev, [projectId]: next }))
  },

  setFromFileList(projectId: string, files: FileList) {
    const built = walkFileList(files)
    const counted = countTree(built.root)
    const next: ProjectFiles = {
      project_id: projectId,
      truncated: built.truncated,
      total_files: counted.files,
      total_dirs: counted.dirs,
      root: built.root,
    }
    setByProject((prev) => ({ ...prev, [projectId]: next }))
  },

  clear(projectId: string) {
    setByProject((prev) => {
      const { [projectId]: _, ...rest } = prev
      return rest
    })
  },

  ofActive(): ProjectFiles | null {
    const id = projectsStore.activeId()
    if (!id) return null
    return byProject()[id] ?? null
  },
}

function countTree(nodes: FileNode[]): { files: number; dirs: number } {
  let files = 0
  let dirs = 0
  const walk = (ns: FileNode[]) => {
    for (const n of ns) {
      if (n.kind === "dir") {
        dirs++
        if (n.children) walk(n.children)
      } else {
        files++
      }
    }
  }
  walk(nodes)
  return { files, dirs }
}

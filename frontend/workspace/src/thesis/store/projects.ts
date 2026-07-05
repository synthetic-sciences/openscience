import { createSignal, createEffect } from "solid-js"

export interface Project {
  id: string
  name: string
  path: string
  created_at: string
  last_opened_at: string
  session_count: number
}

const STORAGE_KEY = "thesis-projects-v1"
const ACTIVE_KEY = "thesis-active-project-v1"

function readProjects(): Project[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    return Array.isArray(arr) ? arr : []
  } catch {
    return []
  }
}

function writeProjects(list: Project[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list))
  } catch {}
}

const [projects, setProjects] = createSignal<Project[]>(readProjects())
const [activeId, setActiveId] = createSignal<string | null>(localStorage.getItem(ACTIVE_KEY))

createEffect(() => writeProjects(projects()))
createEffect(() => {
  const id = activeId()
  try {
    if (id) localStorage.setItem(ACTIVE_KEY, id)
    else localStorage.removeItem(ACTIVE_KEY)
  } catch {}
})

const create = (input: { name: string; path: string }): Project => {
  const project: Project = {
    id: `proj-${Math.random().toString(36).slice(2, 14)}`,
    name: input.name,
    path: input.path,
    created_at: new Date().toISOString(),
    last_opened_at: new Date().toISOString(),
    session_count: 0,
  }
  setProjects((prev) => [project, ...prev])
  return project
}

const open = (id: string) => {
  setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, last_opened_at: new Date().toISOString() } : p)))
  setActiveId(id)
}

const close = () => setActiveId(null)

const remove = (id: string) => {
  setProjects((prev) => prev.filter((p) => p.id !== id))
  if (activeId() === id) setActiveId(null)
}

const update = (id: string, patch: Partial<Project>) => {
  setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, ...patch } : p)))
}

const incrementSessionCount = (id: string) => {
  setProjects((prev) => prev.map((p) => (p.id === id ? { ...p, session_count: p.session_count + 1 } : p)))
}

export const projectsStore = {
  list: projects,
  activeId,
  active: () => projects().find((p) => p.id === activeId()) ?? null,
  create,
  open,
  close,
  remove,
  update,
  incrementSessionCount,
  setActiveId,
}

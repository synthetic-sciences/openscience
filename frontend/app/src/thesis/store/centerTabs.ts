import { createSignal } from "solid-js"

/**
 * Center-pane tab model. The center area is a tab strip:
 *   - "chat"  — the (non-closable) session / work-item view
 *   - "files" — the host file explorer
 *   - one tab per opened document (a real file, rendered inline)
 *
 * Opening a file from the explorer spawns (or focuses) a document tab; the
 * document is addressed by its host directory + relative path so the same
 * renderer path (FileView → sdk.client.file.read) works for any host file.
 */
export interface DocTab {
  id: string
  directory: string
  path: string
  name: string
}

export type CenterTab = "chat" | "files" | (string & {})

const docId = (directory: string, path: string) => `doc:${directory}::${path}`

const [active, setActive] = createSignal<CenterTab>("chat")
const [docs, setDocs] = createSignal<DocTab[]>([])

function openFile(directory: string, path: string) {
  const name = path.split("/").pop() || path
  const id = docId(directory, path)
  setDocs((prev) => (prev.some((d) => d.id === id) ? prev : [...prev, { id, directory, path, name }]))
  setActive(id)
}

function closeDoc(id: string) {
  const list = docs()
  const idx = list.findIndex((d) => d.id === id)
  const next = list.filter((d) => d.id !== id)
  setDocs(next)
  if (active() === id) {
    // Focus the left neighbour, else the last remaining doc, else Files.
    const neighbour = next[idx - 1] ?? next[idx] ?? next[next.length - 1]
    setActive(neighbour ? neighbour.id : "files")
  }
}

export const centerTabs = {
  active,
  setActive,
  docs,
  openFile,
  closeDoc,
  showFiles: () => setActive("files"),
  showChat: () => setActive("chat"),
}

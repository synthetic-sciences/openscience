export const MIN_PANE_WIDTH = 320
export const DEFAULT_PANE_WIDTH = 400
export const INLINE_PANE_BREAKPOINT = 1100
export const INLINE_PANE_CHROME = 568
export const MIN_CONVERSATION_WIDTH = 420

export function paneWidthKey(project: string) {
  return `openscience-context-width-v6:${encodeURIComponent(project)}`
}

export function legacyPaneWidthKey(project: string, session = "new") {
  return `openscience-context-width-v5:${encodeURIComponent(project)}:${encodeURIComponent(session)}`
}

export function maxPaneWidthForWorkspace(workspace: number, persistentSidebar = 0) {
  if (!Number.isFinite(workspace)) return DEFAULT_PANE_WIDTH
  const sidebar = Number.isFinite(persistentSidebar) ? Math.max(0, persistentSidebar) : 0
  return Math.max(MIN_PANE_WIDTH, workspace - sidebar - MIN_CONVERSATION_WIDTH)
}

export function clampPaneWidth(width: number, max = Number.POSITIVE_INFINITY, min = MIN_PANE_WIDTH) {
  const value = Number.isFinite(width) ? width : DEFAULT_PANE_WIDTH
  const floor = Number.isFinite(min) ? Math.max(0, min) : MIN_PANE_WIDTH
  const ceiling = Number.isFinite(max) ? Math.max(floor, max) : Number.POSITIVE_INFINITY
  return Math.max(floor, Math.min(ceiling, value))
}

export function paneWidthForViewport(width: number, viewport: number) {
  return clampPaneWidth(Math.min(width, viewport - INLINE_PANE_CHROME))
}

export function paneWidthForWorkspace(width: number, workspace: number, persistentSidebar = 0) {
  return clampPaneWidth(width, maxPaneWidthForWorkspace(workspace, persistentSidebar))
}

export function equalPaneWidth(workspace: number, persistentSidebar = 0) {
  return paneWidthForWorkspace((workspace - persistentSidebar) / 2, workspace, persistentSidebar)
}

export function presetPaneWidth(
  preset: "conversation" | "inspector" | "equal" | "default",
  workspace: number,
  sidebar = 0,
) {
  if (preset === "default") return paneWidthForWorkspace(DEFAULT_PANE_WIDTH, workspace, sidebar)
  if (preset === "equal") return equalPaneWidth(workspace, sidebar)
  return paneWidthForWorkspace((workspace - sidebar) * (preset === "inspector" ? 0.7 : 0.3), workspace, sidebar)
}

export function readPaneWidth(
  key: string,
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
  legacy: string[] = [],
) {
  const value = (() => {
    try {
      const current = storage.getItem(key)
      if (current !== null) return current
      for (const old of legacy) {
        const saved = storage.getItem(old)
        if (saved === null) continue
        storage.setItem(key, saved)
        return saved
      }
    } catch {
      return
    }
  })()
  if (!value) return DEFAULT_PANE_WIDTH
  const width = Number(value)
  if (!Number.isFinite(width)) return DEFAULT_PANE_WIDTH
  return clampPaneWidth(width)
}

export function savePaneWidth(key: string, width: number, storage: Pick<Storage, "setItem"> = localStorage) {
  try {
    storage.setItem(key, String(clampPaneWidth(width)))
  } catch {}
}

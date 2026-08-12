export const MIN_PANE_WIDTH = 320
export const MAX_PANE_WIDTH = 960
export const DEFAULT_PANE_WIDTH = 400
export const INLINE_PANE_BREAKPOINT = 1100
export const INLINE_PANE_CHROME = 568
export const MIN_CONVERSATION_WIDTH = 360

export function paneWidthKey(project: string) {
  return `openscience-context-width-v6:${encodeURIComponent(project)}`
}

export function legacyPaneWidthKey(project: string, session = "new") {
  return `openscience-context-width-v5:${encodeURIComponent(project)}:${encodeURIComponent(session)}`
}

export function maxPaneWidthForWorkspace(workspace: number) {
  if (!Number.isFinite(workspace)) return MAX_PANE_WIDTH
  return Math.max(MIN_PANE_WIDTH, Math.min(MAX_PANE_WIDTH, workspace - MIN_CONVERSATION_WIDTH))
}

export function clampPaneWidth(width: number, max = MAX_PANE_WIDTH) {
  return Math.max(MIN_PANE_WIDTH, Math.min(max, width))
}

export function paneWidthForViewport(width: number, viewport: number) {
  return clampPaneWidth(Math.min(width, viewport - INLINE_PANE_CHROME))
}

export function paneWidthForWorkspace(width: number, workspace: number) {
  return clampPaneWidth(width, maxPaneWidthForWorkspace(workspace))
}

export function equalPaneWidth(workspace: number) {
  return paneWidthForWorkspace(workspace / 2, workspace)
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

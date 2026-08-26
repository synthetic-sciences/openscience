type DraftWindow = Window & {
  __openscienceFileDrafts?: Map<string, string>
  __openscienceFileDraftGuard?: boolean
}

const browser = typeof window === "undefined" ? undefined : (window as DraftWindow)
const drafts = browser ? (browser.__openscienceFileDrafts ??= new Map<string, string>()) : new Map<string, string>()

const key = (directory: string, path: string, scope?: "session") => `${scope ?? "project"}\n${directory}\n${path}`

export function rememberFileDraft(directory: string, path: string, draft: string, saved: string, scope?: "session") {
  const id = key(directory, path, scope)
  if (draft === saved) {
    drafts.delete(id)
    return
  }
  drafts.set(id, draft)
}

export function recoverFileDraft(directory: string, path: string, saved: string, scope?: "session") {
  return drafts.get(key(directory, path, scope)) ?? saved
}

export function discardFileDraft(directory: string, path: string, scope?: "session" | "auto") {
  if (scope === "auto") {
    drafts.delete(key(directory, path))
    drafts.delete(key(directory, path, "session"))
    return
  }
  drafts.delete(key(directory, path, scope))
}

export function discardAllFileDrafts() {
  drafts.clear()
}

export function hasUnsavedFileDrafts() {
  return drafts.size > 0
}

export function guardUnsavedFileDrafts(event: BeforeUnloadEvent) {
  if (!hasUnsavedFileDrafts()) return
  event.preventDefault()
  event.returnValue = ""
}

if (browser && !browser.__openscienceFileDraftGuard) {
  browser.__openscienceFileDraftGuard = true
  browser.addEventListener("beforeunload", guardUnsavedFileDrafts)
}

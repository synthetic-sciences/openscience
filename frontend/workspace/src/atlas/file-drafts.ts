type DraftWindow = Window & {
  __openscienceFileDrafts?: Map<string, string>
  __openscienceFileDraftGuard?: boolean
}

const browser = typeof window === "undefined" ? undefined : (window as DraftWindow)
const drafts = browser ? (browser.__openscienceFileDrafts ??= new Map<string, string>()) : new Map<string, string>()

const key = (directory: string, path: string) => `${directory}\n${path}`

export function rememberFileDraft(directory: string, path: string, draft: string, saved: string) {
  const id = key(directory, path)
  if (draft === saved) {
    drafts.delete(id)
    return
  }
  drafts.set(id, draft)
}

export function recoverFileDraft(directory: string, path: string, saved: string) {
  return drafts.get(key(directory, path)) ?? saved
}

export function discardFileDraft(directory: string, path: string) {
  drafts.delete(key(directory, path))
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

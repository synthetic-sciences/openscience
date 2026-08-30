import { resolveArtifactPath } from "@/artifacts/context"
import type { FileOpenScope } from "@/atlas/file-viewer"

type DraftWindow = Window & {
  __openscienceFileDrafts?: Map<string, string>
  __openscienceFileDraftGuard?: boolean
}

const browser = typeof window === "undefined" ? undefined : (window as DraftWindow)
const drafts = browser ? (browser.__openscienceFileDrafts ??= new Map<string, string>()) : new Map<string, string>()

// Auto drafts belong to the clicked reference and originating session, not a
// later resolved basename. Closing that tab must discard exactly its draft.
const key = (directory: string, path: string, scope?: FileOpenScope, sessionID?: string) =>
  `${scope ?? "project"}\n${directory}\n${scope === "session" || scope === "auto" ? path : resolveArtifactPath(directory, path)}${(scope === "session" || scope === "auto") && sessionID ? `\n${sessionID}` : ""}`

export function rememberFileDraft(
  directory: string,
  path: string,
  draft: string,
  saved: string,
  scope?: FileOpenScope,
  sessionID?: string,
) {
  const id = key(directory, path, scope, sessionID)
  if (draft === saved) {
    drafts.delete(id)
    return
  }
  drafts.set(id, draft)
}

export function recoverFileDraft(
  directory: string,
  path: string,
  saved: string,
  scope?: FileOpenScope,
  sessionID?: string,
) {
  return drafts.get(key(directory, path, scope, sessionID)) ?? saved
}

export function discardFileDraft(directory: string, path: string, scope?: FileOpenScope, sessionID?: string) {
  drafts.delete(key(directory, path, scope, sessionID))
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

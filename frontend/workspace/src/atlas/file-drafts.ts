import { resolveArtifactPath } from "@/artifacts/context"
import type { FileOpenScope } from "@/atlas/file-viewer"

type DraftWindow = Window & {
  __openscienceFileDrafts?: Map<string, FileDraft | string>
  __openscienceFileDraftGuard?: boolean
}

export interface FileDraft {
  draft: string
  saved: string
  revision?: string
}

const browser = typeof window === "undefined" ? undefined : (window as DraftWindow)
const drafts = browser
  ? (browser.__openscienceFileDrafts ??= new Map<string, FileDraft | string>())
  : new Map<string, FileDraft | string>()

// Auto drafts belong to the clicked reference and originating session, not a
// later resolved basename. Closing that tab must discard exactly its draft.
const key = (directory: string, path: string, scope?: FileOpenScope, sessionID?: string, server = "") =>
  `${server}\n${scope ?? "project"}\n${directory}\n${scope === "session" || scope === "auto" ? path : resolveArtifactPath(directory, path)}${(scope === "session" || scope === "auto") && sessionID ? `\n${sessionID}` : ""}`

export function rememberFileDraft(
  directory: string,
  path: string,
  draft: string,
  saved: string,
  scope?: FileOpenScope,
  sessionID?: string,
  revision?: string,
  server?: string,
) {
  const id = key(directory, path, scope, sessionID, server)
  if (draft === saved) {
    drafts.delete(id)
    return
  }
  drafts.set(id, { draft, saved, revision })
}

export function recoverFileDraft(
  directory: string,
  path: string,
  saved: string,
  scope?: FileOpenScope,
  sessionID?: string,
  server?: string,
) {
  return recoverFileDraftState(directory, path, saved, scope, sessionID, undefined, server).draft
}

/** A recovered edit remains based on its original bytes, never a newer read. */
export function recoverFileDraftState(
  directory: string,
  path: string,
  saved: string,
  scope?: FileOpenScope,
  sessionID?: string,
  revision?: string,
  server?: string,
): FileDraft {
  const previous = drafts.get(key(directory, path, scope, sessionID, server))
  if (typeof previous === "string") return { draft: previous, saved }
  return previous ?? { draft: saved, saved, revision }
}

export function discardFileDraft(
  directory: string,
  path: string,
  scope?: FileOpenScope,
  sessionID?: string,
  server?: string,
) {
  drafts.delete(key(directory, path, scope, sessionID, server))
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

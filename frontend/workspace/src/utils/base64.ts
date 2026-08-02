import { base64Decode } from "@synsci/util/encode"
import { createSignal } from "solid-js"

const [active, setActive] = createSignal({ directory: "", projectID: undefined as string | undefined })

const ABSOLUTE = /^(\/|\\\\|[A-Za-z]:[\\/])/

/**
 * Any first URL segment that is not an opaque project selector is treated as a
 * legacy base64 directory, and plenty of unrelated tokens (share links, stale
 * bookmarks) decode cleanly as base64 into binary junk. Sending that junk on as
 * a directory made the server resolve it against its cwd and register a brand
 * new project, so only hand back something that can actually be a folder.
 */
function directory(value: string) {
  if (!ABSOLUTE.test(value)) return
  if (/[\p{Cc}\p{Cs}�]/u.test(value)) return
  return value
}

export function decode64(value: string | undefined) {
  if (value === undefined) return
  try {
    return directory(base64Decode(value))
  } catch {
    return
  }
}

/**
 * The active physical directory is registered by the project route so portaled
 * settings can use it without exposing that path in the URL. The URL fallback
 * exists only for legacy base64-directory deep links during migration.
 */
export function currentDirectory(): string {
  if (active().directory) return active().directory
  if (typeof window === "undefined") return ""
  const seg = window.location.pathname.split("/").filter(Boolean)[0]
  return decode64(seg) ?? ""
}

export function currentProjectID() {
  return active().projectID
}

export function setCurrentDirectory(directory: string, projectID?: string) {
  setActive({ directory, projectID })
  return () => {
    if (active().directory === directory) setActive({ directory: "", projectID: undefined })
  }
}

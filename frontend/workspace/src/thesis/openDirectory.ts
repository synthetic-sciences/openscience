/**
 * Open a folder as a project — works in every modern browser.
 *
 * Chromium (Chrome / Edge / Brave / Arc) gets the File System Access API
 * with full read+write handles. Safari and Firefox get the webkitdirectory
 * input fallback, which still opens the OS-native picker and gives us
 * a FileList we walk into the same FileNode tree.
 */

import { projectsStore, type Project } from "@/thesis/store/projects"
import { filesStore } from "@/thesis/store/files"
import { toast } from "@/thesis/Toast"

interface DirectoryEntry {
  name: string
  path: string
  handle?: any
  files?: FileList
  /** First child file/dir name from inside, used to disambiguate which
   *  same-named folder the user actually picked. Empty if unavailable. */
  hint?: string
  /** Up to ~16 immediate child names — a stronger fingerprint that the
   *  resolver scores candidates against. */
  children?: string[]
}

declare global {
  interface Window {
    showDirectoryPicker?: (opts?: {
      id?: string
      mode?: "read" | "readwrite"
      startIn?: "desktop" | "documents" | "downloads" | "music" | "pictures" | "videos"
    }) => Promise<{ name: string; kind: "directory" }>
  }
}

export const isNativePickerSupported = () =>
  typeof window !== "undefined" && typeof window.showDirectoryPicker === "function"

/** Native File System Access API picker (Chromium). */
async function pickViaFsApi(): Promise<DirectoryEntry | null> {
  try {
    const handle: any = await window.showDirectoryPicker!({
      id: "thesis-project-root",
      mode: "readwrite",
    })
    // Read up to 16 immediate child entry names. The browser doesn't
    // expose absolute paths, so the dev-side resolver uses this list
    // as a fingerprint: the matching candidate is the folder whose
    // immediate children include these exact names.
    const children: string[] = []
    try {
      for await (const [name] of handle.entries() as AsyncIterable<[string, any]>) {
        children.push(name)
        if (children.length >= 16) break
      }
    } catch {}
    return {
      name: handle.name,
      path: handle.name,
      handle,
      hint: children[0] ?? "",
      children,
    }
  } catch (e: any) {
    // AbortError = user cancelled; SecurityError = browser blocked us.
    if (e?.name === "AbortError" || e?.name === "NotAllowedError") return null
    toast.error("could not open folder", e?.message ?? "unknown error")
    return null
  }
}

/**
 * Resolve a folder name + child fingerprint to an absolute path via
 * the dev-server's /api/resolve-folder endpoint. Returns null if no
 * match was found.
 */
export async function resolveAbsolute(name: string, hint?: string, children?: string[]): Promise<string | null> {
  try {
    const res = await fetch("/api/resolve-folder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, hint: hint ?? "", children: children ?? [] }),
    })
    if (!res.ok) return null
    const data = (await res.json()) as { best?: string | null }
    return data.best ?? null
  } catch {
    return null
  }
}

export async function openServerFolderDialog(): Promise<string[] | null | "unsupported"> {
  try {
    const res = await fetch("/api/resolve-folder/dialog")
    if (res.status === 501) return "unsupported"
    if (res.status === 499) return null
    if (!res.ok) return "unsupported"
    const data = (await res.json()) as { paths?: string[] }
    return Array.isArray(data.paths) ? data.paths.filter((p) => typeof p === "string") : null
  } catch {
    return "unsupported"
  }
}

export async function validateDirectoryPath(path: string): Promise<string | null> {
  try {
    const res = await fetch("/api/resolve-folder/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
    })
    const data = (await res.json()) as { ok?: boolean; absolute?: string; error?: string }
    if (res.ok && data.ok && data.absolute) return data.absolute
    toast.error("folder not available", data.error ?? "path could not be opened")
    return null
  } catch (e: any) {
    toast.error("folder not available", e?.message ?? "path could not be opened")
    return null
  }
}

/** Hidden <input type="file" webkitdirectory> fallback (Safari / Firefox). */
function pickViaInput(): Promise<DirectoryEntry | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input")
    input.type = "file"
    // The two attribute names cover every browser that supports this.
    ;(input as any).webkitdirectory = true
    ;(input as any).directory = true
    input.multiple = true
    input.style.display = "none"

    let settled = false

    input.onchange = () => {
      settled = true
      const files = input.files
      if (!files || files.length === 0) {
        resolve(null)
        cleanup()
        return
      }
      // The first segment of webkitRelativePath is the project folder name.
      const first = files[0] as any
      const rel = first.webkitRelativePath as string | undefined
      const name = rel ? rel.split("/")[0] : "untitled"
      resolve({ name, path: name, files })
      cleanup()
    }

    // The OS dialog is modal but doesn't fire 'change' on cancel — fall back
    // to a focus listener to detect dismissal.
    const onFocus = () => {
      // Give the change event a chance to fire first.
      setTimeout(() => {
        if (!settled) {
          resolve(null)
          cleanup()
        }
      }, 400)
    }

    const cleanup = () => {
      window.removeEventListener("focus", onFocus)
      try {
        input.remove()
      } catch {}
    }

    window.addEventListener("focus", onFocus, { once: true })
    document.body.appendChild(input)
    input.click()
  })
}

export async function chooseDirectory(): Promise<DirectoryEntry | null> {
  if (isNativePickerSupported()) return await pickViaFsApi()
  return await pickViaInput()
}

export async function chooseAndOpenProject(): Promise<Project | null> {
  const entry = await chooseDirectory()
  if (!entry) {
    // User cancelled or browser declined — silent so the home page just
    // stays where it was.
    return null
  }

  // Reuse an existing project by name+path so reopening doesn't create a
  // duplicate. (Browsers don't give us absolute paths, so we key on name.)
  const existing = projectsStore.list().find((p) => p.path === entry.path)
  const project = existing ?? projectsStore.create({ name: entry.name, path: entry.path })

  // Open it FIRST — this flips the activeId so ThesisApp jumps to the
  // Project view immediately. File scanning happens in the background.
  projectsStore.open(project.id)
  toast.success(existing ? "project reopened" : "project opened", entry.name)

  // Walk the folder into the file store. Both code paths feed the same
  // FileNode tree shape so the right pane just renders.
  ;(async () => {
    try {
      if (entry.handle) {
        await filesStore.setFromHandle(project.id, entry.handle)
      } else if (entry.files) {
        filesStore.setFromFileList(project.id, entry.files)
      }
    } catch (e: any) {
      toast.warning("file scan failed", e?.message ?? "")
    }
  })()

  return project
}

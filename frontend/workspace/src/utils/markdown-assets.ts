// Markdown asset resolution. Local references inside previewed markdown or
// chat output would otherwise resolve against the SPA origin and 404. Route
// both project-relative and absolute filesystem paths through the authenticated
// backend while leaving genuine web, email, and embedded URLs untouched.

const external = /^(?:https?:|mailto:|tel:|data:|blob:|\/\/|#)/i
const scheme = /^[a-z][a-z0-9+.-]*:/i
const windows = /^[A-Za-z]:[\\/]/

function clean(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+/g, "/")
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/** Resolve a reference against the directory containing `base`, collapsing `.` and `..`. */
export function resolvePath(base: string, reference: string): string {
  const normalizedBase = clean(base)
  const normalizedReference = clean(reference)
  const referenceDrive = /^([A-Za-z]:)\//.exec(normalizedReference)?.[1]
  const referenceRooted = !referenceDrive && normalizedReference.startsWith("/")
  const baseDrive = /^([A-Za-z]:)\//.exec(normalizedBase)?.[1]
  const baseRooted = !baseDrive && normalizedBase.startsWith("/")
  const drive = referenceDrive ?? (referenceRooted ? undefined : baseDrive)
  const rooted = referenceRooted || (!referenceDrive && !drive && baseRooted)
  const baseBody = baseDrive
    ? normalizedBase.slice(baseDrive.length + 1)
    : baseRooted
      ? normalizedBase.slice(1)
      : normalizedBase
  const referenceBody = referenceDrive
    ? normalizedReference.slice(referenceDrive.length + 1)
    : referenceRooted
      ? normalizedReference.slice(1)
      : normalizedReference
  const parts = [
    ...(referenceDrive || referenceRooted ? [] : baseBody.split("/").slice(0, -1)),
    ...referenceBody.split("/"),
  ]
  const resolved = parts
    .reduce<string[]>((result, part) => {
      if (!part || part === ".") return result
      if (part === "..") {
        result.pop()
        return result
      }
      result.push(part)
      return result
    }, [])
    .join("/")
  if (drive) return `${drive}/${resolved}`
  return rooted ? `/${resolved}` : resolved
}

function localFileUrl(value: string): string | undefined {
  if (!/^file:/i.test(value)) return
  try {
    const url = new URL(value)
    if (url.hostname && url.hostname !== "localhost") return
    const pathname = decode(url.pathname)
    return /^\/[A-Za-z]:\//.test(pathname) ? pathname.slice(1) : pathname
  } catch {
    return
  }
}

/**
 * Turn a Markdown reference into a filesystem path, or return undefined when
 * the reference belongs to the browser (http(s), mailto, data, blob, etc.).
 * URL query/fragment suffixes are not part of the local filename.
 */
export function localAssetPath(src: string, base = ""): string | undefined {
  const value = src.trim()
  if (!value || external.test(value)) return
  const file = localFileUrl(value)
  if (/^file:/i.test(value)) return file ? resolvePath("", file) : undefined
  if (scheme.test(value) && !windows.test(value)) return
  const target = decode(value.replace(/[?#].*$/, ""))
  if (!target) return
  return resolvePath(base, target)
}

/** Resolve a chat reference without turning arbitrary host paths into file
 * capabilities. Relative paths stay eligible for session/project fallback;
 * absolute paths must already live under the connected project root. */
export function workspaceAssetPath(src: string, root: string, base = ""): string | undefined {
  const resolved = localAssetPath(src, base)
  if (!resolved) return
  const absolute = resolved.startsWith("/") || windows.test(resolved)
  if (!absolute) return resolved
  const project = resolvePath("", root).replace(/\/+$/, "")
  const target = resolvePath("", resolved)
  const insensitive = windows.test(project) || windows.test(target)
  const owner = insensitive ? project.toLowerCase() : project
  const candidate = insensitive ? target.toLowerCase() : target
  if (candidate === owner || candidate.startsWith(`${owner}/`)) return target
}

/** Exact runtime file receipts may target session scratch or a connected
 * directory, just like tool-card links. This is a path-shape check, not a
 * permission grant: the viewer keeps its session and the backend authorizes
 * the read. Never URL-decode a filesystem receipt or strip legal #/? bytes. */
export function workspaceReceiptPath(path: string): string | undefined {
  if (path.includes("\0") || !(path.startsWith("/") || windows.test(path))) return
  return path
}

/**
 * Rewrite one image reference to a served file URL. Relative paths resolve
 * against the directory of `base` (the previewed file; omit `base` to resolve
 * against the workspace root) and run through `url` — typically
 * `(path) => sdk.request.url("/file/raw", { path, sessionID })`.
 */
const loopback = new Set(["localhost", "127.0.0.1", "[::1]"])

/**
 * Dev serves the UI and API on different ports. Chromium's ORB blocks an SVG
 * image when one side says `localhost` and the other says `127.0.0.1`, even
 * though both are the same machine. Keep the API port and capability query,
 * but align loopback hostnames with the page so project-local images remain a
 * same-site resource. Never rewrite a non-loopback URL.
 */
export function alignLoopbackAssetHost(value: string, pageOrigin?: string): string {
  const origin = pageOrigin ?? (typeof location === "object" ? location.origin : undefined)
  if (!origin) return value
  try {
    const target = new URL(value)
    const page = new URL(origin)
    if (!loopback.has(target.hostname) || !loopback.has(page.hostname)) return value
    if (target.protocol !== page.protocol || target.hostname === page.hostname) return value
    target.hostname = page.hostname
    return target.toString()
  } catch {
    return value
  }
}

export function assetUrl(
  src: string,
  input: { base?: string; root?: string; url: (path: string) => string; pageOrigin?: string },
): string {
  const path = input.root ? workspaceAssetPath(src, input.root, input.base) : localAssetPath(src, input.base)
  if (!path) return src
  return alignLoopbackAssetHost(input.url(path), input.pageOrigin)
}

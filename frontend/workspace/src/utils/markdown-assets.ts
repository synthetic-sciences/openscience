// Markdown asset resolution. Relative image references inside previewed
// markdown or chat output would otherwise resolve against the SPA origin and
// 404 — rewrite them to the backend /file/raw endpoint instead. Absolute
// http(s)/data:/blob: URLs, protocol-relative URLs, anchors, and root paths
// pass through untouched.

const absolute = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\/)/i

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
  const drive = /^([A-Za-z]:)\//.exec(normalizedBase)?.[1]
  const rooted = !drive && normalizedBase.startsWith("/")
  const baseBody = drive ? normalizedBase.slice(drive.length + 1) : rooted ? normalizedBase.slice(1) : normalizedBase
  const parts = [...baseBody.split("/").slice(0, -1), ...clean(reference).split("/")]
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
  input: { base?: string; url: (path: string) => string; pageOrigin?: string },
): string {
  if (absolute.test(src)) return src
  return alignLoopbackAssetHost(input.url(resolvePath(input.base ?? "", decode(src))), input.pageOrigin)
}

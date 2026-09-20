const drive = /^[A-Za-z]:\//
const unc = /^\/\/[^/]+\/[^/]+/

/** Lexical path helpers for browser UI only. Dot segments are deliberately
 * preserved so the backend remains authoritative for validation and access. */
export function normalizeLocalPath(path: string) {
  const replaced = path.replaceAll("\\", "/")
  const normalized = /^\/\/[^/]/.test(replaced)
    ? `//${replaced.slice(2).replace(/\/+/g, "/")}`
    : replaced.replace(/\/+/g, "/")
  if (!normalized) return ""
  const root = localPathRoot(normalized)
  if (root && normalized.length <= root.length) return root
  return normalized.replace(/\/+$/, "") || "/"
}

export function localPathRoot(path: string) {
  const normalized = path.replaceAll("\\", "/")
  const driveRoot = normalized.match(drive)?.[0]
  if (driveRoot) return driveRoot
  const uncRoot = normalized.match(unc)?.[0]
  if (uncRoot) return uncRoot
  return normalized.startsWith("/") ? "/" : ""
}

export function isLocalPathRoot(path: string) {
  const normalized = normalizeLocalPath(path)
  return normalized === localPathRoot(normalized)
}

function comparable(path: string) {
  const normalized = normalizeLocalPath(path)
  return drive.test(normalized) || unc.test(normalized) ? normalized.toLowerCase() : normalized
}

/** A drive root already ends in its separator (`C:/`), a POSIX root is the separator itself,
 * and every other root needs one appended before a prefix test means "inside this directory". */
function boundary(root: string) {
  return root.endsWith("/") ? root : `${root}/`
}

export function isLocalPathWithin(path: string, directory: string) {
  const target = comparable(path)
  const root = comparable(directory)
  if (!root) return target === root
  return target === root || target.startsWith(boundary(root))
}

export function joinLocalPath(directory: string, path: string) {
  const child = normalizeLocalPath(path)
  if (localPathRoot(child)) return child
  const root = normalizeLocalPath(directory)
  return normalizeLocalPath(`${root === "/" ? "" : root}/${child}`)
}

export function parentLocalPath(path: string) {
  const normalized = normalizeLocalPath(path)
  const root = localPathRoot(normalized)
  if (!root || normalized === root) return root || normalized
  const index = normalized.lastIndexOf("/")
  return index < root.length ? root : normalized.slice(0, index)
}

export function basenameLocalPath(path: string) {
  const normalized = normalizeLocalPath(path)
  const root = localPathRoot(normalized)
  if (normalized === root) return root
  return normalized.slice(normalized.lastIndexOf("/") + 1)
}

export function displayLocalPath(path: string, home: string) {
  const normalized = normalizeLocalPath(path)
  const normalizedHome = normalizeLocalPath(home)
  if (comparable(normalized) === comparable(normalizedHome)) return "~"
  if (isLocalPathRoot(normalizedHome)) return normalized
  const relative = relativeLocalPath(normalized, normalizedHome)
  return relative === "" ? "~" : relative === normalized ? normalized : `~/${relative}`
}

export function localPathBreadcrumbs(path: string, home: string) {
  const normalized = normalizeLocalPath(path)
  const normalizedHome = normalizeLocalPath(home)
  const insideHome =
    comparable(normalized) === comparable(normalizedHome) ||
    (!isLocalPathRoot(normalizedHome) && isLocalPathWithin(normalized, normalizedHome))
  const root = insideHome ? normalizedHome : localPathRoot(normalized)
  const crumbs = [{ label: insideHome ? "~" : root, path: root }]
  const relative = relativeLocalPath(normalized, root)
  if (!relative || relative === normalized) return crumbs
  let current = root
  for (const part of relative.split("/").filter(Boolean)) {
    current = joinLocalPath(current, part)
    crumbs.push({ label: part, path: current })
  }
  return crumbs
}

export function resolveTypedLocalPath(raw: string, directory: string, home: string) {
  const trimmed = raw.trim()
  if (!trimmed) return ""
  const normalized = normalizeLocalPath(trimmed)
  if (normalized === "~") return normalizeLocalPath(home)
  if (normalized.startsWith("~/")) return joinLocalPath(home, normalized.slice(2))
  return localPathRoot(normalized) ? normalized : joinLocalPath(directory, normalized)
}

/** Strip a project root only at a real path boundary. Browser code cannot use
 * node:path, and Windows paths still need case-insensitive comparison. */
export function relativeLocalPath(file: string, directory: string) {
  const target = normalizeLocalPath(file)
  const root = normalizeLocalPath(directory)
  if (!isLocalPathWithin(target, root)) return target
  if (comparable(target) === comparable(root)) return ""
  return target.slice(boundary(root).length)
}

/** Strip a project root only at a real path boundary. Browser code cannot use
 * node:path, and Windows paths still need case-insensitive comparison. */
export function relativeLocalPath(file: string, directory: string) {
  const target = file.replaceAll("\\", "/")
  const root = directory.replaceAll("\\", "/").replace(/\/+$/, "") || "/"
  const windows = /^[A-Za-z]:\//.test(root) || /^[A-Za-z]:\//.test(target)
  const comparedTarget = windows ? target.toLowerCase() : target
  const comparedRoot = windows ? root.toLowerCase() : root
  if (comparedTarget === comparedRoot) return ""
  const prefix = comparedRoot === "/" ? "/" : `${comparedRoot}/`
  if (!comparedTarget.startsWith(prefix)) return target
  return target.slice(prefix.length)
}

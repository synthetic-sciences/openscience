/** Bun's glob scan returns backslash separators on Windows, and catalog paths
 * feed `encodeURIComponent` before they become public GitHub links. Normalizing
 * to forward slashes before anything else touches them keeps the generated
 * catalogs byte-identical on every operating system. */
export function skillPath(raw: string) {
  return raw.replaceAll("\\", "/")
}

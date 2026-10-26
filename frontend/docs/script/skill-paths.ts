/** Bun's glob scan and `path.join` return backslash separators on Windows, but
 * every consumer of these paths (catalog `encodeURIComponent`, the TypeScript
 * compiler's root-file names) expects forward slashes. Normalizing before
 * anything else touches them keeps catalogs and checks identical on every OS. */
export function skillPath(raw: string) {
  return raw.replaceAll("\\", "/")
}

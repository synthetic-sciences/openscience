import path from "node:path"
import { isRetiredProductSkillName } from "./retired"

/** Keep retired Atlas and graph skills out of the release archive. This runs on
 * the exact entries Bun embeds in every native package, so a stale generated
 * copy cannot silently reintroduce either slash-command skill. */
export function assertNoRetiredProductSkills(entries: { path: string; bytes: Uint8Array }[]): void {
  const decoder = new TextDecoder()
  for (const entry of entries) {
    const normalized = entry.path.replaceAll("\\", "/").toLowerCase()
    const source = decoder.decode(entry.bytes)
    const pathName = normalized.split("/").find(isRetiredProductSkillName)
    const frontmatterName = source.match(/^name:\s*([^\r\n]+)\s*$/im)?.[1]?.trim()
    const retiredName =
      pathName ?? (frontmatterName && isRetiredProductSkillName(frontmatterName) ? frontmatterName : undefined)
    if (retiredName) {
      throw new Error(`Retired product skill ${retiredName} cannot be included in ${entry.path}`)
    }
  }
}

export function bundleDigest(entries: { path: string; bytes: Uint8Array }[]): string {
  const hash = new Bun.CryptoHasher("sha256")
  for (const entry of entries.toSorted((a, b) => a.path.localeCompare(b.path))) {
    hash.update(entry.path.replaceAll("\\", "/"))
    hash.update("\0")
    hash.update(entry.bytes)
  }
  return hash.digest("hex")
}

export async function directoryDigest(root: string): Promise<string> {
  const files = await Array.fromAsync(
    new Bun.Glob("**/*").scan({
      cwd: root,
      absolute: true,
      dot: true,
      onlyFiles: true,
      followSymlinks: false,
    }),
  )
  const entries = await Promise.all(
    files
      .filter((file) => path.basename(file) !== ".openscience-bundle.json")
      .map(async (file) => ({
        path: path.relative(root, file).replaceAll("\\", "/"),
        bytes: await Bun.file(file).bytes(),
      })),
  )
  return bundleDigest(entries)
}

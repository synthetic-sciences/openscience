import path from "node:path"

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

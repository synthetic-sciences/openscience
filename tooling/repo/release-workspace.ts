import { $ } from "bun"

export const releaseRoot = new URL("../..", import.meta.url).pathname

export async function assertReleaseSource(expected = process.env.OPENSCIENCE_RELEASE_SOURCE) {
  if (!expected || !/^[0-9a-f]{40}$/i.test(expected)) {
    throw new Error(`OPENSCIENCE_RELEASE_SOURCE must be an immutable commit SHA, received '${expected ?? ""}'`)
  }
  const actual = await $`git rev-parse HEAD`
    .cwd(releaseRoot)
    .text()
    .then((value) => value.trim())
  if (actual !== expected) throw new Error(`Release source mismatch: expected ${expected}, checked out ${actual}`)
  return actual
}

export async function setWorkspaceVersion(version: string) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Workspace releases require semver, received ${version}`)
  }
  const pkgjsons = await Array.fromAsync(
    new Bun.Glob("**/package.json").scan({
      absolute: true,
      cwd: releaseRoot,
    }),
  ).then((files) => files.filter((file) => !file.includes("node_modules") && !file.includes("dist")))

  for (const file of pkgjsons) {
    const source = await Bun.file(file).text()
    const updated = source.replaceAll(/"version": "[^"]+"/g, `"version": "${version}"`)
    if (updated !== source) await Bun.write(file, updated)
  }
  await $`bun install`.cwd(releaseRoot)
  return pkgjsons
}

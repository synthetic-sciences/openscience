#!/usr/bin/env bun

import path from "path"
import { cp, copyFile, mkdir } from "node:fs/promises"
import { $ } from "bun"
import { Script } from "@synsci/script"
import { assertPublicPackageSurface, createWrapperPackageManifest } from "../../backend/cli/script/publish-manifest"
import { packPackage, saveReleaseArtifacts, type PackedPackage } from "./npm-release"
import { assertReleaseSource, releaseRoot, setWorkspaceVersion } from "./release-workspace"

const source = await assertReleaseSource()
const artifactSource = process.env.OPENSCIENCE_ARTIFACT_SOURCE
if (!artifactSource || !/^[0-9a-f]{40}$/i.test(artifactSource)) {
  throw new Error("OPENSCIENCE_ARTIFACT_SOURCE must be an immutable commit SHA")
}
const version = Script.version
const output = process.env.OPENSCIENCE_NPM_ARTIFACT_DIR
if (!output) throw new Error("OPENSCIENCE_NPM_ARTIFACT_DIR is required")

await setWorkspaceVersion(version)
await import("../sdk/js/script/build.ts")

const artifacts: PackedPackage[] = []
const cliDir = path.join(releaseRoot, "backend/cli")
const cliPackage = await Bun.file(path.join(cliDir, "package.json")).json()
const binaries: Record<string, string> = {}
for (const filepath of new Bun.Glob("@synsci/*/package.json").scanSync({ cwd: path.join(cliDir, "dist") })) {
  const platform = await Bun.file(path.join(cliDir, "dist", filepath)).json()
  if (platform.name === cliPackage.name) continue
  if (platform.version !== version) {
    throw new Error(`Native package ${platform.name} is ${platform.version}, expected ${version}`)
  }
  binaries[platform.name] = platform.version
}
if (Object.keys(binaries).length === 0) throw new Error("No native CLI packages found in backend/cli/dist")

const wrapperDir = path.join(cliDir, "dist", cliPackage.name)
await mkdir(wrapperDir, { recursive: true })
await cp(path.join(cliDir, "bin"), path.join(wrapperDir, "bin"), { recursive: true })
await copyFile(path.join(cliDir, "README.md"), path.join(wrapperDir, "README.md"))
await copyFile(path.join(cliDir, "script/preinstall.mjs"), path.join(wrapperDir, "preinstall.mjs"))
await copyFile(path.join(cliDir, "script/postinstall.mjs"), path.join(wrapperDir, "postinstall.mjs"))
const wrapperManifest = createWrapperPackageManifest({ source: cliPackage, version, binaries })
await Bun.write(path.join(wrapperDir, "package.json"), JSON.stringify(wrapperManifest, null, 2))
assertPublicPackageSurface({
  "README.md": await Bun.file(path.join(wrapperDir, "README.md")).text(),
  "package.json": JSON.stringify(wrapperManifest),
  "bin/openscience": await Bun.file(path.join(wrapperDir, "bin/openscience")).text(),
})

for (const name of Object.keys(binaries).sort()) {
  const cwd = path.join(cliDir, "dist", name)
  if (!name.includes("windows")) await $`chmod 755 ./bin/openscience`.cwd(cwd)
  artifacts.push(await packPackage({ cwd, name, version }))
}
artifacts.push(await packPackage({ cwd: wrapperDir, name: cliPackage.name, version }))

async function packCompiledPackage(directory: string) {
  const packageFile = path.join(directory, "package.json")
  const original = await Bun.file(packageFile).text()
  const pkg = JSON.parse(original)
  for (const [key, value] of Object.entries(pkg.exports as Record<string, string>)) {
    const file = value.replace("./src/", "./dist/").replace(".ts", "")
    pkg.exports[key] = { import: `${file}.js`, types: `${file}.d.ts` }
  }
  await Bun.write(packageFile, JSON.stringify(pkg, null, 2))
  try {
    return await packPackage({ cwd: directory, name: pkg.name, version })
  } finally {
    await Bun.write(packageFile, original)
  }
}

const sdkDir = path.join(releaseRoot, "tooling/sdk/js")
artifacts.push(await packCompiledPackage(sdkDir))

const pluginDir = path.join(releaseRoot, "tooling/plugin")
await $`bun tsc`.cwd(pluginDir)
artifacts.push(await packCompiledPackage(pluginDir))

const launcherDir = path.join(releaseRoot, "tooling/launcher")
const launcherFile = path.join(launcherDir, "package.json")
const launcherOriginal = await Bun.file(launcherFile).text()
const launcher = JSON.parse(launcherOriginal)
launcher.version = version
delete launcher.dependencies
await Bun.write(launcherFile, JSON.stringify(launcher, null, 2))
try {
  assertPublicPackageSurface({
    "launcher/package.json": JSON.stringify(launcher),
    "launcher/bin/synsci.mjs": await Bun.file(path.join(launcherDir, "bin/synsci.mjs")).text(),
  })
  artifacts.push(await packPackage({ cwd: launcherDir, name: launcher.name, version }))
} finally {
  await Bun.write(launcherFile, launcherOriginal)
}

await saveReleaseArtifacts({ artifacts, directory: output, source: artifactSource, version })
console.log(`Prepared ${artifacts.length} immutable npm artifacts for ${version} from ${source}`)

#!/usr/bin/env bun

import fs from "node:fs/promises"
import path from "node:path"
import pkg from "../package.json"
import { assertPublicPackageSurface, createWrapperPackageManifest } from "./publish-manifest"

const outputArg = process.argv[2]
if (!outputArg) throw new Error("usage: pack-native-smoke.ts <output-directory>")
const output: string = path.resolve(outputArg)
const single = process.argv.includes("--single")

const cli = path.resolve(import.meta.dir, "..")
await fs.rm(output, { recursive: true, force: true })
await fs.mkdir(output, { recursive: true })

function npmVersion(value: string): string {
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value) ? value : "0.0.0-native-smoke"
}

async function pack(directory: string): Promise<string> {
  const proc = Bun.spawn(["npm", "pack", "--json", "--pack-destination", output], {
    cwd: directory,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  if (exitCode !== 0) throw new Error(`npm pack failed in ${directory}: ${stderr || stdout}`)
  const result = JSON.parse(stdout) as { filename?: string }[]
  const filename = result[0]?.filename
  if (!filename) throw new Error(`npm pack returned no filename for ${directory}`)
  return path.resolve(output, filename)
}

// Include both Linux architectures. npm must install only the native optional
// dependency on each matrix runner, which exercises os/cpu selection instead
// of merely proving that a cached binary can execute.
const platformNames = single
  ? [`@synsci/openscience-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`]
  : ["@synsci/openscience-linux-x64", "@synsci/openscience-linux-arm64"]
const binaries: Record<string, string> = {}
let packageVersion = "0.0.0-native-smoke"
for (const name of platformNames) {
  const source = path.join(cli, "dist", name)
  const directory = path.join(output, "platforms", name)
  await fs.mkdir(path.dirname(directory), { recursive: true })
  await fs.cp(source, directory, { recursive: true })
  const platformManifest = await Bun.file(path.join(directory, "package.json")).json()
  platformManifest.version = npmVersion(String(platformManifest.version))
  packageVersion = platformManifest.version
  await fs.writeFile(path.join(directory, "package.json"), JSON.stringify(platformManifest, null, 2) + "\n")
  await fs.chmod(path.join(directory, "bin", "openscience"), 0o755)
  binaries[name] = `file:${await pack(directory)}`
}

const metadata = await Bun.file(path.resolve(cli, "../../frontend/workspace/dist/version.json"))
  .json()
  .catch(() => undefined)
if (metadata?.version !== packageVersion) {
  throw new Error(
    `packaged version mismatch: native package is ${packageVersion}, web metadata is ${metadata?.version ?? "missing"}`,
  )
}

const wrapper = path.join(output, "wrapper")
await fs.mkdir(wrapper, { recursive: true })
await fs.cp(path.join(cli, "bin"), path.join(wrapper, "bin"), { recursive: true })
await fs.copyFile(path.join(cli, "README.md"), path.join(wrapper, "README.md"))
await fs.copyFile(path.join(cli, "script", "preinstall.mjs"), path.join(wrapper, "preinstall.mjs"))
await fs.copyFile(path.join(cli, "script", "postinstall.mjs"), path.join(wrapper, "postinstall.mjs"))

const manifest = createWrapperPackageManifest({ source: pkg, version: packageVersion, binaries })
await fs.writeFile(path.join(wrapper, "package.json"), JSON.stringify(manifest, null, 2) + "\n")
assertPublicPackageSurface({
  "README.md": await fs.readFile(path.join(wrapper, "README.md"), "utf8"),
  "package.json": await fs.readFile(path.join(wrapper, "package.json"), "utf8"),
  "bin/openscience": await fs.readFile(path.join(wrapper, "bin", "openscience"), "utf8"),
})

const wrapperTarball = await pack(wrapper)
await fs.copyFile(wrapperTarball, path.join(output, "wrapper.tgz"))

const launcherSource = path.resolve(cli, "../../tooling/launcher")
const launcher = path.join(output, "launcher")
await fs.mkdir(launcher, { recursive: true })
await Promise.all([
  fs.cp(path.join(launcherSource, "bin"), path.join(launcher, "bin"), { recursive: true }),
  fs.cp(path.join(launcherSource, "lib"), path.join(launcher, "lib"), { recursive: true }),
])
const launcherManifest = await Bun.file(path.join(launcherSource, "package.json")).json()
launcherManifest.version = packageVersion
await fs.writeFile(path.join(launcher, "package.json"), JSON.stringify(launcherManifest, null, 2) + "\n")
assertPublicPackageSurface({
  "launcher/package.json": await fs.readFile(path.join(launcher, "package.json"), "utf8"),
  "launcher/bin/synsci.mjs": await fs.readFile(path.join(launcher, "bin", "synsci.mjs"), "utf8"),
})
const launcherTarball = await pack(launcher)
await fs.copyFile(launcherTarball, path.join(output, "launcher.tgz"))

console.log(`packed native npm smoke fixture at ${output}`)

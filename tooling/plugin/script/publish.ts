#!/usr/bin/env bun
import { Script } from "@synsci/script"
import { $ } from "bun"
import { createCompiledPackageManifest, packPackage, publishPackage } from "../../repo/npm-release"

const dir = new URL("..", import.meta.url).pathname
process.chdir(dir)

await $`bun tsc`
const packageFile = new URL("../package.json", import.meta.url)
const original = await Bun.file(packageFile).text()
const pkg = createCompiledPackageManifest(original, Script.version)
await Bun.write(packageFile, JSON.stringify(pkg, null, 2))
try {
  const artifact = await packPackage({ cwd: dir, name: pkg.name, version: Script.version })
  await publishPackage({ ...artifact, tag: Script.channel })
} finally {
  await Bun.write(packageFile, original)
}

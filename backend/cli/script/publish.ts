#!/usr/bin/env bun
import { $ } from "bun"
import pkg from "../package.json"
import { Script } from "@synsci/script"
import { fileURLToPath } from "url"
import { assertPublicPackageSurface, createWrapperPackageManifest } from "./publish-manifest"
import {
  packPackage,
  publishPackage,
  verifyPublishedPackages,
  type PackedPackage,
} from "../../../tooling/repo/npm-release"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

const binaries: Record<string, string> = {}
for (const filepath of new Bun.Glob("@synsci/*/package.json").scanSync({ cwd: "./dist" })) {
  const platform = await Bun.file(`./dist/${filepath}`).json()
  // never let the meta package list itself (re-runs re-glob the dist dir)
  if (platform.name === pkg.name) continue
  binaries[platform.name] = platform.version
}
console.log("binaries", binaries)
if (Object.keys(binaries).length === 0) {
  throw new Error("No binary packages found in dist/. Did the build step run?")
}
const version = Object.values(binaries)[0]

await $`mkdir -p ./dist/${pkg.name}`
await $`cp -r ./bin ./dist/${pkg.name}/bin`
await $`cp ./README.md ./dist/${pkg.name}/README.md`
await $`cp ./script/preinstall.mjs ./dist/${pkg.name}/preinstall.mjs`
await $`cp ./script/postinstall.mjs ./dist/${pkg.name}/postinstall.mjs`

const wrapperManifest = createWrapperPackageManifest({ source: pkg, version, binaries })
await Bun.file(`./dist/${pkg.name}/package.json`).write(JSON.stringify(wrapperManifest, null, 2))
assertPublicPackageSurface({
  "README.md": await Bun.file(`./dist/${pkg.name}/README.md`).text(),
  "package.json": JSON.stringify(wrapperManifest),
  "bin/openscience": await Bun.file(`./dist/${pkg.name}/bin/openscience`).text(),
})

// Publish platform packages sequentially. Each tarball is ~90MB; publishing
// all 11 in parallel saturates the uplink and npm times out. The shared helper
// verifies an existing immutable version byte-for-byte before skipping it.
const results: PromiseSettledResult<string>[] = []
const artifacts: PackedPackage[] = []
for (const [name] of Object.entries(binaries)) {
  try {
    if (!name.includes("windows")) {
      await $`chmod 755 ./dist/${name}/bin/openscience`
    }
    const artifact = await packPackage({ cwd: `${dir}/dist/${name}`, name, version })
    await publishPackage({ ...artifact, deferVerification: true, tag: Script.channel })
    artifacts.push(artifact)
    results.push({ status: "fulfilled", value: name })
  } catch (e) {
    results.push({ status: "rejected", reason: e })
  }
}
const failed = results.filter((r) => r.status === "rejected")
const succeeded = results.filter((r) => r.status === "fulfilled")
if (failed.length > 0) {
  console.error(`${failed.length}/${results.length} binary packages failed to publish:`)
  for (const f of failed) console.error("  ", (f as PromiseRejectedResult).reason)
  throw new Error("Refusing to publish @synsci/openscience wrapper because one or more platform packages failed")
}
if (succeeded.length > 0) {
  console.log(`${succeeded.length}/${results.length} binary packages published or verified successfully`)
}
const wrapper = await packPackage({ cwd: `${dir}/dist/${pkg.name}`, name: pkg.name, version })
await publishPackage({ ...wrapper, deferVerification: true, tag: Script.channel })
artifacts.push(wrapper)
await verifyPublishedPackages(artifacts)
console.log(`${artifacts.length}/${artifacts.length} CLI packages verified on npm`)

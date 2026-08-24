import path from "path"
import { Script } from "@synsci/script"
import { assertPublicPackageSurface } from "../../backend/cli/script/publish-manifest"
import { packPackage, preflightRelease, publishPackage } from "./npm-release"
import { releaseRoot, setWorkspaceVersion } from "./release-workspace"

await preflightRelease()
await setWorkspaceVersion(Script.version)
await import("../sdk/js/script/build.ts")

const failures: string[] = []
for (const item of [
  ["cli", "../../backend/cli/script/publish.ts"],
  ["sdk", "../sdk/js/script/publish.ts"],
  ["plugin", "../plugin/script/publish.ts"],
] as const) {
  try {
    await import(item[1])
  } catch (error) {
    console.error(`${item[0]} preview publish failed:`, error)
    failures.push(item[0])
  }
}

try {
  const directory = path.join(releaseRoot, "tooling/launcher")
  const file = path.join(directory, "package.json")
  const original = await Bun.file(file).text()
  const pkg = JSON.parse(original)
  pkg.version = Script.version
  delete pkg.dependencies
  await Bun.write(file, JSON.stringify(pkg, null, 2))
  try {
    assertPublicPackageSurface({
      "launcher/package.json": JSON.stringify(pkg),
      "launcher/bin/synsci.mjs": await Bun.file(path.join(directory, "bin/synsci.mjs")).text(),
    })
    const artifact = await packPackage({ cwd: directory, name: pkg.name, version: Script.version })
    await publishPackage({ ...artifact, tag: Script.channel })
  } finally {
    await Bun.write(file, original)
  }
} catch (error) {
  console.error("launcher preview publish failed:", error)
  failures.push("launcher")
}

if (failures.length > 0) throw new Error(`Preview publish failed for: ${failures.join(", ")}`)

#!/usr/bin/env bun
import { Script } from "@synsci/script"
import { $ } from "bun"
import { packPackage, publishPackage } from "../../repo/npm-release"

const dir = new URL("..", import.meta.url).pathname
process.chdir(dir)

await $`bun tsc`
const pkg = await import("../package.json").then((m) => m.default)
const original = JSON.parse(JSON.stringify(pkg))
for (const [key, value] of Object.entries(pkg.exports)) {
  const file = value.replace("./src/", "./dist/").replace(".ts", "")
  // @ts-ignore
  pkg.exports[key] = {
    import: file + ".js",
    types: file + ".d.ts",
  }
}
await Bun.write("package.json", JSON.stringify(pkg, null, 2))
try {
  const artifact = await packPackage({ cwd: dir, name: pkg.name, version: Script.version })
  await publishPackage({ ...artifact, tag: Script.channel })
} finally {
  await Bun.write("package.json", JSON.stringify(original, null, 2))
}

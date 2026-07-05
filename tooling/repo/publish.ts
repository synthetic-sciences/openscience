#!/usr/bin/env bun

import { $ } from "bun"
import { Script } from "@synsci/script"

const highlightsTemplate = `
<!--
Add highlights before publishing. Delete this section if no highlights.

- For multiple highlights, use multiple <highlight> tags
- Highlights with the same source attribute get grouped together
-->

<!--
<highlight source="SourceName (Web/Core/SDK)">
  <h2>Feature title goes here</h2>
  <p short="Short description used for Desktop Recap">
    Full description of the feature or change
  </p>

  https://github.com/user-attachments/assets/uuid-for-video (you will want to drag & drop the video or picture)

  <img
    width="1912"
    height="1164"
    alt="image"
    src="https://github.com/user-attachments/assets/uuid-for-image"
  />
</highlight>
-->

`

console.log("=== publishing ===\n")

const pkgjsons = await Array.fromAsync(
  new Bun.Glob("**/package.json").scan({
    absolute: true,
  }),
).then((arr) => arr.filter((x) => !x.includes("node_modules") && !x.includes("dist")))

for (const file of pkgjsons) {
  let pkg = await Bun.file(file).text()
  pkg = pkg.replaceAll(/"version": "[^"]+"/g, `"version": "${Script.version}"`)
  console.log("updated:", file)
  await Bun.file(file).write(pkg)
}

await $`bun install`
await import(`../sdk/js/script/build.ts`)

if (Script.release) {
  await $`git commit -am "release: v${Script.version}"`.nothrow()
  await $`git tag v${Script.version}`.nothrow()
  await $`git fetch origin`.nothrow()
  await $`git cherry-pick HEAD..origin/dev`.nothrow()
  await $`git push origin HEAD --tags --no-verify --force-with-lease`.nothrow()
  await new Promise((resolve) => setTimeout(resolve, 5_000))
  await $`gh release edit v${Script.version} --draft=false`.nothrow()
}

// Sections keep publishing past an earlier failure so a broken CLI publish
// doesn't block the SDK, but any failure must fail the workflow at the end —
// a green run previously meant nothing reached npm at all.
const failures: string[] = []

console.log("\n=== cli ===\n")
try {
  await import(`../../backend/cli/script/publish.ts`)
} catch (e) {
  console.error("CLI publish failed:", e)
  failures.push("cli")
}

console.log("\n=== sdk ===\n")
try {
  await import(`../sdk/js/script/publish.ts`)
} catch (e) {
  console.error("SDK publish failed:", e)
  failures.push("sdk")
}

console.log("\n=== plugin ===\n")
try {
  await import(`../plugin/script/publish.ts`)
} catch (e) {
  console.error("Plugin publish failed:", e)
  failures.push("plugin")
}

console.log("\n=== launcher (openscience) ===\n")
try {
  const launcherDir = new URL("../launcher", import.meta.url).pathname
  // Pin @synsci/openscience dependency to the version being published.
  // Defensive: initialize `dependencies` if the launcher's package.json
  // was authored without it — happened on the v1.1.117 publish (broken
  // launcher step). Empty object is fine since we only need the pin.
  const launcherPkg = await Bun.file(`${launcherDir}/package.json`).json()
  // Keep the launcher version in lockstep with the just-released @synsci/openscience.
  // Without this, each subsequent publish would npm-error with "cannot
  // publish over existing version" because the launcher's package.json
  // never gets bumped (the source value stays whatever the last manual
  // commit set it to).
  launcherPkg.version = Script.version
  // Do NOT declare @synsci/openscience as a static dependency. Both packages
  // expose a `openscience` bin and npx resolves dep-bin before parent-bin,
  // which caused `npx openscience` to skip the launcher and jump straight
  // into the CLI (npm caches: openscience -> @synsci/openscience/bin/openscience instead
  // of openscience -> openscience/bin/openscience.mjs). The launcher already shells
  // out `npm i -g @synsci/openscience@latest` at runtime when it needs the
  // binary — that path puts openscience on PATH for the subsequent spawn
  // without polluting node_modules/.bin in the npx temp tree.
  delete launcherPkg.dependencies
  await Bun.file(`${launcherDir}/package.json`).write(JSON.stringify(launcherPkg, null, 2))
  const result = await $`cd ${launcherDir} && npm publish --access public --tag ${Script.channel}`.quiet().nothrow()
  process.stdout.write(result.stdout.toString())
  process.stderr.write(result.stderr.toString())
  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString()
    // The unscoped `synsci` package has its own npm owner list; a token
    // whose account isn't on it gets E403. That's an ownership grant to
    // chase (`npm owner add <token-user> synsci`), not a broken release —
    // every other package shipped, so warn loudly instead of failing.
    if (stderr.includes("E403") || stderr.includes("do not have permission")) {
      console.warn(
        "launcher NOT published: the npm token's account is not an owner of the 'synsci' package.\n" +
          "Fix: an owner runs `npm owner add <token-user> synsci`, then re-release.",
      )
    } else if (stderr.includes("cannot publish over") || stderr.includes("previously published")) {
      // The launcher sometimes ships out-of-band between releases; finding
      // this version already on the registry is success, not failure.
      console.warn(`launcher ${Script.version} already on the registry, skipping`)
    } else {
      throw new Error(`npm publish exited with ${result.exitCode}`)
    }
  }
} catch (e) {
  console.error("Launcher publish failed:", e)
  failures.push("launcher")
}

const dir = new URL("../..", import.meta.url).pathname
process.chdir(dir)

if (failures.length > 0) {
  console.error(`\npublish failed for: ${failures.join(", ")}`)
  process.exit(1)
}

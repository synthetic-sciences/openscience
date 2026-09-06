import { mkdir, lstat, symlink } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"

// Link the actual development package, whose own workspace dependencies are
// installed by the repository setup. Never modify global package registrations.
const source = fileURLToPath(new URL("../../tooling/plugin", import.meta.url))
const target = fileURLToPath(new URL("./node_modules/@synsci/plugin", import.meta.url))
if (!(await Bun.file(path.join(source, "package.json")).exists())) {
  throw new Error(
    "Run this setup inside an OpenScience checkout, or install the compatible published @synsci/plugin package.",
  )
}
await mkdir(path.dirname(target), { recursive: true })
if (!(await lstat(target).catch(() => undefined))) await symlink(source, target, "dir")
console.log("Local plugin dependency ready. Run bun test.")

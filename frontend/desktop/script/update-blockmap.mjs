import { createRequire } from "node:module"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import path from "node:path"
import { parseBlockmap } from "../src/update-download.mjs"

const require = createRequire(import.meta.url)
const builder = createRequire(require.resolve("electron-builder"))
const { buildBlockMap } = builder("app-builder-lib/out/targets/blockmap/blockmap.js")

export async function blockmap(archive) {
  const file = `${archive}.blockmap`
  const result = await buildBlockMap(archive, "gzip", file)
  parseBlockmap(await readFile(file), result.size)
  return file
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error("Usage: update-blockmap.mjs <signed updater ZIP>")
  console.log(await blockmap(path.resolve(process.argv[2])))
}

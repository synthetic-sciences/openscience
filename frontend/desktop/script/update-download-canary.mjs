import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { blockmap } from "./update-blockmap.mjs"
import { cacheArchive, downloadChanges } from "../src/update-download.mjs"
import { checksum } from "../src/updater.mjs"

const [previous, archive, report] = process.argv.slice(2).map((file) => path.resolve(file))
if (!previous || !archive || !report)
  throw new Error("Usage: update-download-canary.mjs <old ZIP> <new ZIP> <report.json>")
const root = await mkdtemp(path.join(os.tmpdir(), "openscience-download-canary-"))
const cache = path.join(root, "cache")
await mkdir(cache)
const before = await readFile(await blockmap(previous))
// Production has already authenticated this sidecar against its GitHub asset digest.
const after = await readFile(`${archive}.blockmap`)
const oldsize = (await lstat(previous)).size
const size = (await lstat(archive)).size
const digest = await checksum(archive)
let transferred = 0
let requests = 0
const server = Bun.serve({
  port: 0,
  fetch(request) {
    if (new URL(request.url).pathname === "/map") return new Response(after)
    const range = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range") ?? "")
    if (!range) {
      transferred += size
      requests++
      return new Response(Bun.file(archive))
    }
    const start = Number(range[1])
    const end = Number(range[2])
    if (end >= size || start > end) return new Response(null, { status: 416 })
    transferred += end - start + 1
    requests++
    return new Response(Bun.file(archive).slice(start, end + 1), {
      status: 206,
      headers: { "Content-Range": `bytes ${start}-${end}/${size}` },
    })
  },
})
try {
  const info = {
    name: path.basename(archive),
    version: "0.0.0",
    digest,
    size,
    url: new URL("/zip", server.url).href,
    blockmap: {
      size: after.length,
      digest: await checksum(`${archive}.blockmap`),
      url: new URL("/map", server.url).href,
    },
  }
  await cacheArchive({ ...info, digest: await checksum(previous), size: oldsize }, previous, { bytes: before }, cache)
  const output = path.join(root, "reconstructed.zip")
  const reasons = []
  const started = performance.now()
  const result = await downloadChanges(info, output, { cache, onFallback: (reason) => reasons.push(reason) })
  if (result.method !== "differential") {
    if (reasons.length !== 1 || reasons[0] !== "A full update is more efficient") {
      throw new Error(`Real release differential canary fell back: ${reasons.join("; ")}`)
    }
    // Large runtime upgrades may legitimately replace almost every chunk.
    await Bun.write(output, await fetch(info.url))
  }
  if ((await checksum(output)) !== digest || transferred !== (result.bytes ?? size))
    throw new Error("Reconstructed release does not match its immutable archive")
  // Prove a bad baseline cannot disable the standard full download fallback.
  await writeFile(path.join(cache, "download-cache", "archive.zip"), "corrupt cache")
  if ((await downloadChanges(info, output, { cache })).method !== "full")
    throw new Error("Corrupt cache did not fall back")
  const evidence = {
    previous: path.basename(previous),
    archive: path.basename(archive),
    sha256: digest,
    method: result.method,
    full_bytes: size,
    downloaded_bytes: transferred,
    metadata_bytes: after.length,
    saved_percent: Number((100 * (1 - (transferred + after.length) / size)).toFixed(2)),
    requests,
    duration_ms: Math.round(performance.now() - started),
    fallback_verified: true,
  }
  await writeFile(report, `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(JSON.stringify(evidence))
} finally {
  await server.stop(true)
  await rm(root, { recursive: true, force: true })
}

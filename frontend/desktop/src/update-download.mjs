import { createHash } from "node:crypto"
import { constants, createReadStream, createWriteStream } from "node:fs"
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { Readable, Transform } from "node:stream"
import { pipeline } from "node:stream/promises"
import { gunzipSync } from "node:zlib"

export const blockmapLimit = 4 * 1024 * 1024
const cacheName = "download-cache"
const quiet = { info() {}, warn() {} }

async function digest(file) {
  const hash = createHash("sha256")
  for await (const bytes of createReadStream(file)) hash.update(bytes)
  return hash.digest("hex")
}

/** Bound the planner's input before it allocates maps or touches cached bytes. */
export function parseBlockmap(bytes, size) {
  if (bytes.length > blockmapLimit) throw new Error("Update block map is too large")
  const map = JSON.parse(gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 }).toString("utf8"))
  const file = map.files?.[0]
  if (
    map.version !== "2" ||
    map.files.length !== 1 ||
    file.name !== "file" ||
    file.offset !== 0 ||
    !Array.isArray(file.sizes) ||
    !Array.isArray(file.checksums) ||
    !file.sizes.length ||
    file.sizes.length > 262_144 ||
    file.checksums.length !== file.sizes.length ||
    file.sizes.some((value) => !Number.isSafeInteger(value) || value <= 0 || value > size) ||
    file.checksums.some((value) => typeof value !== "string" || !/^[A-Za-z0-9+/=]{1,128}$/.test(value)) ||
    file.sizes.reduce((sum, value) => sum + value, 0) !== size
  ) {
    throw new Error("Invalid update block map")
  }
  return map
}

async function metadata(info, options) {
  if (!info.blockmap) return
  const response = await (options.fetch ?? fetch)(info.blockmap.url, {
    headers: { "User-Agent": `OpenScience/${info.version}` },
    signal: AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]),
  })
  if (!response.ok || !response.body) throw new Error("Update block map is unavailable")
  const chunks = []
  let length = 0
  for await (const chunk of response.body) {
    length += chunk.length
    if (length > info.blockmap.size) throw new Error("Update block map exceeded its published size")
    chunks.push(chunk)
  }
  const bytes = Buffer.concat(chunks)
  if (length !== info.blockmap.size || createHash("sha256").update(bytes).digest("hex") !== info.blockmap.digest) {
    throw new Error("Update block map digest mismatch")
  }
  return { bytes, map: parseBlockmap(bytes, info.size) }
}

async function baseline(cache, name, options) {
  const directory = path.join(cache, cacheName)
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) return
  const manifest = path.join(directory, "manifest.json")
  const stat = await lstat(manifest)
  if (!stat.isFile() || stat.size > 4_096) return
  const stored = JSON.parse(await readFile(manifest, "utf8"))
  if (
    stored.schema !== 1 ||
    stored.name !== name ||
    !Number.isSafeInteger(stored.size) ||
    stored.size <= 0 ||
    stored.size > 2 * 1024 * 1024 * 1024 ||
    !/^[0-9a-f]{64}$/.test(stored.digest ?? "")
  )
    return
  const archive = path.join(directory, "archive.zip")
  const mapfile = path.join(directory, "archive.blockmap")
  const zip = await lstat(archive)
  if (!zip.isFile() || zip.size !== stored.size) return
  // A cache is only an optimization, never an authority for the installed app.
  if ((await digest(archive)) !== stored.digest) return
  const map = await lstat(mapfile).catch(() => undefined)
  if (map?.isFile() && map.size <= blockmapLimit) {
    return { archive, map: parseBlockmap(await readFile(mapfile), stored.size) }
  }
  // The first upgraded app rescues its ZIP from the legacy helper before cleanup.
  // Fetch its small map on the next update, without delaying startup on the network.
  if (!/^\d+\.\d+\.\d+$/.test(stored.version ?? "") || !options.resolveRelease) return
  const release = await options.resolveRelease(stored.version)
  if (release.name !== stored.name || release.size !== stored.size || release.digest !== stored.digest) return
  const received = await metadata(release, options)
  return received ? { archive, map: received.map } : undefined
}

export async function cacheArchive(info, archive, blockmap, cache) {
  const directory = path.join(cache, cacheName)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (!(await lstat(directory)).isDirectory()) throw new Error("Invalid update download cache")
  const pending = await mkdtemp(path.join(directory, "pending-"))
  const temporary = path.join(pending, "archive.zip")
  const mapfile = path.join(pending, "archive.blockmap")
  const manifest = path.join(pending, "manifest.json")
  try {
    await copyFile(archive, temporary, constants.COPYFILE_FICLONE)
    if (blockmap) await writeFile(mapfile, blockmap.bytes, { mode: 0o600 })
    await writeFile(
      manifest,
      JSON.stringify({ schema: 1, version: info.version, name: info.name, size: info.size, digest: info.digest }),
      {
        mode: 0o600,
      },
    )
    await rename(temporary, path.join(directory, "archive.zip"))
    if (blockmap) await rename(mapfile, path.join(directory, "archive.blockmap"))
    else await rm(path.join(directory, "archive.blockmap"), { force: true })
    // Publish last. An interrupted replacement simply fails cache validation.
    await rename(manifest, path.join(directory, "manifest.json"))
  } finally {
    await rm(pending, { recursive: true, force: true })
  }
}

export async function seedArchive(cache, request, name) {
  if (!request || !/^[0-9a-f]{48}$/.test(request.token ?? "") || !/^\d+\.\d+\.\d+$/.test(request.version ?? "")) return
  const journal = path.join(cache, `transaction-${request.token}.json`)
  const stat = await lstat(journal)
  if (!stat.isFile() || stat.size > 16_384) return
  const transaction = JSON.parse(await readFile(journal, "utf8"))
  if (
    transaction.token !== request.token ||
    transaction.version !== request.version ||
    transaction.state !== "activated" ||
    typeof transaction.root !== "string" ||
    path.dirname(transaction.root) !== cache ||
    !/^pending-[A-Za-z0-9]+$/.test(path.basename(transaction.root)) ||
    !(await lstat(transaction.root)).isDirectory()
  )
    return
  const manifest = path.join(transaction.root, "manifest.json")
  const entry = await lstat(manifest)
  if (!entry.isFile() || entry.size > 4_096) return
  const info = JSON.parse(await readFile(manifest, "utf8"))
  if (
    info.version !== request.version ||
    info.name !== name ||
    !/^[0-9a-f]{64}$/.test(info.digest ?? "") ||
    !Number.isSafeInteger(info.size) ||
    info.size <= 0 ||
    info.size > 2 * 1024 * 1024 * 1024
  )
    return
  const archive = path.join(transaction.root, name)
  const file = await lstat(archive)
  if (!file.isFile() || file.size !== info.size) return
  const existing = await readFile(path.join(cache, cacheName, "manifest.json"), "utf8")
    .then(JSON.parse)
    .catch(() => undefined)
  if (existing?.digest === info.digest && existing?.name === name) return
  await cacheArchive(info, archive, undefined, cache)
}

async function reconstruct(info, archive, previous, blockmap, options) {
  // Pin this internal, download-only API; no Squirrel installer or native updater is loaded.
  const { computeOperations, OperationKind } =
    await import("electron-updater/out/differentialDownloader/downloadPlanBuilder.js")
  const operations = computeOperations(previous.map, blockmap.map, quiet)
  const tasks = []
  let offset = 0
  for (const operation of operations) {
    const size = operation.end - operation.start
    if (!Number.isSafeInteger(size) || size <= 0) throw new Error("Invalid update range")
    tasks.push({ ...operation, offset })
    offset += size
  }
  if (offset !== info.size) throw new Error("Update plan size mismatch")
  // Fetch small unchanged gaps too: hundreds of tiny requests cost more than these bytes.
  for (let index = 1; index < tasks.length - 1;) {
    const before = tasks[index - 1]
    const gap = tasks[index]
    const after = tasks[index + 1]
    if (before.kind === 1 && gap.kind === 0 && after.kind === 1 && gap.end - gap.start <= 64 * 1024) {
      before.end = after.end
      tasks.splice(index, 2)
    } else index++
  }
  const ranges = tasks.filter((task) => task.kind === OperationKind.DOWNLOAD)
  const total = ranges.reduce((sum, task) => sum + task.end - task.start, 0)
  if (ranges.length > 256 || total >= info.size * 0.9) throw new Error("A full update is more efficient")
  const controller = new AbortController()
  const signal = AbortSignal.any([options.signal, controller.signal])
  const output = await open(archive, "w", 0o600)
  await output.truncate(info.size).finally(() => output.close())
  let transferred = 0
  let next = 0
  options.onProgress?.({ phase: "downloading", transferred, total })
  const worker = async () => {
    while (next < tasks.length) {
      signal.throwIfAborted()
      const task = tasks[next++]
      const size = task.end - task.start
      const source = await (async () => {
        if (task.kind === OperationKind.COPY) {
          return createReadStream(previous.archive, { start: task.start, end: task.end - 1 })
        }
        const response = await (options.fetch ?? fetch)(info.url, {
          headers: { Range: `bytes=${task.start}-${task.end - 1}`, "User-Agent": `OpenScience/${info.version}` },
          signal,
        })
        if (
          response.status !== 206 ||
          response.headers.get("content-range") !== `bytes ${task.start}-${task.end - 1}/${info.size}` ||
          !response.body
        ) {
          await response.body?.cancel()
          throw new Error("Update server did not honor the exact byte range")
        }
        return Readable.fromWeb(response.body)
      })()
      let received = 0
      const bounded = new Transform({
        transform(chunk, encoding, done) {
          received += chunk.length
          if (received > size) return done(new Error("Update range exceeded its expected size"))
          if (task.kind === OperationKind.DOWNLOAD) {
            transferred += chunk.length
            options.onProgress?.({ phase: "downloading", transferred, total })
          }
          done(null, chunk)
        },
      })
      await pipeline(source, bounded, createWriteStream(archive, { flags: "r+", start: task.offset }), { signal })
      if (received !== size) throw new Error("Update range is incomplete")
    }
  }
  const settled = await Promise.allSettled(
    Array.from({ length: 4 }, () =>
      worker().catch((error) => {
        controller.abort(error)
        throw error
      }),
    ),
  )
  const failed = settled.find((result) => result.status === "rejected")
  if (failed) throw failed.reason
  if ((await digest(archive)) !== info.digest) throw new Error("Reconstructed update digest mismatch")
  return transferred
}

/** Every optimization failure falls back before extraction; cancellation remains cancellation. */
export async function downloadChanges(info, archive, options) {
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(30 * 60_000)])
    : AbortSignal.timeout(30 * 60_000)
  const settings = { ...options, signal }
  const optional = (error) => {
    signal.throwIfAborted()
    options.onFallback?.(error.message)
    return undefined
  }
  const blockmap = await metadata(info, settings).catch(optional)
  if (!blockmap) return { method: "full" }
  const previous = await baseline(options.cache, info.name, settings).catch(optional)
  if (!previous) return { method: "full", blockmap }
  const bytes = await reconstruct(info, archive, previous, blockmap, settings).catch(optional)
  return { method: bytes === undefined ? "full" : "differential", bytes, blockmap }
}

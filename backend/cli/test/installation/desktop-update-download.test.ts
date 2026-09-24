import { afterEach, expect, test } from "bun:test"
import { createHash, randomBytes } from "node:crypto"
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { gzipSync } from "node:zlib"
import { blockmap } from "../../../../frontend/desktop/script/update-blockmap.mjs"
import {
  cacheArchive,
  downloadChanges,
  parseBlockmap,
  seedArchive,
} from "../../../../frontend/desktop/src/update-download.mjs"

const roots: string[] = []
const servers: ReturnType<typeof Bun.serve>[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop(true)
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")

async function fixture(replace = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), "openscience-differential-"))
  roots.push(root)
  const cache = path.join(root, "cache")
  await mkdir(cache)
  const old = randomBytes(2 * 1024 * 1024)
  // Insertions exercise shifted COPY offsets, not just same-position replacement.
  const next = replace
    ? randomBytes(old.length)
    : Buffer.concat([old.subarray(0, 800_000), randomBytes(16_384), old.subarray(800_000)])
  const previous = path.join(root, "old.zip")
  const archive = path.join(root, "next.zip")
  const output = path.join(root, "reconstructed.zip")
  await Promise.all([Bun.write(previous, old), Bun.write(archive, next)])
  const [oldmap, newmap] = await Promise.all([blockmap(previous), blockmap(archive)])
  const before = await readFile(oldmap)
  const after = await readFile(newmap)
  const state = { mode: "range", bytes: 0, ranges: 0, maps: 0 }
  const controller = new AbortController()
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === "/old-map") return new Response(new Uint8Array(before))
      if (new URL(request.url).pathname === "/map") {
        state.maps++
        return new Response(new Uint8Array(state.mode === "bad-map" ? Buffer.from("invalid map") : after))
      }
      state.ranges++
      const match = /^bytes=(\d+)-(\d+)$/.exec(request.headers.get("range") ?? "")
      if (!match) throw new Error("Expected a byte range")
      const start = Number(match[1])
      const end = Number(match[2])
      if (state.mode === "abort") controller.abort(new Error("cancelled by user"))
      const bytes = state.mode === "full" ? next : next.subarray(start, end + (state.mode === "truncated" ? 0 : 1))
      const data = state.mode === "corrupt" ? Buffer.alloc(bytes.length, 1) : bytes
      state.bytes += data.length
      return new Response(new Uint8Array(data), {
        status: state.mode === "full" ? 200 : 206,
        headers: { "Content-Range": `bytes ${state.mode === "wrong-range" ? start + 1 : start}-${end}/${next.length}` },
      })
    },
  })
  servers.push(server)
  const info = {
    name: "OpenScience-mac-arm64.zip",
    version: "2.0.139",
    size: next.length,
    digest: hash(next),
    url: new URL("/zip", server.url).href,
    blockmap: { size: after.length, digest: hash(after), url: new URL("/map", server.url).href },
  }
  await cacheArchive({ ...info, size: old.length, digest: hash(old) }, previous, { bytes: before }, cache)
  return { root, cache, output, previous, next, before, after, info, state, controller, server }
}

test("uses the full download when nearly all archive bytes changed", async () => {
  const value = await fixture(true)
  const reasons: string[] = []
  const result = await downloadChanges(value.info, value.output, {
    cache: value.cache,
    onFallback: (reason: string) => reasons.push(reason),
  })
  expect(result.method).toBe("full")
  expect(reasons).toEqual(["A full update is more efficient"])
  expect(value.state.ranges).toBe(0)
})

test("the first upgraded app retains the legacy helper ZIP and fetches only its map on the next update", async () => {
  const value = await fixture()
  await rm(path.join(value.cache, "download-cache"), { recursive: true })
  const pending = path.join(value.cache, "pending-legacy")
  await mkdir(pending)
  const bytes = await readFile(value.previous)
  const info = { ...value.info, version: "2.0.133", size: bytes.length, digest: hash(bytes) }
  const request = { token: "a".repeat(48), version: info.version }
  const transaction = { ...request, root: pending, state: "activated" }
  await Bun.write(path.join(value.cache, `transaction-${request.token}.json`), JSON.stringify(transaction))
  await Bun.write(path.join(pending, "manifest.json"), JSON.stringify(info))
  await Bun.write(path.join(pending, info.name), bytes)
  await seedArchive(value.cache, request, info.name)
  await rm(pending, { recursive: true })
  const resolved: string[] = []
  const result = await downloadChanges(value.info, value.output, {
    cache: value.cache,
    resolveRelease: async (version: string) => {
      resolved.push(version)
      return {
        ...info,
        blockmap: {
          size: value.before.length,
          digest: hash(value.before),
          url: new URL("/old-map", value.server.url).href,
        },
      }
    },
  })
  expect(resolved).toEqual(["2.0.133"])
  expect(result.method).toBe("differential")
  expect(await readFile(value.output)).toEqual(value.next)

  await Bun.write(
    path.join(value.cache, `transaction-${request.token}.json`),
    JSON.stringify({ ...transaction, root: value.root }),
  )
  await seedArchive(value.cache, request, info.name)
  expect(await readFile(path.join(value.cache, "download-cache", "archive.zip"))).toEqual(bytes)
})

test("reconstructs a skipped-version update from shifted cached chunks over real HTTP", async () => {
  const value = await fixture()
  const progress: Array<{ transferred: number; total: number }> = []
  const result = await downloadChanges(value.info, value.output, {
    cache: value.cache,
    onProgress: (event: { transferred: number; total: number }) => progress.push(event),
  })
  expect(result.method).toBe("differential")
  expect(await readFile(value.output)).toEqual(value.next)
  expect(value.state.ranges).toBeGreaterThan(0)
  expect(value.state.bytes).toBeLessThan(value.next.length / 5)
  expect(result.bytes).toBe(value.state.bytes)
  expect(progress.at(-1)).toMatchObject({ transferred: result.bytes, total: result.bytes })

  await cacheArchive(value.info, value.output, result.blockmap, value.cache)
  const again = await downloadChanges(value.info, value.output, { cache: value.cache })
  expect(again.method).toBe("differential")
  expect(again.bytes).toBe(0)
  expect(await readFile(value.output)).toEqual(value.next)
})

test("bootstraps a missing cache with the verified full download's block map", async () => {
  const value = await fixture()
  await rm(value.cache, { recursive: true })
  const result = await downloadChanges(value.info, value.output, { cache: value.cache })
  expect(result.method).toBe("full")
  expect(result.blockmap).toBeDefined()
  expect(value.state.ranges).toBe(0)
  await cacheArchive(value.info, path.join(value.root, "next.zip"), result.blockmap, value.cache)
  expect((await downloadChanges(value.info, value.output, { cache: value.cache })).method).toBe("differential")
})

for (const mode of ["full", "wrong-range", "truncated", "corrupt", "bad-map"]) {
  test(`falls back when the server returns ${mode}`, async () => {
    const value = await fixture()
    value.state.mode = mode
    const reasons: string[] = []
    const result = await downloadChanges(value.info, value.output, {
      cache: value.cache,
      onFallback: (reason: string) => reasons.push(reason),
    })
    expect(result.method).toBe("full")
    expect(reasons.length).toBeGreaterThan(0)
    // A failed transfer never replaces the previous known-good cache.
    expect(await readFile(path.join(value.cache, "download-cache", "archive.zip"))).toEqual(
      await readFile(value.previous),
    )
  })
}

test("cancellation aborts the operation instead of starting a full download", async () => {
  const value = await fixture()
  value.state.mode = "abort"
  await expect(
    downloadChanges(value.info, value.output, { cache: value.cache, signal: value.controller.signal }),
  ).rejects.toThrow("cancelled by user")
})

test("old releases without block maps keep the full download path", async () => {
  const value = await fixture()
  expect(await downloadChanges({ ...value.info, blockmap: undefined }, value.output, { cache: value.cache })).toEqual({
    method: "full",
  })
  expect(value.state.maps).toBe(0)
  expect(value.state.ranges).toBe(0)
})

test("does not reuse a different architecture's cache", async () => {
  const value = await fixture()
  const result = await downloadChanges({ ...value.info, name: "OpenScience-mac-x64.zip" }, value.output, {
    cache: value.cache,
  })
  expect(result.method).toBe("full")
  expect(value.state.ranges).toBe(0)
})

for (const file of ["archive.zip", "archive.blockmap", "manifest.json"]) {
  test(`ignores damaged cached ${file}`, async () => {
    const value = await fixture()
    await Bun.write(path.join(value.cache, "download-cache", file), "damaged")
    expect((await downloadChanges(value.info, value.output, { cache: value.cache })).method).toBe("full")
    expect(value.state.ranges).toBe(0)
  })
}

test("rejects invalid and oversized block-map plans before invoking the planner", () => {
  const map = { version: "2", files: [{ name: "file", offset: 0, sizes: [4], checksums: ["AAAA"] }] }
  expect(parseBlockmap(gzipSync(JSON.stringify(map)), 4)).toEqual(map)
  expect(() => parseBlockmap(gzipSync(JSON.stringify(map)), 5)).toThrow("Invalid update block map")
  expect(() => parseBlockmap(gzipSync(JSON.stringify({ ...map, version: "3" })), 4)).toThrow()
  expect(() => parseBlockmap(Buffer.alloc(4 * 1024 * 1024 + 1), 4)).toThrow("too large")
  expect(() => parseBlockmap(gzipSync(Buffer.alloc(33 * 1024 * 1024)), 4)).toThrow()
})

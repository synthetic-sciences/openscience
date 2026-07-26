import { describe, expect, test } from "bun:test"
import { createSearchCache } from "../../src/file/search-cache"

describe("createSearchCache", () => {
  test("shares the initial scan across concurrent reads", async () => {
    let scans = 0
    let finish!: (value: string[]) => void
    const cache = createSearchCache({
      scan: () => {
        scans++
        return new Promise<string[]>((resolve) => {
          finish = resolve
        })
      },
      empty: () => [],
      maxAgeMs: 5_000,
    })

    cache.prime()
    const first = cache.read()
    const second = cache.read()
    expect(scans).toBe(1)

    finish(["atlas.ts"])
    expect(await first).toEqual(["atlas.ts"])
    expect(await second).toEqual(["atlas.ts"])
  })

  test("does not rescan for every search inside the freshness window", async () => {
    let scans = 0
    let now = 1
    const cache = createSearchCache({
      scan: async () => [`scan-${++scans}`],
      empty: () => [],
      maxAgeMs: 5_000,
      now: () => now,
    })

    expect(await cache.read()).toEqual(["scan-1"])
    for (let i = 0; i < 100; i++) {
      expect(await cache.read()).toEqual(["scan-1"])
    }
    expect(scans).toBe(1)

    now += 5_000
    expect(await cache.read()).toEqual(["scan-1"])
    expect(scans).toBe(2)
  })

  test("invalidations trigger one background refresh and keep cached reads responsive", async () => {
    let scans = 0
    const cache = createSearchCache({
      scan: async () => [`scan-${++scans}`],
      empty: () => [],
      maxAgeMs: 5_000,
    })

    expect(await cache.read()).toEqual(["scan-1"])

    cache.invalidate()
    const next = cache.read()
    const concurrent = cache.read()
    expect(await next).toEqual(["scan-1"])
    expect(await concurrent).toEqual(["scan-1"])
    expect(scans).toBe(2)
  })
})

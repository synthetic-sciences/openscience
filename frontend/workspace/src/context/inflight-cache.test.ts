import { expect, test } from "bun:test"
import { createInflightCache } from "./inflight-cache"

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

test("shares one load between concurrent callers", async () => {
  let loads = 0
  const cache = createInflightCache(async () => {
    loads++
    await wait(5)
    return loads
  })

  const [a, b] = await Promise.all([cache.get("k"), cache.get("k")])

  expect(loads).toBe(1)
  expect(a).toBe(b)
})

test("keeps separate keys apart", async () => {
  const cache = createInflightCache(async (key: string) => key)

  expect(await cache.get("a")).toBe("a")
  expect(await cache.get("b")).toBe("b")
})

test("loads again once the shared window has passed", async () => {
  let loads = 0
  const cache = createInflightCache(
    async () => {
      loads++
      return loads
    },
    { holdMs: 5 },
  )

  await cache.get("k")
  await wait(20)
  await cache.get("k")

  expect(loads).toBe(2)
})

test("does not cache a failure", async () => {
  let loads = 0
  const cache = createInflightCache(async () => {
    loads++
    throw new Error("boom")
  })

  await cache.get("k").catch(() => undefined)
  await cache.get("k").catch(() => undefined)

  expect(loads).toBe(2)
})

// A load that never settles used to stay in the map forever, so every later
// call handed back the dead promise and no request was ever made again — the
// provider list simply stopped refreshing for the life of the page.
test("a load that never settles does not pin the key", async () => {
  let loads = 0
  const cache = createInflightCache(
    async () => {
      loads++
      if (loads === 1) return new Promise<number>(() => {}) // never settles
      return loads
    },
    { timeoutMs: 10 },
  )

  const stuck = cache.get("k").catch(() => "timed out")
  expect(await stuck).toBe("timed out")

  expect(await cache.get("k")).toBe(2)
  expect(loads).toBe(2)
})

test("invalidate forces the next call to load again", async () => {
  let loads = 0
  const cache = createInflightCache(async () => ++loads)

  await cache.get("k")
  cache.invalidate("k")
  await cache.get("k")

  expect(loads).toBe(2)
})

test("invalidate with no key clears every entry", async () => {
  let loads = 0
  const cache = createInflightCache(async () => ++loads)

  await Promise.all([cache.get("a"), cache.get("b")])
  cache.invalidate()
  await Promise.all([cache.get("a"), cache.get("b")])

  expect(loads).toBe(4)
})

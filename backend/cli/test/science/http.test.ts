import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { getJSON, getText, request, clearCache, resetRateLimits, orFallback } from "../../src/science/connectors/http"

// The shared http helper is the ONLY reliability layer under science/connectors,
// yet had zero tests. These stub globalThis.fetch to exercise retry/backoff, the
// negative-cache rules, content negotiation, and the per-host throttle.

const realFetch = globalThis.fetch

beforeEach(() => {
  clearCache()
  resetRateLimits()
})

afterEach(() => {
  globalThis.fetch = realFetch
})

describe("http retry / backoff", () => {
  test("retries a 429, honors Retry-After, then succeeds", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      if (calls === 1) return new Response("", { status: 429, headers: { "Retry-After": "0.05" } })
      return new Response("ok", { status: 200 })
    }) as unknown as typeof fetch

    const started = Date.now()
    const body = await getText("https://retry.test/a")
    expect(body).toBe("ok")
    expect(calls).toBe(2)
    // Retry-After: 0.05s must actually be waited (not the exp-backoff default).
    expect(Date.now() - started).toBeGreaterThanOrEqual(40)
  })

  test("gives up after exhausting retries and throws with the status", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response("boom", { status: 429, headers: { "Retry-After": "0" } })
    }) as unknown as typeof fetch

    await expect(getText("https://fail.test/a", { retries: 2 })).rejects.toThrow(/429/)
    expect(calls).toBe(3) // 1 initial attempt + 2 retries
  })

  test("does not retry a non-retryable 4xx", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response("nope", { status: 404 })
    }) as unknown as typeof fetch

    await expect(getText("https://notfound.test/a")).rejects.toThrow(/404/)
    expect(calls).toBe(1)
  })
})

describe("http caching", () => {
  test("caches a valid GET and serves the second call from cache", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response("payload", { status: 200 })
    }) as unknown as typeof fetch

    expect(await getText("https://cache.test/a")).toBe("payload")
    expect(await getText("https://cache.test/a")).toBe("payload")
    expect(calls).toBe(1)
  })

  test("does not cache an empty 2xx body (negative cache)", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response("", { status: 200 })
    }) as unknown as typeof fetch

    await getText("https://empty.test/a")
    await getText("https://empty.test/a")
    expect(calls).toBe(2)
  })

  test("does not cache a body the caller rejects via looksValid", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response("<html>not json</html>", { status: 200 })
    }) as unknown as typeof fetch

    const looksValid = (body: string) => body.trimStart().startsWith("{")
    await getText("https://invalid.test/a", { looksValid })
    await getText("https://invalid.test/a", { looksValid })
    expect(calls).toBe(2)
  })
})

describe("http content negotiation", () => {
  test("request defaults Accept to */*, getJSON asks for application/json", async () => {
    const seen: { accept: string | null } = { accept: null }
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      seen.accept = new Headers(init?.headers).get("accept")
      return new Response("{}", { status: 200 })
    }) as unknown as typeof fetch

    await getText("https://accept.test/text")
    expect(seen.accept).toBe("*/*")

    await getJSON("https://accept.test/json")
    expect(seen.accept).toBe("application/json")
  })
})

describe("http per-host throttle", () => {
  test("spaces requests to the same host by the min interval", async () => {
    globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch

    const starts: number[] = []
    const t0 = Date.now()
    const rateLimit = { minIntervalMs: 60 }
    const record = (n: number) =>
      request(`https://paced.test/${n}`, { rateLimit, cacheTtl: 0 }).then(() => starts.push(Date.now() - t0))

    await Promise.all([record(1), record(2), record(3)])
    starts.sort((a, b) => a - b)
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(45)
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(45)
  })

  test("different hosts are not serialized against each other", async () => {
    globalThis.fetch = (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch

    const t0 = Date.now()
    await Promise.all([
      request("https://one.test/x", { rateLimit: { minIntervalMs: 500 }, cacheTtl: 0 }),
      request("https://two.test/x", { rateLimit: { minIntervalMs: 500 }, cacheTtl: 0 }),
    ])
    // Two distinct hosts run concurrently — neither pays the other's interval.
    expect(Date.now() - t0).toBeLessThan(400)
  })
})

describe("orFallback (abort-preserving fallback)", () => {
  test("returns the fallback when the promise rejects and the signal is not aborted", async () => {
    const result = await orFallback(
      Promise.reject(new Error("source down")),
      { hits: [] },
      new AbortController().signal,
    )
    expect(result).toEqual({ hits: [] })
  })

  test("returns the resolved value on success, ignoring the fallback", async () => {
    const result = await orFallback(Promise.resolve("real"), "fallback", new AbortController().signal)
    expect(result).toBe("real")
  })

  test("rethrows (does NOT fall back) when the caller's signal is aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const err = new DOMException("The operation was aborted.", "AbortError")
    await expect(orFallback(Promise.reject(err), "fallback", controller.signal)).rejects.toThrow(/aborted/)
  })

  test("falls back when no signal is supplied", async () => {
    const result = await orFallback(Promise.reject(new Error("nope")), 42)
    expect(result).toBe(42)
  })

  test("a real search cancellation propagates through request() and orFallback", async () => {
    const controller = new AbortController()
    // Model real fetch: reject with an AbortError as soon as the signal is
    // aborted — including when it is already aborted by the time fetch runs.
    globalThis.fetch = ((_url: string, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        const sig = init?.signal
        const fail = () => reject(new DOMException("aborted", "AbortError"))
        if (sig?.aborted) return fail()
        sig?.addEventListener("abort", fail, { once: true })
      })) as unknown as typeof fetch

    const search = orFallback(
      getJSON("https://slow.test/q", { signal: controller.signal }),
      { hits: [] },
      controller.signal,
    )
    controller.abort()
    // The cancellation surfaces instead of being masked as an empty result.
    await expect(search).rejects.toThrow()
  })
})

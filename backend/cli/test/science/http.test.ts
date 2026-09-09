import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  getJSON as getJSONRaw,
  getText as getTextRaw,
  request as requestRaw,
  backoffMs,
  clearCache,
  resetRateLimits,
  orNotFound,
  HttpStatusError,
  type HttpOptions,
} from "../../src/science/connectors/http"
import { Network } from "../../src/settings/network"

// The shared http helper is the ONLY reliability layer under science/connectors,
// yet had zero tests. These stub globalThis.fetch to exercise retry/backoff, the
// negative-cache rules, content negotiation, and the per-host throttle.

const realFetch = globalThis.fetch
const publicResolution = async () => ["93.184.216.34"]
const withResolution = (opts: HttpOptions = {}): HttpOptions => ({ ...opts, resolveAddresses: publicResolution })
const getText = (url: string, opts?: HttpOptions) => getTextRaw(url, withResolution(opts))
const getJSON = (url: string, opts?: HttpOptions) => getJSONRaw(url, withResolution(opts))
const request = (url: string, opts?: HttpOptions) => requestRaw(url, withResolution(opts))

beforeEach(async () => {
  clearCache()
  resetRateLimits()
  await Network.set({ allowlistEnabled: false, enabled: ["package-management"], custom: [] })
})

afterEach(async () => {
  globalThis.fetch = realFetch
  await Network.set({ allowlistEnabled: false, enabled: ["package-management"], custom: [] })
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

  test("preserves server cooldowns including HTTP dates", () => {
    const limited = (retryAfter: string) => new Response("", { status: 429, headers: { "Retry-After": retryAfter } })
    // Long cooldowns are surfaced to the caller without an early retry.
    expect(backoffMs(limited("120"), 0)).toBe(120_000)
    expect(backoffMs(limited("3600"), 2)).toBe(3_600_000)
    // Short and zero waits are still taken literally; negative values never underflow.
    expect(backoffMs(limited("2"), 0)).toBe(2_000)
    expect(backoffMs(limited("0"), 3)).toBe(0)
    expect(backoffMs(limited("-5"), 0)).toBe(0)
    // Without a usable header the exponential path applies, with the same ceiling.
    expect(backoffMs(limited("Wed, 21 Oct 2015 07:28:00 GMT"), 0)).toBeLessThan(1_250)
    expect(backoffMs(undefined, 10)).toBeLessThan(15_250)
    expect(backoffMs(undefined, 10)).toBeGreaterThanOrEqual(15_000)
  })

  test.each(["120", new Date(Date.now() + 120_000).toUTCString()])(
    "returns a long cooldown without retrying: %s",
    async (header) => {
      let calls = 0
      globalThis.fetch = (async () => {
        calls++
        return new Response("busy", { status: 429, headers: { "Retry-After": header } })
      }) as unknown as typeof fetch
      await expect(getText("https://cooldown.test/a")).rejects.toThrow("no automatic retry")
      expect(calls).toBe(1)
    },
  )

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
      return new Response("valid text that does not match the caller cache gate", { status: 200 })
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

describe("http network allow-list", () => {
  test("blocks disallowed hosts before fetch", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response("ok", { status: 200 })
    }) as unknown as typeof fetch

    await Network.set({ allowlistEnabled: true, enabled: [], custom: ["allowed.test"] })

    await expect(getText("https://blocked.test/a")).rejects.toThrow("allow-list")
    expect(calls).toBe(0)
  })

  test("blocks a redirect to a disallowed host before following it", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response(null, { status: 302, headers: { Location: "https://blocked.test/private" } })
    }) as unknown as typeof fetch
    await Network.set({ allowlistEnabled: true, enabled: [], custom: ["allowed.test"] })

    await expect(getText("https://allowed.test/start", { retries: 0 })).rejects.toThrow("blocked.test")
    expect(calls).toBe(1)
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

describe("documented missing-record fallback", () => {
  test("only HTTP 404 is a missing record", async () => {
    expect(await orNotFound(Promise.reject(new HttpStatusError(404, "missing")), [])).toEqual([])
    for (const error of [
      new Error("source down"),
      new HttpStatusError(401, "unauthorized"),
      new HttpStatusError(429, "limited"),
      new DOMException("aborted", "AbortError"),
    ]) {
      await expect(orNotFound(Promise.reject(error), [])).rejects.toThrow()
    }
  })
  test("preserves a successful value", async () => {
    expect(await orNotFound(Promise.resolve("record"), "missing")).toBe("record")
  })
})

describe("scientific text and JSON content contracts", () => {
  test("bracketed SDF titles remain plain text", async () => {
    const body = "[Na+]\nRDKit fixture\n\n  1  0  0  0  0  0            999 V2000\nM  END\n$$$$\n"
    globalThis.fetch = (async () =>
      new Response(body, { headers: { "content-type": "chemical/x-mdl-sdfile" } })) as unknown as typeof fetch
    expect(await getText("https://fixture.test/bracketed.sdf")).toBe(body)
  })
  test("malformed requested JSON is rejected before caching", async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return new Response(calls === 1 ? "{malformed" : "{}")
    }) as unknown as typeof fetch
    await expect(getJSON("https://fixture.test/record")).rejects.toThrow()
    expect(await getJSON("https://fixture.test/record")).toEqual({})
    expect(calls).toBe(2)
  })
})

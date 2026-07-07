import { test, expect, afterEach } from "bun:test"
import { refreshAccessToken, CodexRefreshInvalidError } from "../../src/plugin/codex"

// The refresh path decides whether a Codex user gets a transparent re-auth or a
// spurious "sign-in expired". It must NOT retry (and must say "reconnect") on a
// real 4xx, but MUST retry a transient 5xx/network blip and recover.

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

test("a 4xx rejects with CodexRefreshInvalidError and does not retry", async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    return new Response("invalid_grant", { status: 400 })
  }) as unknown as typeof fetch
  await expect(refreshAccessToken("rt")).rejects.toBeInstanceOf(CodexRefreshInvalidError)
  expect(calls).toBe(1)
})

test("a transient 5xx is retried, then succeeds", async () => {
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    if (calls < 2) return new Response("upstream", { status: 503 })
    return Response.json({ access_token: "a1", refresh_token: "r1", expires_in: 3600 })
  }) as unknown as typeof fetch
  const tokens = await refreshAccessToken("rt")
  expect(tokens.access_token).toBe("a1")
  expect(calls).toBe(2)
})

test("a 429 (rate limit) is retried, not treated as expired", async () => {
  // During a retry storm the token endpoint rate-limits; that's transient, not
  // a revoked refresh token — must NOT throw CodexRefreshInvalidError.
  let calls = 0
  globalThis.fetch = (async () => {
    calls++
    if (calls < 2) return new Response("rate limited", { status: 429 })
    return Response.json({ access_token: "a1", refresh_token: "r1", expires_in: 3600 })
  }) as unknown as typeof fetch
  const tokens = await refreshAccessToken("rt")
  expect(tokens.access_token).toBe("a1")
  expect(calls).toBe(2)
})

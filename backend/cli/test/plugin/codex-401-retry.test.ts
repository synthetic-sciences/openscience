import { test, expect } from "bun:test"
import { sendWithCodex401Retry } from "../../src/plugin/codex"

// A Codex token can be revoked/invalidated server-side before its local
// `expires`, surfacing as a 401. That must trigger exactly one refresh + one
// retry — never a verbatim failure, and never an infinite loop.

test("a 2xx response returns immediately without refreshing", async () => {
  let sends = 0
  let refreshes = 0
  const res = await sendWithCodex401Retry(
    async () => {
      sends++
      return new Response("ok", { status: 200 })
    },
    "access-1",
    async () => {
      refreshes++
      return "access-2"
    },
  )
  expect(res.status).toBe(200)
  expect(sends).toBe(1)
  expect(refreshes).toBe(0)
})

test("a 401 refreshes once and retries once with the new token", async () => {
  const tokens: string[] = []
  let refreshes = 0
  const res = await sendWithCodex401Retry(
    async (token) => {
      tokens.push(token)
      return new Response(null, { status: tokens.length === 1 ? 401 : 200 })
    },
    "stale",
    async () => {
      refreshes++
      return "fresh"
    },
  )
  expect(res.status).toBe(200)
  expect(refreshes).toBe(1)
  expect(tokens).toEqual(["stale", "fresh"])
})

test("when refresh gives up (undefined), the original 401 is returned unchanged", async () => {
  let sends = 0
  const res = await sendWithCodex401Retry(
    async () => {
      sends++
      return new Response("unauthorized", { status: 401 })
    },
    "stale",
    async () => undefined,
  )
  expect(res.status).toBe(401)
  expect(sends).toBe(1)
})

test("retries at most once — a persistent 401 does not loop", async () => {
  let sends = 0
  const res = await sendWithCodex401Retry(
    async () => {
      sends++
      return new Response(null, { status: 401 })
    },
    "stale",
    async () => "fresh",
  )
  expect(res.status).toBe(401)
  expect(sends).toBe(2)
})

test("a fatal refresh error propagates to the caller", async () => {
  await expect(
    sendWithCodex401Retry(
      async () => new Response(null, { status: 401 }),
      "stale",
      async () => {
        throw new Error("Codex sign-in expired. Reconnect it with `openscience keys signin`.")
      },
    ),
  ).rejects.toThrow("Reconnect it with")
})

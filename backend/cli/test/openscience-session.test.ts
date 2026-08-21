import { test, expect, afterEach } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Global } from "../src/global"
import { OpenScience } from "../src/openscience"
import { CredentialLifecycle } from "../src/credentials/lifecycle"

const file = path.join(Global.Path.data, "openscience-session.json")
const original = globalThis.fetch

afterEach(async () => {
  globalThis.fetch = original
  await fs.rm(file, { force: true }).catch(() => {})
})

test("getSession carries the sync bookkeeping fields", async () => {
  await fs.mkdir(Global.Path.data, { recursive: true })
  await Bun.write(
    file,
    JSON.stringify({
      api_key: "thk_test.secret",
      user_id: "user-1",
      device_name: "test-device",
      cached_v: 7,
      last_check_ts: 1751700000000,
    }),
  )

  const session = await OpenScience.getSession()
  expect(session).not.toBeNull()
  expect(session!.cached_v).toBe(7)
  expect(session!.last_check_ts).toBe(1751700000000)
})

test("scheduled credential refresh is non-blocking and single-flight", async () => {
  await fs.mkdir(Global.Path.data, { recursive: true })
  await Bun.write(
    file,
    JSON.stringify({
      api_key: "thk_test.secret",
      user_id: "user-1",
      cached_v: 7,
      last_check_ts: 0,
    }),
  )
  const gate = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const state = { calls: 0 }
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (!String(input).endsWith("/api/cli/sync/version")) return new Response("not found", { status: 404 })
    state.calls++
    started.resolve()
    await gate.promise
    return Response.json({ v: 7 })
  }) as typeof fetch

  const first = OpenScience.scheduleRefresh()
  const second = OpenScience.scheduleRefresh()
  expect(first).toBe(second)
  await started.promise
  expect(state.calls).toBe(1)
  gate.resolve()
  await first
})

test("scheduled credential refresh does not revoke the active runtime", async () => {
  await fs.mkdir(Global.Path.data, { recursive: true })
  await Bun.write(
    file,
    JSON.stringify({
      api_key: "thk_test.secret",
      user_id: "user-1",
      cached_v: 7,
      last_check_ts: 0,
    }),
  )

  const state = { revocations: 0 }
  const unregister = CredentialLifecycle.onRevoke(() => {
    state.revocations++
  })
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).endsWith("/api/cli/sync/version")) return Response.json({ v: 8 })
    if (String(input).endsWith("/api/cli/sync")) {
      return Response.json({ user: {}, services: {} })
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch

  try {
    await OpenScience.refreshIfStale()
    for (const _ of Array.from({ length: 200 })) {
      if ((await OpenScience.getSession())?.cached_v === 8) break
      await Bun.sleep(10)
    }
    expect((await OpenScience.getSession())?.cached_v).toBe(8)
    expect(state.revocations).toBe(0)
  } finally {
    unregister()
  }
})

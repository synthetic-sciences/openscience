import { test, expect, afterEach } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Global } from "../src/global"
import { OpenScience } from "../src/openscience"

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

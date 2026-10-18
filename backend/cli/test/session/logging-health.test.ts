import type z from "zod"
import { afterEach, beforeEach, expect, test } from "bun:test"
import path from "node:path"
import { Global } from "../../src/global"
import { LoggingHealth } from "../../src/session/logging-health"
import { UsageLoggingRoutes } from "../../src/server/routes/settings/usage-logging"

const session = path.join(Global.Path.data, "openscience-session.json")
const store = path.join(Global.Path.data, "usage-logging.json")
const token = `thk_${crypto.randomUUID()}.local-only-test`
const installation = "00000000-0000-4000-8000-000000000099"
const organization = "00000000-0000-4000-8000-000000000012"
const previous = process.env.OPENSCIENCE_API_BASE
const report: z.infer<typeof LoggingHealth.Report> = {
  schema_version: 1,
  scope: "account_installation_workspace",
  since: "2026-10-18T00:00:00+00:00",
  until: "2026-10-18T01:00:00+00:00",
  checked_at: "2026-10-18T01:00:01+00:00",
  status: "healthy",
  receipts: { deliveries: 1, anomalous: 0, orphaned_events: 0 },
  usage: {
    responses: 1,
    projected: 1,
    missing_projection: 0,
    unknown_input: 0,
    unknown_output: 0,
    unknown_reasoning: 1,
    unknown_cache_read: 0,
    unknown_cache_write: 1,
  },
  managed: {
    responses: 0,
    pending: 0,
    settled: 0,
    not_charged: 0,
    missing_call_id: 0,
    missing_link: 0,
    ambiguous_link: 0,
    missing_hold: 0,
    hold_mismatch: 0,
    settled_missing_charge: 0,
    duplicate_charge: 0,
    token_mismatch: 0,
    charge_amount_mismatch: 0,
    unknown_charge_amount: 0,
  },
}

beforeEach(async () => {
  await Bun.write(store, JSON.stringify({ installation, enabled: true }))
  await Bun.write(session, JSON.stringify({ api_key: token, user_id: "health-user", organization_id: organization }))
})
afterEach(async () => {
  await Bun.file(session)
    .delete()
    .catch(() => undefined)
  await Bun.file(store)
    .delete()
    .catch(() => undefined)
  if (previous === undefined) delete process.env.OPENSCIENCE_API_BASE
  else process.env.OPENSCIENCE_API_BASE = previous
})

function receiver(reply: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: reply })
  process.env.OPENSCIENCE_API_BASE = server.url.toString()
  return { [Symbol.dispose]: () => server.stop(true) }
}

test("server health sends only the device ID with the current authenticated workspace and strips unknown fields", async () => {
  using remote = receiver((request) => {
    const url = new URL(request.url)
    expect(request.method).toBe("GET")
    expect(url.pathname).toBe("/api/v1/telemetry/health")
    expect([...url.searchParams]).toEqual([["installation_id", installation]])
    expect(request.headers.get("authorization")).toBe(`Bearer ${token}`)
    expect(request.headers.get("x-organization-id")).toBe(organization)
    return Response.json({ ...report, prompt: "private fixture content" })
  })
  const result = await LoggingHealth.check()
  expect(result).toEqual({ state: "available", report })
  expect(JSON.stringify(result)).not.toContain("private fixture content")
  const response = await UsageLoggingRoutes().request("/health")
  expect(response.status).toBe(200)
  expect(response.headers.get("cache-control")).toBe("no-store")
  expect(await response.json()).toEqual({ state: "available", report })
})

test("signed-out checks do not contact the server", async () => {
  await Bun.file(session).delete()
  using remote = receiver(() => {
    throw new Error("must not contact the server")
  })
  expect(await LoggingHealth.check()).toEqual({ state: "unavailable", reason: "signed_out" })
})

for (const [status, reason] of [
  [404, "unsupported"],
  [401, "unauthorized"],
  [403, "unauthorized"],
  [503, "server_unavailable"],
] as const) {
  test(`HTTP ${status} is explicitly unavailable, never healthy`, async () => {
    using remote = receiver(() => new Response("fixture", { status }))
    expect(await LoggingHealth.check()).toEqual({ state: "unavailable", reason })
  })
}

test("invalid schemas and unbounded windows are rejected", async () => {
  for (const body of [
    { status: "healthy" },
    { ...report, until: "2026-10-20T00:00:00+00:00" },
    { ...report, usage: { ...report.usage, projected: -1 } },
  ]) {
    using remote = receiver(() => Response.json(body))
    expect(await LoggingHealth.check()).toEqual({ state: "unavailable", reason: "invalid_report" })
  }
})

test("redirects are not followed with the account credential", async () => {
  using remote = receiver(() => new Response(null, { status: 302, headers: { location: "http://127.0.0.1:1/other" } }))
  expect(await LoggingHealth.check()).toEqual({ state: "unavailable", reason: "server_unavailable" })
})

test("a changed account discards the in-flight server report", async () => {
  using remote = receiver(async () => {
    await Bun.write(
      session,
      JSON.stringify({ api_key: token, user_id: "another-account", organization_id: organization }),
    )
    return Response.json(report)
  })
  expect(await LoggingHealth.check()).toEqual({ state: "unavailable", reason: "account_changed" })
})

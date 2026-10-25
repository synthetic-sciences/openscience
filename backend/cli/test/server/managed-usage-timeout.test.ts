import { expect, test } from "bun:test"
import { OpenScience } from "../../src/openscience"
import { UsageSettingsRoutes } from "../../src/server/routes/settings/usage"

test("managed Usage reports an expired account deadline as temporary unavailability", async () => {
  const previous = { base: process.env.OPENSCIENCE_API_BASE, deadline: process.env.OPENSCIENCE_ACCOUNT_DEADLINE_MS }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      await Bun.sleep(150)
      return Response.json({ daily_breakdown: [] })
    },
  })
  process.env.OPENSCIENCE_API_BASE = server.url.origin
  process.env.OPENSCIENCE_ACCOUNT_DEADLINE_MS = "40"
  try {
    await OpenScience.saveSession({
      api_key: "osk_fixture_" + crypto.randomUUID(),
      user_id: "usage-deadline",
      organization_id: "org_usage_deadline",
      workspace_locked: true,
    })
    const response = await UsageSettingsRoutes().request("/managed?start=2026-10-25&end=2026-10-25")
    expect(response.status).toBe(503)
    expect(await response.text()).toContain("account service did not answer")
    expect(response.headers.get("cache-control")).toBe("no-store")
  } finally {
    server.stop(true)
    await OpenScience.clearSession()
    if (previous.base === undefined) delete process.env.OPENSCIENCE_API_BASE
    else process.env.OPENSCIENCE_API_BASE = previous.base
    if (previous.deadline === undefined) delete process.env.OPENSCIENCE_ACCOUNT_DEADLINE_MS
    else process.env.OPENSCIENCE_ACCOUNT_DEADLINE_MS = previous.deadline
  }
})

test("legacy managed Usage preserves the account deadline while it resolves its workspace", async () => {
  const previous = { base: process.env.OPENSCIENCE_API_BASE, deadline: process.env.OPENSCIENCE_ACCOUNT_DEADLINE_MS }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch() {
      await Bun.sleep(150)
      return Response.json({})
    },
  })
  process.env.OPENSCIENCE_API_BASE = server.url.origin
  process.env.OPENSCIENCE_ACCOUNT_DEADLINE_MS = "40"
  try {
    await OpenScience.saveSession({
      api_key: "thk_fixture_" + crypto.randomUUID(),
      user_id: "legacy-usage-deadline",
      workspace_locked: false,
    })
    const response = await UsageSettingsRoutes().request("/managed?start=2026-10-25&end=2026-10-25")
    expect(response.status).toBe(503)
    expect(await response.text()).toContain("account service did not answer")
  } finally {
    server.stop(true)
    await OpenScience.clearSession()
    if (previous.base === undefined) delete process.env.OPENSCIENCE_API_BASE
    else process.env.OPENSCIENCE_API_BASE = previous.base
    if (previous.deadline === undefined) delete process.env.OPENSCIENCE_ACCOUNT_DEADLINE_MS
    else process.env.OPENSCIENCE_ACCOUNT_DEADLINE_MS = previous.deadline
  }
})

test("managed Usage sends a pinned workspace read directly to the authoritative usage endpoint", async () => {
  const previous = process.env.OPENSCIENCE_API_BASE
  const organization = "org_usage_pinned"
  const paths: string[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const path = new URL(request.url).pathname
      paths.push(path)
      if (path !== "/api/credits/usage") return new Response(null, { status: 503 })
      expect(request.headers.get("X-Organization-ID")).toBe(organization)
      return Response.json(
        {
          daily_breakdown: [
            {
              date: "2026-10-25",
              provider: "openrouter",
              model: "qwen/qwen3.8-flash",
              route: "managed",
              calls: 5,
              input_tokens: 6968,
              output_tokens: 71,
              cost_cents: 0.0706,
            },
          ],
        },
        {
          headers: {
            "OpenScience-Funding-Protocol": "1",
            "OpenScience-Funding-Context": "organization:" + organization,
          },
        },
      )
    },
  })
  process.env.OPENSCIENCE_API_BASE = server.url.origin
  try {
    await OpenScience.saveSession({
      api_key: "osk_fixture_" + crypto.randomUUID(),
      user_id: "usage-pinned",
      organization_id: organization,
      workspace_locked: true,
    })
    const response = await UsageSettingsRoutes().request("/managed?start=2026-10-25&end=2026-10-25")
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.connected).toBe(true)
    expect(body.rows).toHaveLength(1)
    expect(body.rows[0].costs).toEqual([{ source: "wallet_receipt", amountUSD: "0.000706", known: 1, unknown: 0 }])
    expect(paths).toEqual(["/api/credits/usage"])
  } finally {
    server.stop(true)
    await OpenScience.clearSession()
    if (previous === undefined) delete process.env.OPENSCIENCE_API_BASE
    else process.env.OPENSCIENCE_API_BASE = previous
  }
})

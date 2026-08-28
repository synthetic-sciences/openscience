import { test, expect, afterEach, spyOn } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Global } from "../src/global"
import { OpenScience } from "../src/openscience"

const queue = path.join(Global.Path.data, "usage-queue.jsonl")
const session = path.join(Global.Path.data, "openscience-session.json")
const capabilities = path.join(Global.Path.data, "usage-capabilities.json")

afterEach(async () => {
  await fs.rm(queue, { force: true }).catch(() => {})
  await fs.rm(session, { force: true }).catch(() => {})
  await fs.rm(capabilities, { force: true }).catch(() => {})
  OpenScience.invalidateResearchEntitlements()
})

test("migrates the legacy Personal cutover and drops its queued billing retry", async () => {
  await fs.mkdir(Global.Path.data, { recursive: true })
  await Bun.write(session, JSON.stringify({ api_key: "thk_test.secret", user_id: "legacy-user" }))
  const line =
    JSON.stringify({
      service: "llm",
      event_type: "chat",
      tokens_used: 3,
      __account: "legacy-user",
    }) + "\n"
  await fs.writeFile(queue, line)
  await Bun.write(
    capabilities,
    JSON.stringify({
      schema_version: 1,
      accounts: { "legacy-user": { nonfinancial: true, observed_at: "2026-01-01T00:00:00Z" } },
    }),
  )
  const fetcher = spyOn(globalThis, "fetch").mockImplementation((async () => {
    throw new Error("legacy cutover must prevent replay")
  }) as unknown as typeof fetch)

  try {
    await OpenScience.flushPendingUsage()
    expect(await Bun.file(queue).exists()).toBe(false)
    const saved = await Bun.file(capabilities).json()
    expect(saved.accounts["legacy-user\u0000personal"]).toMatchObject({ nonfinancial: true })
    expect(saved.accounts["legacy-user"]).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
  } finally {
    fetcher.mockRestore()
  }
})

test("keeps the established key-only Personal tag upgrade-compatible", async () => {
  await fs.mkdir(Global.Path.data, { recursive: true })
  await Bun.write(session, JSON.stringify({ api_key: "thk_keyonly.secret" }))
  const account = "k:d8d0d15d1a2b2ccc"
  const line =
    JSON.stringify({
      service: "llm",
      event_type: "chat",
      tokens_used: 3,
      __account: account,
    }) + "\n"
  await fs.writeFile(queue, line)
  await Bun.write(
    capabilities,
    JSON.stringify({
      schema_version: 1,
      accounts: { [account]: { nonfinancial: true, observed_at: "2026-01-01T00:00:00Z" } },
    }),
  )
  const fetcher = spyOn(globalThis, "fetch").mockImplementation((async () => {
    throw new Error("legacy key-only cutover must prevent replay")
  }) as unknown as typeof fetch)

  try {
    await OpenScience.flushPendingUsage()
    expect(await Bun.file(queue).exists()).toBe(false)
    const saved = await Bun.file(capabilities).json()
    expect(saved.accounts[`${account}\u0000personal`]).toMatchObject({ nonfinancial: true })
    expect(saved.accounts[account]).toBeUndefined()
    expect(fetcher).not.toHaveBeenCalled()
  } finally {
    fetcher.mockRestore()
  }
})

test("keeps legacy tagged and accountless rows away from an organization Wallet", async () => {
  await fs.mkdir(Global.Path.data, { recursive: true })
  await Bun.write(
    session,
    JSON.stringify({ api_key: "thk_test.secret", user_id: "legacy-user", organization_id: "org_team" }),
  )
  const lines = [
    JSON.stringify({ service: "llm", event_type: "chat", tokens_used: 1, __account: "legacy-user" }),
    JSON.stringify({ service: "llm", event_type: "chat", tokens_used: 2 }),
  ]
  await fs.writeFile(queue, lines.join("\n") + "\n")
  const fetcher = spyOn(globalThis, "fetch").mockImplementation((async () => {
    throw new Error("legacy usage must not reach organization funding")
  }) as unknown as typeof fetch)

  try {
    await OpenScience.flushPendingUsage()
    expect(await fs.readFile(queue, "utf-8")).toBe(lines.join("\n") + "\n")
    expect(fetcher).not.toHaveBeenCalled()
  } finally {
    fetcher.mockRestore()
  }
})

test("flushPendingUsage without a session leaves the queue intact", async () => {
  await fs.mkdir(Global.Path.data, { recursive: true })
  await fs.rm(session, { force: true }).catch(() => {})
  const line = JSON.stringify({ service: "test", event_type: "tokens", tokens_used: 1 }) + "\n"
  await fs.writeFile(queue, line)

  await OpenScience.flushPendingUsage()
  expect(await fs.readFile(queue, "utf-8")).toBe(line)
})

test("flushPendingUsage drops malformed lines and removes the empty queue", async () => {
  await fs.mkdir(Global.Path.data, { recursive: true })
  await Bun.write(session, JSON.stringify({ api_key: "thk_test.secret", user_id: "user-1" }))
  await fs.writeFile(queue, "not-json\nalso not json\n")

  await OpenScience.flushPendingUsage()
  expect(await Bun.file(queue).exists()).toBe(false)
})

test("usage stays financially blocking until the server acknowledges the proxy-settlement cutover", async () => {
  await fs.mkdir(Global.Path.data, { recursive: true })
  await Bun.write(session, JSON.stringify({ api_key: "thk_test.secret", user_id: "usage-user" }))
  const replies = [
    Response.json({ recorded: false, model_blocked: true, remaining_balance_cents: 0 }),
    Response.json({
      accepted: true,
      financial: false,
      billing_authority: "gateway_proxy",
      model_blocked: true,
      estimated_cost_usd: 0,
      remaining_balance_cents: 0,
    }),
    Response.json({ error: "insufficient_balance" }, { status: 402 }),
  ]
  const calls: string[] = []
  const fetcher = spyOn(globalThis, "fetch").mockImplementation((async (input) => {
    calls.push(String(input))
    const response = replies.shift()
    if (!response) throw new Error("Unexpected usage request")
    return response
  }) as typeof fetch)
  const usage = { service: "llm", event_type: "tokens", model: "fixture", tokens_used: 5 }

  try {
    expect(await OpenScience.reportUsage(usage)).toEqual({ recorded: false, modelBlocked: true })
    expect(await OpenScience.reportUsage(usage)).toMatchObject({
      accepted: true,
      financial: false,
      billing_authority: "gateway_proxy",
      modelBlocked: false,
    })
    expect(await Bun.file(capabilities).json()).toMatchObject({
      schema_version: 1,
      accounts: { ["usage-user\u0000personal"]: { nonfinancial: true } },
    })
    expect(await OpenScience.reportUsage(usage)).toBeNull()
    expect(await Bun.file(queue).exists()).toBe(false)
    expect(calls).toHaveLength(3)
    expect(calls.every((url) => url.endsWith("/api/cli/usage"))).toBe(true)
  } finally {
    fetcher.mockRestore()
  }
})

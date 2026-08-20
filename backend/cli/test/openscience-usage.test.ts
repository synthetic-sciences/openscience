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
      accounts: { "usage-user": { nonfinancial: true } },
    })
    expect(await OpenScience.reportUsage(usage)).toBeNull()
    expect(await Bun.file(queue).exists()).toBe(false)
    expect(calls).toHaveLength(3)
    expect(calls.every((url) => url.endsWith("/api/cli/usage"))).toBe(true)
  } finally {
    fetcher.mockRestore()
  }
})

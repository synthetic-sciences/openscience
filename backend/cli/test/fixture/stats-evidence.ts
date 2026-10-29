import { afterEach, beforeAll, expect, spyOn, test } from "bun:test"
import { aggregateSessionStats, displayStats } from "../../src/cli/cmd/stats"
import { Storage } from "../../src/storage/storage"
import { SessionTraceStore } from "../../src/session/trace-store"
import { BillingImport } from "../../src/session/billing-import"
import { localUsage } from "../../src/session/usage"
import { usageCostTotals } from "@synsci/util/usage"

const keys: string[][] = []
const batches: string[] = []
beforeAll(async () => {
  expect(await Storage.list(["session"])).toEqual([])
})

const write = async (key: string[], value: unknown) => {
  keys.push(key)
  await Storage.write(key, value)
}
afterEach(async () => {
  for (const id of batches.splice(0)) await BillingImport.remove(id)
  for (const key of keys.splice(0).reverse()) await Storage.remove(key)
})
async function fixture() {
  const suffix = crypto.randomUUID()
  const provider = `stats-${suffix}`
  const project = `prj_${suffix}`
  const other = `prj_other_${suffix}`
  const session = `ses_${suffix}`
  const second = `ses_other_${suffix}`
  const now = Date.now() - 60_000
  const before = now - 5 * 86400000
  for (const [id, parent] of [
    [session, project],
    [second, other],
  ]) {
    await write(["project", parent!], { id: parent })
    await write(["session", parent!, id!], { id, projectID: parent, time: { created: before - 1000, updated: now } })
  }
  const message = `msg_${suffix}`
  const old = `msg_old_${suffix}`
  const tokens = { input: 12, output: 2, reasoning: 1, cache: { read: 0, write: 0 } }
  for (const [id, time, cost] of [
    [message, now, 0.25],
    [old, before, 9.99],
  ] as const)
    await write(["message", session, id], {
      id,
      sessionID: session,
      role: "assistant",
      providerID: provider,
      modelID: "model",
      time: { created: time },
      cost,
      tokens,
    })
  const completed = crypto.randomUUID()
  await write(["part", message, `prt_${suffix}`], {
    id: `prt_${suffix}`,
    type: "step-finish",
    sessionID: session,
    messageID: message,
    reason: "stop",
    cost: 0.25,
    tokens,
    usage: {
      provider,
      model: "model",
      route: "byok",
      time: now,
      call: completed,
      cost: { source: "catalog_estimate", amountUSD: 0.25 },
      reportedCostUSD: 0.125,
    },
  })
  const calls = [
    {
      id: completed,
      sessionID: session,
      providerRequest: `req_${suffix}`,
      reportedCostUSD: 0.125,
      outcome: "completed" as const,
    },
    { id: crypto.randomUUID(), sessionID: session, reportedCostUSD: null, outcome: "failed" as const },
    { id: crypto.randomUUID(), sessionID: second, reportedCostUSD: 9, outcome: "completed" as const },
    {
      id: crypto.randomUUID(),
      sessionID: `agent-config:${suffix}`,
      reportedCostUSD: 0.5,
      outcome: "completed" as const,
    },
  ]
  for (const call of calls) {
    keys.push(["model_call", call.sessionID, call.id])
    await SessionTraceStore.recordModelCall({
      ...call,
      messageID: message,
      provider,
      model: "model",
      route: "byok",
      occurredAt: now,
    })
  }
  const imported = await BillingImport.add({
    schema_version: 1,
    provider,
    account_label: "Stats fixture",
    currency: "USD",
    records: [
      {
        billing_id: "matched",
        provider_request_id: `req_${suffix}`,
        occurred_at: new Date(now).toISOString(),
        model: "model",
        amount_usd: "0.000000000000000001",
      },
      {
        billing_id: "unmatched-credit",
        kind: "credit",
        occurred_at: new Date(now).toISOString(),
        amount_usd: "0.00002",
      },
    ],
  })
  batches.push(imported.id)
  return { project, other, provider, session, now }
}

test("stats separates exact cost sources from compatibility accounting and marks missing amounts", async () => {
  const item = await fixture()
  const stats = await aggregateSessionStats(1, item.project)
  expect(stats.totalMessages).toBe(2)
  expect(stats.totalCost).toBeCloseTo(10.24)
  expect(stats.evidence.reduce((sum, row) => sum + row.calls, 0)).toBe(2)
  expect(usageCostTotals(stats.evidence)).toEqual(
    expect.arrayContaining([
      { source: "catalog_estimate", amountUSD: "0.25", known: 1, unknown: 0 },
      { source: "provider_response", amountUSD: "0.125", known: 1, unknown: 1 },
      { source: "imported_billing", amountUSD: "0.000000000000000001", known: 1, unknown: 0 },
    ]),
  )
  const lines: string[] = []
  const output = spyOn(console, "log").mockImplementation((...values: unknown[]) => lines.push(values.join(" ")))
  try {
    displayStats(stats)
  } finally {
    output.mockRestore()
  }
  const text = lines.join("\n")
  expect(text).toContain("Provider reported: $0.125 (partial)")
  expect(text).toContain("Unreported amounts: 1")
  expect(text).toContain("Catalog estimate: $0.25")
  expect(text).toContain("Imported billing: $0.000000000000000001")
  expect(text).toContain("Accounting amount")
  expect(text).not.toContain("Total Cost")
})

test("project evidence excludes other projects, unattributed internal calls and unmatched bills", async () => {
  const item = await fixture()
  const scoped = await localUsage(item.now - 1000, item.now + 1000, item.project)
  expect(scoped.every((row) => row.provider === item.provider)).toBe(true)
  expect(usageCostTotals(scoped).some((cost) => cost.source === "imported_credit")).toBe(false)
  const all = (await localUsage(item.now - 1000, item.now + 1000)).filter((row) => row.provider === item.provider)
  expect(all.reduce((sum, row) => sum + row.calls, 0)).toBe(4)
  expect(usageCostTotals(all)).toEqual(
    expect.arrayContaining([
      { source: "provider_response", amountUSD: "9.625", known: 3, unknown: 1 },
      { source: "imported_credit", amountUSD: "0.00002", known: 1, unknown: 0 },
    ]),
  )
  expect(await localUsage(item.now - 1000, item.now + 1000, `prj_missing_${crypto.randomUUID()}`)).toEqual([])
})

test("stats retains internal-only models and unknown costs even with no sessions", async () => {
  const provider = `stats-internal-${crypto.randomUUID()}`
  const session = `agent-config:${crypto.randomUUID()}`
  const call = crypto.randomUUID()
  keys.push(["model_call", session, call])
  await SessionTraceStore.recordModelCall({
    id: call,
    sessionID: session,
    messageID: "msg_internal",
    provider,
    model: "internal",
    route: "byok",
    occurredAt: Date.now() - 1000,
    outcome: "failed",
  })
  const stats = await aggregateSessionStats(1)
  expect(stats.totalSessions).toBe(0)
  expect(stats.modelUsage[`${provider}/internal`].messages).toBe(0)
  expect(usageCostTotals(stats.evidence.filter((row) => row.provider === provider))).toEqual([
    { source: "provider_response", amountUSD: null, known: 0, unknown: 1 },
  ])
})

test("an empty scoped summary prints Unknown cost evidence rather than a free-call claim", async () => {
  const stats = await aggregateSessionStats(1, `prj_missing_${crypto.randomUUID()}`)
  const lines: string[] = []
  const output = spyOn(console, "log").mockImplementation((...values: unknown[]) => lines.push(values.join(" ")))
  try {
    displayStats(stats)
  } finally {
    output.mockRestore()
  }
  expect(lines.join("\n")).toContain("Unknown: no cost evidence recorded.")
  expect(lines.join("\n")).not.toContain("Provider reported: $0")
})

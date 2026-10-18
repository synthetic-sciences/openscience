import { afterEach, expect, test } from "bun:test"
import { BillingImport } from "../../src/session/billing-import"
import { localUsage } from "../../src/session/usage"
import { Storage } from "../../src/storage/storage"
import { SessionTraceStore } from "../../src/session/trace-store"
import { UsageSettingsRoutes } from "../../src/server/routes/settings/usage"

const start = Date.parse("2026-10-18T00:00:00Z")
const sessions: string[] = []
afterEach(async () => {
  for (const session of sessions.splice(0)) await SessionTraceStore.remove(session)
  await (
    await Storage.research()
  ).transaction((db) => db.exec("DELETE FROM billing_import; DELETE FROM billing_record"))
})
function document() {
  return {
    schema_version: 1 as const,
    provider: "billing-fixture-provider",
    account_label: "Local fixture account",
    currency: "USD" as const,
    records: [
      {
        billing_id: "invoice-line-1",
        provider_request_id: "req_fixture",
        occurred_at: "2026-10-18T01:00:00Z",
        model: "billing-fixture-model",
        amount_usd: "0.000000000000000001",
      },
    ],
  }
}
async function call() {
  const sessionID = `ses_import_${crypto.randomUUID()}`
  sessions.push(sessionID)
  await SessionTraceStore.recordModelCall({
    id: crypto.randomUUID(),
    sessionID,
    messageID: "msg_fixture",
    provider: "billing-fixture-provider",
    model: "billing-fixture-model",
    route: "byok",
    occurredAt: start,
    providerRequest: "req_fixture",
  })
  return sessionID
}
test("billing imports preserve exact amounts, remain local and match only a unique provider call", async () => {
  const batch = await BillingImport.add(document())
  let records = await BillingImport.records(start, start + 86400000)
  expect(records).toMatchObject([{ amountUSD: "0.000000000000000001", match: "unmatched" }])
  const sessionID = await call()
  records = await BillingImport.records(start, start + 86400000)
  expect(records).toMatchObject([{ match: "matched", sessionID }])
  expect(await BillingImport.list()).toEqual([batch])
  expect(await BillingImport.records(start + 86400000, start + 2 * 86400000)).toEqual([])
})
test("reordered and repeated imports are idempotent and overlapping batches do not duplicate billing records", async () => {
  const first = document()
  const batch = await BillingImport.add(first)
  const another = {
    ...first,
    records: [...first.records, { ...first.records[0]!, billing_id: "line-2", amount_usd: "0.10" }],
  }
  const second = await BillingImport.add(another)
  expect(await BillingImport.add({ ...another, records: another.records.toReversed() })).toEqual(second)
  expect(await BillingImport.records(start, start + 86400000)).toHaveLength(2)
  await BillingImport.remove(batch.id)
  expect(await BillingImport.records(start, start + 86400000)).toHaveLength(2)
  await BillingImport.remove(second.id)
  expect(await BillingImport.records(start, start + 86400000)).toEqual([])
})
test("conflicting evidence fails atomically instead of silently changing a charge", async () => {
  await BillingImport.add(document())
  const conflict = document()
  conflict.records = [
    { ...conflict.records[0]!, billing_id: "new" },
    { ...conflict.records[0]!, amount_usd: "9" },
  ]
  await expect(BillingImport.add(conflict)).rejects.toBeInstanceOf(BillingImport.Conflict)
  expect(await BillingImport.records(start, start + 86400000)).toHaveLength(1)
  expect(await BillingImport.list()).toHaveLength(1)
})
test("ambiguous local calls and provider account collisions are never guessed", async () => {
  await BillingImport.add(document())
  await call()
  await call()
  expect(await BillingImport.records(start, start + 86400000)).toMatchObject([{ match: "ambiguous" }])
  await BillingImport.add({ ...document(), account_label: "Different provider account" })
  expect(
    (await BillingImport.records(start, start + 86400000)).every(
      (record) => record.match === "ambiguous" && !record.callID,
    ),
  ).toBe(true)
})
test("invalid currencies, duplicate row IDs and unrecognized file fields are rejected", async () => {
  expect(BillingImport.Document.safeParse({ ...document(), currency: "EUR" }).success).toBe(false)
  expect(BillingImport.Document.safeParse({ ...document(), api_key: "private" }).success).toBe(false)
  expect(
    BillingImport.Document.safeParse({ ...document(), records: [{ ...document().records[0], amount_usd: "-1" }] })
      .success,
  ).toBe(false)
  await expect(
    BillingImport.add({ ...document(), records: [document().records[0]!, document().records[0]!] }),
  ).rejects.toBeInstanceOf(BillingImport.Conflict)
  expect(await BillingImport.list()).toEqual([])
})
test("the local import API validates input, retains conflicts and exports reconciliation without uploads", async () => {
  const routes = UsageSettingsRoutes()
  const input = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(document()) }
  const imported = await routes.request("/imports", input)
  expect(imported.status).toBe(200)
  expect(imported.headers.get("cache-control")).toBe("no-store")
  const oversized = await routes.request("/imports", {
    ...input,
    body: JSON.stringify({ extra: "x".repeat(2 * 1024 * 1024) }),
  })
  expect(oversized.status).toBe(413)
  const batch = (await imported.json()) as { id: string }
  const conflict = await routes.request("/imports", {
    ...input,
    body: JSON.stringify({ ...document(), records: [{ ...document().records[0], amount_usd: "3" }] }),
  })
  expect(conflict.status).toBe(409)
  const records = await routes.request("/billing?start=2026-10-18&end=2026-10-18")
  expect(await records.json()).toMatchObject([{ match: "unmatched", amountUSD: "0.000000000000000001" }])
  expect((await routes.request(`/imports/${batch.id}`, { method: "DELETE" })).status).toBe(200)
  expect(await BillingImport.list()).toEqual([])
})

test("aggregate usage separates billing, credits, provider reports, estimates and unknown internal attempts", async () => {
  const { localUsage } = await import("../../src/session/usage")
  const { usageCostTotals, usageModels, usageCsv } = await import("@synsci/util/usage")
  const sessionID = await call()
  const saved = (await SessionTraceStore.read(sessionID)).modelCalls[0]!
  const keys = [
    ["session", "billing-test", sessionID],
    ["message", sessionID, "message-billing"],
    ["part", "message-billing", "step-billing"],
  ]
  await Storage.write(keys[0]!, { id: sessionID, time: { created: start, updated: start + 1 } })
  await Storage.write(keys[1]!, {
    id: "message-billing",
    role: "assistant",
    providerID: "billing-fixture-provider",
    modelID: "billing-fixture-model",
    time: { created: start },
    cost: 0.01,
    tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
  })
  await Storage.write(keys[2]!, {
    type: "step-finish",
    cost: 0.01,
    tokens: { input: 1, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    usage: {
      route: "byok",
      provider: "billing-fixture-provider",
      model: "billing-fixture-model",
      call: saved.id,
      time: start,
      cost: { source: "catalog_estimate", amountUSD: 0.01 },
      reportedCostUSD: 0.02,
    },
  })
  try {
    await SessionTraceStore.recordModelCall({
      ...saved,
      id: "internal",
      messageID: "title",
      providerRequest: "req_internal",
      reportedCostUSD: 0.007,
    })
    await SessionTraceStore.recordModelCall({
      ...saved,
      id: "failed",
      messageID: "failed",
      providerRequest: "req_failed",
      reportedCostUSD: null,
      outcome: "failed",
    })
    await SessionTraceStore.recordModelCall({
      ...saved,
      id: "other-provider",
      provider: "other-fixture-provider",
      providerRequest: "req_other",
      reportedCostUSD: 1,
    })
    const input = document()
    await BillingImport.add({
      ...input,
      records: [
        ...input.records,
        {
          ...input.records[0]!,
          billing_id: "credit",
          kind: "credit",
          provider_request_id: undefined,
          amount_usd: "0.001",
        },
      ],
    })
    expect(
      (await BillingImport.records(start, start + 86400000)).find((record) => record.kind === "charge")?.match,
    ).toBe("matched")
    const all = await localUsage(start, start + 86400000)
    expect(all.some((row) => row.provider === "other-fixture-provider")).toBe(true)
    const rows = all.filter(
      (row) => row.provider === "billing-fixture-provider" && row.model === "billing-fixture-model",
    )
    expect(rows.reduce((sum, row) => sum + row.calls, 0)).toBe(3)
    const totals = usageCostTotals(rows)
    expect(totals).toEqual(
      expect.arrayContaining([
        { source: "catalog_estimate", amountUSD: "0.01", known: 1, unknown: 0 },
        { source: "provider_response", amountUSD: "0.027", known: 2, unknown: 1 },
        { source: "imported_billing", amountUSD: "0.000000000000000001", known: 1, unknown: 0 },
        { source: "imported_credit", amountUSD: "0.001", known: 1, unknown: 0 },
      ]),
    )
    expect(usageCostTotals(usageModels(rows))).toEqual(totals)
    const csv = usageCsv(rows)
    expect(csv).toContain('"Imported billing (USD)"')
    expect(csv).toContain('"0.000000000000000001"')
    expect(csv).toContain('"Imported billing credits (USD)"')
  } finally {
    for (const key of keys.toReversed()) await Storage.remove(key)
  }
})

test("custom provider identifiers remain exact instead of being forced into built-in slugs", async () => {
  const sessionID = await call()
  const stored = (await SessionTraceStore.read(sessionID)).modelCalls[0]!
  await SessionTraceStore.recordModelCall({ ...stored, provider: "team/custom:gateway" })
  await BillingImport.add({ ...document(), provider: "team/custom:gateway" })
  expect(await BillingImport.records(start, start + 86400000)).toMatchObject([
    { provider: "team/custom:gateway", match: "matched", sessionID },
  ])
})

test("explicit requested aliases preserve billed model names without guessing a mapping", async () => {
  const sessionID = await call()
  const base = document()
  const records = base.records.map((record) => ({ ...record, model: "billing-fixture-model-20261018" }))
  const original = await BillingImport.add({ ...base, records })
  expect(await BillingImport.records(start, start + 86400000)).toMatchObject([
    { model: "billing-fixture-model-20261018", match: "unmatched" },
  ])
  await BillingImport.remove(original.id)
  const annotated = await BillingImport.add({
    ...base,
    records: records.map((record) => ({ ...record, requested_model: "billing-fixture-model" })),
  })
  expect(await BillingImport.records(start, start + 86400000)).toMatchObject([
    { model: "billing-fixture-model-20261018", requestedModel: "billing-fixture-model", match: "matched", sessionID },
  ])
  const rows = (await localUsage(start, start + 86400000)).filter((row) => row.provider === base.provider)
  expect(rows.map((row) => row.model)).toEqual(["billing-fixture-model"])
  expect(rows[0]?.costs).toEqual(
    expect.arrayContaining([{ source: "imported_billing", amountUSD: "0.000000000000000001", known: 1, unknown: 0 }]),
  )
  await BillingImport.remove(annotated.id)
  await BillingImport.add({
    ...base,
    records: records.map((record) => ({ ...record, requested_model: "different-request-model" })),
  })
  const unmatched = await BillingImport.records(start, start + 86400000)
  expect(unmatched).toMatchObject([{ match: "unmatched" }])
  expect(unmatched[0]?.callID).toBeUndefined()
})

test("alias annotations cannot disambiguate reused request IDs", async () => {
  await call()
  await call()
  const base = document()
  await BillingImport.add({
    ...base,
    records: base.records.map((record) => ({
      ...record,
      model: "canonical-billed-model",
      requested_model: "billing-fixture-model",
    })),
  })
  expect(await BillingImport.records(start, start + 86400000)).toMatchObject([{ match: "ambiguous" }])
})

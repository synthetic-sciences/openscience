import { afterEach, expect, test } from "bun:test"
import { Storage } from "../../src/storage/storage"
import { UsageSettingsRoutes } from "../../src/server/routes/settings/usage"
import { usageCsv, usageDate, usageModels, usageRange, usageTotals, type UsageRow } from "@synsci/util/usage"

const keys: string[][] = []
const write = async (key: string[], value: unknown) => {
  keys.push(key)
  await Storage.write(key, value)
}
afterEach(async () => {
  for (const key of keys.splice(0).reverse()) await Storage.remove(key)
})
const start = Date.parse("2026-09-01T00:00:00Z")
const tokens = { input: 100, output: 20, reasoning: 10, cache: { read: 50, write: 5 } }

test("usage records each completed step once, uses its actual route, and excludes inherited fork history", async () => {
  for (const id of ["original", "fork"]) {
    await write(["session", "usage-test", id], {
      id,
      time: { created: id === "fork" ? start + 1000 : start, updated: start + 2000 },
    })
    await write(["message", id, id], {
      id,
      sessionID: id,
      role: "assistant",
      providerID: "openrouter",
      modelID: "model",
      time: { created: start + 1 },
      cost: 9,
      tokens,
    })
    for (const [index, route] of ["byok", "byok", "managed"].entries()) {
      await write(["part", id, String(index)], {
        type: "step-finish",
        cost: 0.02,
        tokens,
        usage: { route, provider: "openrouter", model: "model", time: start + 10 },
      })
    }
  }
  const response = await UsageSettingsRoutes().request("/local?start=2026-09-01&end=2026-09-01")
  expect(response.status).toBe(200)
  const result = (await response.json()) as { rows: UsageRow[] }
  const row = result.rows.find((row) => row.model === "model")!
  expect(row).toMatchObject({ route: "byok", calls: 2, tokens: 350, output: 40, reasoning: 20, cost: 0.04 })
})

test("local usage honors day boundaries and keeps ambiguous historical routes separate", async () => {
  await write(["session", "usage-test", "dates"], {
    id: "dates",
    time: { created: start - 10000, updated: start + 86400001 },
  })
  for (const [id, time, providerID] of [
    ["before", start - 1, "openai"],
    ["inside", start, "ollama"],
    ["legacy", start + 10, "openrouter"],
    ["after", start + 86400000, "openai"],
  ] as const) {
    await write(["message", "dates", id], {
      id,
      sessionID: "dates",
      role: "assistant",
      providerID,
      modelID: id,
      time: { created: time },
      cost: 1,
      tokens,
    })
  }
  const response = await UsageSettingsRoutes().request("/local?start=2026-09-01&end=2026-09-01")
  const result = (await response.json()) as { rows: UsageRow[] }
  expect(result.rows.map((row) => row.model).sort()).toEqual(["inside", "legacy"])
  expect(result.rows.find((row) => row.model === "inside")).toMatchObject({ route: "local", cost: 0, tokens: 175 })
  expect(result.rows.find((row) => row.model === "legacy")?.route).toBe("unknown")
})

test("invalid, reversed, or unbounded dates are rejected", async () => {
  for (const query of ["start=2026-02-30", "start=2026-09-25&end=2026-09-01", "start=2020-01-01&end=2026-09-25"]) {
    expect((await UsageSettingsRoutes().request(`/local?${query}`)).status).toBe(400)
  }
  expect(usageDate("2026-02-30")).toBe(false)
  expect(usageRange(7, new Date("2026-09-01T23:00:00Z"))).toEqual({ start: "2026-08-26", end: "2026-09-01" })
})

test("CSV exports exact daily values and escapes configured model names", () => {
  const row: UsageRow = {
    date: "2026-09-01",
    provider: "=provider",
    model: 'model,"quoted"\nline',
    route: "byok",
    calls: 2,
    tokens: 175,
    input: 100,
    output: 20,
    reasoning: 10,
    cacheRead: 50,
    cacheWrite: 5,
    cost: 0.00012345,
  }
  const csv = usageCsv([row, { ...row, date: "2026-09-02", route: "managed" }])
  expect(csv).toContain('"\'=provider"')
  expect(csv).toContain('"model,""quoted""\nline"')
  expect(csv).toContain('"0.00012345","Estimate"')
  expect(csv).toContain('"0.00012345","Wallet charge"')
  expect(usageTotals([row, row])).toEqual({ calls: 4, tokens: 350, cacheRead: 100, cost: 0.0002469 })
  expect(usageModels([row, row])[0].calls).toBe(4)
})

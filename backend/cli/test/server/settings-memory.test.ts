import { afterEach, beforeEach, expect, test } from "bun:test"
import { MemorySettingsRoutes } from "../../src/server/routes/settings/memory"
import { Memory } from "../../src/settings/memory"

const app = MemorySettingsRoutes()

beforeEach(async () => {
  await Memory.set("global", { enabled: true, categories: [] })
})

afterEach(async () => {
  await Memory.set("global", { enabled: false, categories: [] })
})

test("GET / returns the doc with a backend-computed capacity gauge", async () => {
  await Memory.append("global", { text: "Ibis migration data is in ibis.parquet" })
  const res = await app.request("/?scope=global")
  expect(res.status).toBe(200)
  const body = (await res.json()) as Memory.Doc & { capacity: Memory.Capacity }
  expect(body.enabled).toBe(true)
  expect(body.capacity.max).toBe(Memory.BUDGET)
  expect(body.capacity.used).toBe("Ibis migration data is in ibis.parquet".length)
  expect(body.capacity.gauge).toMatch(/^\[\d+% — \d+\/\d+ chars\]$/)
})

test("PUT / stays backward compatible and never persists the capacity field", async () => {
  const doc = {
    enabled: true,
    categories: [{ id: "c", name: "Notes", notes: [{ id: "1", text: "tapir note", createdAt: 1 }] }],
    capacity: { used: 999999, max: 1, gauge: "[bogus]" },
  }
  const res = await app.request("/?scope=global", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(doc),
  })
  expect(res.status).toBe(200)
  const body = (await res.json()) as Memory.Doc & { capacity: Memory.Capacity }
  expect(body.capacity.used).toBe("tapir note".length)
  expect((await Memory.get("global")) as unknown as { capacity?: unknown }).not.toHaveProperty("capacity")
})

test("GET /search returns full-text hits over saved notes", async () => {
  await Memory.append("global", { text: "Okapi telemetry lands in the metrics bucket", category: "Infra" })
  const res = await app.request("/search?q=okapi+telemetry")
  expect(res.status).toBe(200)
  const body = (await res.json()) as { results: { kind: string; text: string; category?: string }[] }
  const hit = body.results.find((r) => r.kind === "note" && r.text.includes("Okapi"))
  expect(hit).toBeDefined()
  expect(hit?.category).toBe("Infra")
})

test("GET /search without a query is a 400", async () => {
  const res = await app.request("/search")
  expect(res.status).toBe(400)
})

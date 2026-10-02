import { afterEach, expect, test } from "bun:test"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { ProviderConnectionRoutes } from "../../src/server/routes/provider-connection"

const id = "connection-fixture"
const app = ProviderConnectionRoutes(() => {})
const put = (body: unknown) =>
  app.request(`/${id}/connection`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
afterEach(async () => {
  await Auth.remove(id)
  await Config.removeProvider(id)
})

test("saves endpoint and key, preserves unrelated provider options, and clears an override", async () => {
  await Config.setProvider(id, {
    name: "Fixture",
    options: { timeout: 9000 },
    models: { fixture: { name: "Fixture" } },
  })
  const saved = await put({ key: "fixture-only", baseURL: "http://127.0.0.1:4999/v1/" })
  expect(saved.status).toBe(200)
  expect(await Auth.get(id)).toEqual({ type: "api", key: "fixture-only" })
  expect((await Config.getGlobal()).provider?.[id]).toMatchObject({
    name: "Fixture",
    options: { timeout: 9000, baseURL: "http://127.0.0.1:4999/v1" },
    models: { fixture: { name: "Fixture" } },
  })
  expect((await put({ baseURL: "" })).status).toBe(200)
  expect((await Config.getGlobal()).provider?.[id]?.options?.baseURL).toBeUndefined()
  expect((await Config.getGlobal()).provider?.[id]?.options?.timeout).toBe(9000)
  expect(await Auth.get(id)).toEqual({ type: "api", key: "fixture-only" })
})

test.each([
  "http://provider.example/v1",
  "https://user:secret@provider.example/v1",
  "https://provider.example/v1?key=secret",
  "https://provider.example/v1#token",
  "https://provider.example/v1/responses",
  "https://provider.example/v1/chat/completions",
  "https://provider.example/v1/messages",
  "not a URL",
])("rejects invalid base URL without changing credentials: %s", async (baseURL) => {
  await Auth.set(id, { type: "api", key: "original" })
  const response = await put({ key: "replacement", baseURL })
  expect(response.status).toBe(400)
  expect(await Auth.get(id)).toEqual({ type: "api", key: "original" })
  expect((await Config.getGlobal()).provider?.[id]).toBeUndefined()
})

test("preserves environment references without writing their resolved values", async () => {
  process.env.CONNECTION_FIXTURE_TOKEN = "fixture-resolved-secret"
  try {
    await Config.setProvider(id, { options: { headers: { Authorization: "{env:CONNECTION_FIXTURE_TOKEN}" } } })
    expect((await put({ baseURL: "https://provider.example/v1" })).status).toBe(200)
    const raw = (await Config.getGlobalRaw()).content
    expect(raw).toContain("{env:CONNECTION_FIXTURE_TOKEN}")
    expect(raw).not.toContain("fixture-resolved-secret")
  } finally {
    delete process.env.CONNECTION_FIXTURE_TOKEN
  }
})

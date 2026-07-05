import { test, expect, afterAll } from "bun:test"
import { ComputeSettingsRoutes } from "../../src/server/routes/settings/compute"

// Every env var the compute store can own — cleaned up so other test files
// never see leftovers from this one.
const VARS = [
  "MODAL_TOKEN_ID",
  "MODAL_TOKEN_SECRET",
  "TENSORPOOL_KEY",
  "TENSORPOOL_API_KEY",
  "LAMBDA_API_KEY",
  "LAMBDA_LABS_API_KEY",
  "PRIME_API_KEY",
  "PRIME_INTELLECT_API_KEY",
  "VAST_API_KEY",
  "RUNPOD_API_KEY",
]

afterAll(() => {
  for (const name of VARS) delete process.env[name]
})

function connect(provider: string, key: string) {
  return ComputeSettingsRoutes().request(`/provider/${provider}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  })
}

test("connecting a provider applies its key to the process env under every canonical name", async () => {
  const res = await connect("tensorpool", "tp-test-secret-123")
  expect(res.status).toBe(200)

  // The saved key is live immediately — no restart needed.
  expect(process.env["TENSORPOOL_KEY"]).toBe("tp-test-secret-123")
  expect(process.env["TENSORPOOL_API_KEY"]).toBe("tp-test-secret-123")

  // The key itself never travels back to the client.
  const body = await res.text()
  expect(body).not.toContain("tp-test-secret-123")
  const info = JSON.parse(body)
  expect(info.providers.find((p: { id: string }) => p.id === "tensorpool").connected).toBe(true)
})

test("modal's combined key splits into token id + secret", async () => {
  const res = await connect("modal", "ak-test-id : as-test-secret")
  expect(res.status).toBe(200)
  expect(process.env["MODAL_TOKEN_ID"]).toBe("ak-test-id")
  expect(process.env["MODAL_TOKEN_SECRET"]).toBe("as-test-secret")
})

test("an explicit shell export always wins over a stored key", async () => {
  process.env["VAST_API_KEY"] = "from-shell"
  const res = await connect("vast", "vast-stored-key")
  expect(res.status).toBe(200)
  expect(process.env["VAST_API_KEY"]).toBe("from-shell")
})

test("disconnecting a provider removes the injected vars but never a shell export", async () => {
  for (const provider of ["tensorpool", "modal", "vast"]) {
    const res = await ComputeSettingsRoutes().request(`/provider/${provider}`, { method: "DELETE" })
    expect(res.status).toBe(200)
  }
  expect(process.env["TENSORPOOL_KEY"]).toBeUndefined()
  expect(process.env["TENSORPOOL_API_KEY"]).toBeUndefined()
  expect(process.env["MODAL_TOKEN_ID"]).toBeUndefined()
  expect(process.env["MODAL_TOKEN_SECRET"]).toBeUndefined()
  // The shell export was never owned by the store, so removal leaves it alone.
  expect(process.env["VAST_API_KEY"]).toBe("from-shell")
})

test("re-saving a key updates the injected value in place", async () => {
  await connect("runpod", "rpa_first")
  expect(process.env["RUNPOD_API_KEY"]).toBe("rpa_first")
  await connect("runpod", "rpa_second")
  expect(process.env["RUNPOD_API_KEY"]).toBe("rpa_second")
  await ComputeSettingsRoutes().request("/provider/runpod", { method: "DELETE" })
  expect(process.env["RUNPOD_API_KEY"]).toBeUndefined()
})

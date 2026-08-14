import { afterEach, expect, test } from "bun:test"
import { Network } from "../../src/settings/network"
import { NetworkSettingsRoutes } from "../../src/server/routes/settings/network"
import { Global } from "../../src/global"
import path from "node:path"
import fs from "node:fs/promises"

afterEach(async () => {
  await Network.set({ allowlistEnabled: false, enabled: ["package-management"], custom: [] })
})

test("domainAllowed accepts exact domains and subdomains only", () => {
  expect(Network.domainAllowed("example.com", ["example.com"])).toBe(true)
  expect(Network.domainAllowed("api.example.com", ["example.com"])).toBe(true)
  expect(Network.domainAllowed("badexample.com", ["example.com"])).toBe(false)
})

test("new installs enforce every curated package and science group", async () => {
  const file = path.join(Global.Path.data, "settings", "network.json")
  await fs.rm(file, { force: true })
  const state = Network.defaults()
  expect(await Network.get()).toEqual(state)
  expect(state.allowlistEnabled).toBe(true)
  expect(state.enabled).toEqual(Network.CATALOG.map((group) => group.id))
  await Network.set(state)

  await expect(Network.assertAllowed("https://files.pythonhosted.org/pkg.whl")).resolves.toBeUndefined()
  await expect(Network.assertAllowed("https://api.openalex.org/works")).resolves.toBeUndefined()
  await expect(Network.assertAllowed("https://unknown.example/data")).rejects.toThrow("allow-list")
})

test("migrates only the legacy unenforced seed and preserves an explicit v2 disable", async () => {
  const file = path.join(Global.Path.data, "settings", "network.json")
  await Bun.write(file, JSON.stringify({ allowlistEnabled: false, enabled: ["package-management"], custom: [] }))
  expect(await Network.get()).toEqual(Network.defaults())
  expect((await Bun.file(file).json()).version).toBe(2)

  await Network.set({ allowlistEnabled: false, enabled: ["package-management"], custom: [] })
  expect(await Network.get()).toEqual({ allowlistEnabled: false, enabled: ["package-management"], custom: [] })
})

test("migrates legacy clinical policy without broadening and is serialized and idempotent", async () => {
  const file = path.join(Global.Path.data, "settings", "network.json")
  await Bun.write(
    file,
    JSON.stringify({
      allowlistEnabled: true,
      enabled: ["ncbi-nih", "proteomics", "clinical-pharma", "literature-citations"],
      custom: ["Example.org"],
    }),
  )

  const expected = {
    allowlistEnabled: true,
    enabled: ["ncbi-nih", "proteomics", "clinical-regulatory", "literature-citations"],
    custom: ["example.org", "go.drugbank.com"],
  }
  const states = await Promise.all(Array.from({ length: 8 }, () => Network.get()))
  expect(states).toEqual(Array.from({ length: 8 }, () => expected))
  expect(await Network.blocked("https://go.drugbank.com/releases/latest")).toBeUndefined()
  expect(await Network.blocked("https://api.fda.gov/drug/event.json")).toBeUndefined()
  expect(await Network.blocked("https://bindingdb.org/rwd/bind/index.jsp")).toBe("bindingdb.org")

  const persisted = await Bun.file(file).json()
  expect(persisted).toEqual({ version: 2, ...expected })
  const before = await Bun.file(file).text()
  expect(await Network.get()).toEqual(expected)
  expect(await Bun.file(file).text()).toBe(before)
})

test("invalid or unsupported persisted policy denies all instead of restoring install defaults", async () => {
  const file = path.join(Global.Path.data, "settings", "network.json")
  for (const value of [
    "{",
    JSON.stringify({ version: 3, allowlistEnabled: true, enabled: [], custom: [] }),
    JSON.stringify({ version: 2, allowlistEnabled: true, enabled: ["unknown-group"], custom: [] }),
  ]) {
    await Bun.write(file, value)
    expect(await Network.get()).toEqual({ allowlistEnabled: true, enabled: [], custom: [] })
    expect(await Network.blocked("https://pypi.org/project/example")).toBe("pypi.org")
    expect(await Bun.file(file).text()).toBe(value)
  }
})

test("custom domains canonicalize and invalid policy input fails closed", async () => {
  expect(Network.canonicalDomain("Research.Example.")).toBe("research.example")
  await expect(Network.set({ allowlistEnabled: true, enabled: ["unknown-group"], custom: [] })).rejects.toThrow(
    "Unknown network group",
  )

  for (const invalid of [
    "https://example.com",
    "example.com/path",
    "*.example.com",
    "example.com:443",
    "127.0.0.1",
    "localhost",
    "service.local",
  ]) {
    expect(() => Network.canonicalDomain(invalid), invalid).toThrow()
  }
})

test("loopback and literal IP destinations stay blocked when enforcement is disabled", async () => {
  await Network.set({ allowlistEnabled: false, enabled: [], custom: [] })
  await expect(Network.blocked("http://localhost:4096/private")).rejects.toThrow("loopback")
  await expect(Network.blocked("http://127.0.0.1:4096/private")).rejects.toThrow()
  await expect(Network.blocked("http://[::1]:4096/private")).rejects.toThrow()
})

test("policy-aware fetch reauthorizes redirects and strips cross-origin credentials", async () => {
  const original = globalThis.fetch
  const calls: Array<{ url: string; headers: Headers }> = []
  await Network.set({ allowlistEnabled: true, enabled: [], custom: ["first.test"] })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const current = String(input)
    calls.push({ url: current, headers: new Headers(init?.headers) })
    if (current === "https://first.test/start") {
      return new Response(null, { status: 302, headers: { Location: "https://second.test/final" } })
    }
    return new Response("ok")
  }) as unknown as typeof fetch

  try {
    const resolveAddresses = async () => ["93.184.216.34"]
    await expect(
      Network.fetch(
        "https://first.test/start",
        { headers: { Authorization: "Bearer secret", Cookie: "a=b" } },
        { resolveAddresses },
      ),
    ).rejects.toThrow("second.test")
    expect(calls).toHaveLength(1)

    const approved: string[] = []
    const response = await Network.fetch(
      "https://first.test/start",
      { headers: { Authorization: "Bearer secret", Cookie: "a=b" } },
      {
        authorize: async ({ host }) => {
          approved.push(host)
        },
        resolveAddresses,
      },
    )
    expect(await response.text()).toBe("ok")
    expect(approved).toEqual(["second.test"])
    expect(calls.at(-1)?.headers.get("authorization")).toBeNull()
    expect(calls.at(-1)?.headers.get("cookie")).toBeNull()
  } finally {
    globalThis.fetch = original
  }
})

test("policy-aware fetch blocks redirects to loopback before opening a second socket", async () => {
  const original = globalThis.fetch
  const calls: string[] = []
  await Network.set({ allowlistEnabled: false, enabled: [], custom: [] })
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    calls.push(String(input))
    return new Response(null, { status: 302, headers: { Location: "http://127.0.0.1:4096/private" } })
  }) as unknown as typeof fetch
  try {
    await expect(
      Network.fetch("https://public.test/start", {}, { resolveAddresses: async () => ["93.184.216.34"] }),
    ).rejects.toThrow()
    expect(calls).toEqual(["https://public.test/start"])
  } finally {
    globalThis.fetch = original
  }
})

test("policy-aware fetch rejects private DNS answers before opening a socket", async () => {
  const original = globalThis.fetch
  let calls = 0
  await Network.set({ allowlistEnabled: false, enabled: [], custom: [] })
  globalThis.fetch = (async () => {
    calls++
    return new Response("should not run")
  }) as unknown as typeof fetch
  try {
    for (const address of ["127.0.0.1", "10.0.0.8", "169.254.169.254", "::1", "fc00::1"]) {
      await expect(
        Network.fetch("https://public.example/resource", {}, { resolveAddresses: async () => [address] }),
      ).rejects.toThrow("non-public address")
    }
    expect(calls).toBe(0)
  } finally {
    globalThis.fetch = original
  }
})

test("policy-aware fetch pins the validated address instead of resolving twice", async () => {
  await Network.set({ allowlistEnabled: false, enabled: [], custom: [] })
  let resolutions = 0
  const connected: string[] = []
  const response = await Network.fetch(
    "https://public.example/resource",
    {},
    {
      resolveAddresses: async () => {
        resolutions++
        return resolutions === 1 ? ["8.8.8.8"] : ["127.0.0.1"]
      },
      transport: async (_target, _init, address) => {
        connected.push(address)
        return new Response("pinned")
      },
    },
  )
  expect(await response.text()).toBe("pinned")
  expect(resolutions).toBe(1)
  expect(connected).toEqual(["8.8.8.8"])
})

test("policy-aware fetch rejects a declared oversized response before exposing its body", async () => {
  await Network.set({ allowlistEnabled: false, enabled: [], custom: [] })
  let cancelled = false
  const body = new ReadableStream({
    cancel() {
      cancelled = true
    },
  })

  await expect(
    Network.fetch(
      "https://public.example/large",
      {},
      {
        maxResponseBytes: 5,
        resolveAddresses: async () => ["8.8.8.8"],
        transport: async () =>
          new Response(body, {
            headers: {
              "content-length": "6",
              "content-type": "application/json",
              "content-disposition": 'attachment; filename="large.json"',
            },
          }),
      },
    ),
  ).rejects.toMatchObject({
    name: "ResponseTooLargeError",
    limitBytes: 5,
    declaredBytes: 6,
    contentType: "application/json",
    contentDisposition: 'attachment; filename="large.json"',
  })
  expect(cancelled).toBe(true)
})

test("assertAllowed is advisory when the allow-list is disabled", async () => {
  await Network.set({ allowlistEnabled: false, enabled: [], custom: [] })
  await expect(Network.assertAllowed("https://blocked.test/resource")).resolves.toBeUndefined()
})

test("assertAllowed blocks hosts outside the effective allow-list", async () => {
  await Network.set({ allowlistEnabled: true, enabled: [], custom: ["example.com"] })

  await expect(Network.assertAllowed("https://api.example.com/resource")).resolves.toBeUndefined()
  await expect(Network.assertAllowed("https://blocked.test/resource")).rejects.toThrow("allow-list")
})

test("settings GET and PUT round-trip backend-confirmed state and reject invalid hosts", async () => {
  const app = NetworkSettingsRoutes()
  const update = await app.request("/", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ allowlistEnabled: true, enabled: ["package-management"], custom: ["Lab.Example."] }),
  })
  expect(update.status).toBe(200)
  expect((await update.json()).state.custom).toEqual(["lab.example"])

  const current = await app.request("/")
  const payload = (await current.json()) as { state: Network.State; allowlist: string[] }
  expect(payload.state.custom).toEqual(["lab.example"])
  expect(payload.allowlist).toContain("lab.example")

  const invalid = await app.request("/", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ allowlistEnabled: true, enabled: [], custom: ["http://localhost:4096"] }),
  })
  expect(invalid.status).toBe(400)
})

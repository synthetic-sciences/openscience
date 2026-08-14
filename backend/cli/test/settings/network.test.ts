import { afterEach, expect, spyOn, test } from "bun:test"
import { Network } from "../../src/settings/network"
import { NetworkSettingsRoutes } from "../../src/server/routes/settings/network"
import { Global } from "../../src/global"
import { FileLease } from "../../src/util/file-lease"
import { DataRootBarrier } from "../../src/global/data-root-barrier"
import { randomUUID } from "node:crypto"
import path from "node:path"
import fs from "node:fs/promises"

async function waitForFile(filepath: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (await Bun.file(filepath).exists()) return
    await Bun.sleep(10)
  }
  throw new Error(`Timed out waiting for ${filepath}`)
}

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

test("network policy publication exposes a complete old or new state, never an in-place partial write", async () => {
  const file = path.join(Global.Path.data, "settings", "network.json")
  const previous = { allowlistEnabled: true, enabled: ["ncbi-nih"], custom: ["old.example"] }
  const next = { allowlistEnabled: true, enabled: ["proteomics"], custom: ["new.example"] }
  await Network.set(previous)

  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const renameOriginal = fs.rename.bind(fs)
  const rename = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
    if (destination === file && String(source).startsWith(`${file}.`) && String(source).endsWith(".tmp")) {
      entered.resolve()
      await release.promise
    }
    return renameOriginal(source, destination)
  })
  let pending: Promise<Network.State> | undefined
  try {
    pending = Network.set(next)
    await entered.promise
    expect(await Network.get()).toEqual(previous)
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ version: 2, ...previous })
    release.resolve()
    expect(await pending).toEqual(next)
    expect(await Network.get()).toEqual(next)
  } finally {
    release.resolve()
    await pending?.catch(() => undefined)
    rename.mockRestore()
  }
})

test("failed atomic network policy publication preserves the old state and removes its temporary", async () => {
  const file = path.join(Global.Path.data, "settings", "network.json")
  const previous = { allowlistEnabled: true, enabled: ["ncbi-nih"], custom: ["old.example"] }
  const next = { allowlistEnabled: true, enabled: ["proteomics"], custom: ["new.example"] }
  await Network.set(previous)

  const renameOriginal = fs.rename.bind(fs)
  const rename = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
    if (destination === file && String(source).startsWith(`${file}.`) && String(source).endsWith(".tmp")) {
      throw Object.assign(new Error("mock rename failure"), { code: "EIO" })
    }
    return renameOriginal(source, destination)
  })
  try {
    await expect(Network.set(next)).rejects.toThrow("mock rename failure")
  } finally {
    rename.mockRestore()
  }
  expect(await Network.get()).toEqual(previous)
  expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ version: 2, ...previous })
  expect((await fs.readdir(path.dirname(file))).filter((name) => /^network\.json\..+\.tmp$/.test(name))).toEqual([])
})

test("cross-process allow re-reads explicit policy after acquiring the stable settings lease", async () => {
  const file = path.join(Global.Path.data, "settings", "network.json")
  const leasePath = path.join(Global.Path.config, "network-settings.lock")
  const ready = path.join(Global.Path.config, `network-child-${randomUUID()}.ready`)
  const networkModule = new URL("../../src/settings/network.ts", import.meta.url).href
  const initial = { allowlistEnabled: true, enabled: ["ncbi-nih"], custom: ["initial.example"] }
  const explicit = { allowlistEnabled: true, enabled: ["proteomics"], custom: ["explicit.example"] }
  await Network.set(initial)

  const source = [
    `import { Network } from ${JSON.stringify(networkModule)}`,
    'import fs from "node:fs/promises"',
    `await fs.writeFile(${JSON.stringify(ready)}, "ready")`,
    'await Network.allow("child.example")',
  ].join("\n")
  let child: ReturnType<typeof Bun.spawn> | undefined
  try {
    {
      await using lease = await FileLease.acquire(leasePath)
      child = Bun.spawn([process.execPath, "-e", source], {
        cwd: path.resolve(import.meta.dir, "../.."),
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
      })
      await waitForFile(ready)
      expect(child.exitCode).toBeNull()
      await Bun.write(file, JSON.stringify({ version: 2, ...explicit }, null, 2))
      void lease
    }
    const exit = await child.exited
    if (exit !== 0) {
      const error = child.stderr instanceof ReadableStream ? await new Response(child.stderr).text() : ""
      throw new Error(`Network child failed: ${error}`)
    }
    expect(await Network.get()).toEqual({ ...explicit, custom: ["explicit.example", "child.example"] })
  } finally {
    child?.kill()
    await child?.exited.catch(() => undefined)
    await fs.rm(ready, { force: true })
  }
})

test("nested network mutation completes when relocation intent lands behind its CLI scope", async () => {
  const intent = path.join(Global.Path.config, "data-root-switch.intent")
  const next = { allowlistEnabled: true, enabled: ["proteomics"], custom: ["nested.example"] }
  const outerReady = Promise.withResolvers<void>()
  const startNested = Promise.withResolvers<void>()
  const nestedDone = Promise.withResolvers<void>()
  const command = (async () => {
    await using outer = await DataRootBarrier.enter(Global.Path.data, 2_000)
    return await outer.during(async () => {
      outerReady.resolve()
      await startNested.promise
      await Network.set(next)
      nestedDone.resolve()
    })
  })()
  let switching: Promise<AsyncDisposable> | undefined
  try {
    await outerReady.promise
    switching = DataRootBarrier.exclusive(1_000)
    await waitForFile(intent)
    startNested.resolve()
    expect(await Promise.race([nestedDone.promise.then(() => true), Bun.sleep(250).then(() => false)])).toBe(true)
    await command
    const exclusive = await switching
    await exclusive[Symbol.asyncDispose]()
    expect(await Network.get()).toEqual(next)
  } finally {
    startNested.resolve()
    await command.catch(() => undefined)
    const exclusive = await switching?.catch(() => undefined)
    await exclusive?.[Symbol.asyncDispose]()
  }
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

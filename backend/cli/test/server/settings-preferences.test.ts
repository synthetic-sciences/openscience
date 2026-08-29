import { expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { Preferences, SettingsPreferencesRoutes } from "../../src/server/routes/settings/preferences"

test("advanced navigation is opt-in by default", () => {
  expect(Preferences.parse({})).toMatchObject({
    show_trace: false,
    atlas_enabled: false,
    delegation_enabled: true,
    delegation_specialist: null,
    desktop_onboarding_operations: {},
  })
})

test("legacy managed-compute budget preferences round-trip as a no-op", () => {
  const preferences = Preferences.parse({ extra_budget_usd: 250 })

  expect(preferences.extra_budget_usd).toBe(250)
})

test("composer preferences persist through the settings route", async () => {
  const app = SettingsPreferencesRoutes()
  const update = await app.request("/", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      show_trace: true,
      atlas_enabled: false,
      extra_budget_usd: 75,
      delegation_enabled: false,
      delegation_specialist: "biology",
    }),
  })
  expect(update.status).toBe(200)
  expect((await update.json()) as Preferences).toMatchObject({
    show_trace: true,
    atlas_enabled: false,
    extra_budget_usd: 75,
    delegation_enabled: false,
    delegation_level: "off",
    delegation_specialist: "biology",
  })

  const read = await app.request("/")
  expect(read.status).toBe(200)
  expect((await read.json()) as Preferences).toMatchObject({
    show_trace: true,
    atlas_enabled: false,
    extra_budget_usd: 75,
    delegation_enabled: false,
    delegation_level: "off",
    delegation_specialist: "biology",
  })

  const modern = await app.request("/", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ delegation_level: "high" }),
  })
  expect((await modern.json()) as Preferences).toMatchObject({
    delegation_enabled: true,
    delegation_level: "high",
  })
})

test("desktop onboarding operation bindings are atomic, stable, and cleared individually", async () => {
  const app = SettingsPreferencesRoutes()
  const fingerprint = `same-draft-${crypto.randomUUID()}`
  const other = `other-draft-${crypto.randomUUID()}`
  const request = (value: string) =>
    app.request("/onboarding-operation", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fingerprint: value }),
    })

  const responses = await Promise.all(Array.from({ length: 8 }, () => request(fingerprint)))
  expect(responses.every((response) => response.status === 200)).toBe(true)
  const ids = await Promise.all(
    responses.map((response) => response.json().then((body) => (body as { operation_id: string }).operation_id)),
  )
  expect(new Set(ids).size).toBe(1)

  const second = await request(other)
  const secondID = ((await second.json()) as { operation_id: string }).operation_id
  expect(secondID).not.toBe(ids[0])

  const cleared = await app.request("/onboarding-operation", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fingerprint }),
  })
  expect(cleared.status).toBe(204)

  const current = (await (await app.request("/")).json()) as Preferences
  expect(current.desktop_onboarding_operations[fingerprint]).toBeUndefined()
  expect(current.desktop_onboarding_operations[other]).toBe(secondID)
})

test("concurrent preference patches preserve unrelated fields", async () => {
  const app = SettingsPreferencesRoutes()
  const patch = (body: Record<string, unknown>) =>
    app.request("/", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    })

  const responses = await Promise.all([patch({ show_trace: true }), patch({ show_local_models: false })])
  expect(responses.every((response) => response.status === 200)).toBe(true)
  const current = (await (await app.request("/")).json()) as Preferences
  expect(current.show_trace).toBe(true)
  expect(current.show_local_models).toBe(false)
})

test("a malformed settings file is served safely and never overwritten", async () => {
  const app = SettingsPreferencesRoutes()
  const filepath = path.join(Global.Path.config, "settings.json")
  const original = await fs.readFile(filepath).catch(() => undefined)
  await fs.mkdir(path.dirname(filepath), { recursive: true })
  await fs.writeFile(filepath, "{ definitely not json", { mode: 0o600 })
  try {
    const read = await app.request("/")
    expect(read.status).toBe(200)
    expect((await read.json()) as Preferences).toMatchObject(Preferences.parse({}))

    const update = await app.request("/", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ show_trace: true }),
    })
    expect(update.status).toBe(500)
    expect(await fs.readFile(filepath, "utf8")).toBe("{ definitely not json")
    expect(await fs.readFile(`${filepath}.corrupt-${process.pid}`, "utf8")).toBe("{ definitely not json")
  } finally {
    await fs.rm(`${filepath}.corrupt-${process.pid}`, { force: true })
    if (original) await fs.writeFile(filepath, original, { mode: 0o600 })
    else await fs.rm(filepath, { force: true })
  }
})

test("two processes reclaim one stale settings lease without losing either patch", async () => {
  const directory = path.join(Global.Path.config, "jsonstore-reclaimer")
  const target = path.join(directory, `${crypto.randomUUID()}.json`)
  const lock = `${target}.lock`
  const gate = `${target}.go`
  const fixture = new URL("../fixture/jsonstore-reclaimer.ts", import.meta.url).pathname
  await fs.mkdir(directory, { recursive: true })
  await fs.writeFile(target, JSON.stringify({ seed: true }), { mode: 0o600 })
  await fs.writeFile(
    lock,
    JSON.stringify({ pid: 2_147_483_647, token: crypto.randomUUID(), created: Date.now() - 60_000 }),
    { mode: 0o600 },
  )
  const spawn = (key: string) =>
    Bun.spawn([process.execPath, fixture, target, key, gate], {
      cwd: path.join(import.meta.dir, "../.."),
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    })
  const first = spawn("first")
  const second = spawn("second")
  await fs.writeFile(gate, "go", { mode: 0o600 })
  try {
    const [left, right] = await Promise.all([first.exited, second.exited])
    if (left !== 0 || right !== 0) {
      const detail = [await new Response(first.stderr).text(), await new Response(second.stderr).text()]
        .filter(Boolean)
        .join("\n")
      throw new Error(detail || `reclaimers exited ${left}/${right}`)
    }
    expect(await Bun.file(target).json()).toEqual({ seed: true, first: true, second: true })
  } finally {
    await Promise.all([
      fs.rm(target, { force: true }),
      fs.rm(lock, { force: true }),
      fs.rm(gate, { force: true }),
      fs.rm(`${lock}.coord`, { recursive: true, force: true }),
    ])
  }
})

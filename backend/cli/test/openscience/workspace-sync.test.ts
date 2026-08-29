import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../../src/global"
import { OpenScience } from "../../src/openscience"

const original = globalThis.fetch
const session = path.join(Global.Path.data, "openscience-session.json")
const scope = path.join(Global.Path.data, "openscience-workspace-scope.json")
const config = path.join(process.env.XDG_CONFIG_HOME!, "openscience")
const synced = path.join(config, "synced-env.json")
const settings = path.join(config, "openscience-synced.json")
const keys = ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "OPENALEX_API_KEY", "GITHUB_TOKEN"]

async function seed(value: Record<string, unknown>) {
  await fs.mkdir(Global.Path.data, { recursive: true })
  await Bun.write(
    session,
    JSON.stringify({
      api_key: "thk_workspace.secret",
      user_id: "user-workspace",
      device_name: "workspace-test",
      ...value,
    }),
  )
}

async function reset() {
  globalThis.fetch = original
  for (const key of keys) delete process.env[key]
  await Promise.all(
    [session, scope, synced, settings].map((target) => fs.rm(target, { force: true }).catch(() => undefined)),
  )
  OpenScience.invalidateBalance()
  OpenScience.invalidateResearchEntitlements()
}

beforeEach(reset)
afterEach(reset)

describe("workspace-scoped account sync", () => {
  test("a workspace-locked organization sync carries the organization and keeps shell credentials private", async () => {
    await seed({ api_key: "osk_workspace.secret", organization_id: "org_alpha", workspace_locked: true })
    process.env.OPENAI_API_KEY = "sk-local-openai"
    const headers: Array<string | null> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).pathname.endsWith("/api/cli/sync")) {
        headers.push(new Headers(init?.headers).get("X-Organization-ID"))
      }
      return Response.json(
        {
          user: { user_id: "user-workspace" },
          services: {
            anthropic: {
              connected: true,
              env: { ANTHROPIC_API_KEY: "sk-team-anthropic" },
              metadata: { source: "organization_byok" },
            },
            openai: {
              connected: true,
              env: { OPENAI_API_KEY: "sk-team-openai" },
              metadata: { source: "organization_byok" },
            },
          },
          config: {},
        },
        {
          headers: {
            "OpenScience-Funding-Protocol": "1",
            "OpenScience-Funding-Context": "organization:org_alpha",
          },
        },
      )
    }) as typeof fetch

    await OpenScience.syncServices()

    expect(headers).toEqual(["org_alpha"])
    expect(process.env.ANTHROPIC_API_KEY).toBe("sk-team-anthropic")
    expect(process.env.OPENAI_API_KEY).toBe("sk-local-openai")
  })

  test("a Personal or flexible session sends no organization and rejects team material", async () => {
    await seed({ organization_id: "org_legacy_selection" })
    const headers: Array<string | null> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      if (new URL(String(input)).pathname.endsWith("/api/cli/sync")) {
        headers.push(new Headers(init?.headers).get("X-Organization-ID"))
      }
      return Response.json({
        user: { user_id: "user-workspace" },
        services: {
          anthropic: {
            connected: true,
            env: { ANTHROPIC_API_KEY: "sk-team-must-not-apply" },
            metadata: { source: "organization_byok" },
          },
          openalex: {
            connected: true,
            env: { OPENALEX_API_KEY: "sk-personal-openalex" },
            metadata: { source: "byok" },
          },
        },
        config: {},
      })
    }) as typeof fetch

    await OpenScience.syncServices()

    expect(headers).toEqual([null])
    expect(process.env.ANTHROPIC_API_KEY).toBeUndefined()
    expect(process.env.OPENALEX_API_KEY).toBe("sk-personal-openalex")
  })

  test("the version probe uses the same workspace scope while unrelated account calls stay unscoped", async () => {
    await seed({
      api_key: "osk_workspace.secret",
      organization_id: "org_alpha",
      workspace_locked: true,
      cached_v: 7,
      last_check_ts: 0,
    })
    const calls: Array<{ path: string; organization: string | null }> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(input)).pathname
      calls.push({ path, organization: new Headers(init?.headers).get("X-Organization-ID") })
      if (path.endsWith("/api/cli/sync/version")) {
        return Response.json(
          { v: 7 },
          {
            headers: {
              "OpenScience-Funding-Protocol": "1",
              "OpenScience-Funding-Context": "organization:org_alpha",
            },
          },
        )
      }
      if (path.endsWith("/api/cli/devices")) return Response.json([])
      return new Response("not found", { status: 404 })
    }) as typeof fetch

    await OpenScience.refreshIfStale()
    await OpenScience.listDevices()

    expect(calls).toEqual([
      { path: "/api/cli/sync/version", organization: "org_alpha" },
      { path: "/api/cli/devices", organization: null },
    ])
  })

  test("replacing an organization workspace with Personal removes its synced secrets before the new session is published", async () => {
    await seed({ api_key: "osk_workspace.secret", organization_id: "org_alpha", workspace_locked: true })
    await fs.mkdir(config, { recursive: true })
    await Bun.write(synced, JSON.stringify({ GITHUB_TOKEN: "old-team-secret" }))
    await Bun.write(settings, JSON.stringify({ model: "old-team/model" }))
    process.env.GITHUB_TOKEN = "old-team-secret"
    globalThis.fetch = (async () => new Response("offline", { status: 503 })) as unknown as typeof fetch

    await OpenScience.saveSession({
      api_key: "thk_new-workspace.secret",
      user_id: "user-workspace",
      workspace_locked: true,
    })

    expect(await Bun.file(synced).exists()).toBe(false)
    expect(await Bun.file(settings).exists()).toBe(false)
    expect(process.env.GITHUB_TOKEN).toBeUndefined()
    expect((await OpenScience.getSession())?.organization_id).toBeUndefined()
  })

  test("an organization sync denial clears team credentials without signing out the workspace", async () => {
    await seed({ api_key: "osk_workspace.secret", organization_id: "org_alpha", workspace_locked: true })
    await fs.mkdir(config, { recursive: true })
    await Bun.write(synced, JSON.stringify({ GITHUB_TOKEN: "denied-team-secret" }))
    await Bun.write(settings, JSON.stringify({ model: "team/model" }))
    process.env.GITHUB_TOKEN = "denied-team-secret"
    globalThis.fetch = (async () => new Response("membership unavailable", { status: 403 })) as unknown as typeof fetch

    expect(await OpenScience.syncServices()).toBeNull()

    expect(await OpenScience.getSession()).toMatchObject({
      api_key: "osk_workspace.secret",
      organization_id: "org_alpha",
      workspace_locked: true,
    })
    expect(await Bun.file(synced).exists()).toBe(false)
    expect(await Bun.file(settings).exists()).toBe(false)
    expect(process.env.GITHUB_TOKEN).toBeUndefined()
  })

  test("a Personal or flexible sync denial keeps its existing offline snapshot", async () => {
    await seed({ organization_id: "org_legacy_selection" })
    await fs.mkdir(config, { recursive: true })
    await Bun.write(synced, JSON.stringify({ GITHUB_TOKEN: "personal-synced-secret" }))
    await Bun.write(settings, JSON.stringify({ model: "personal/model" }))
    process.env.GITHUB_TOKEN = "personal-synced-secret"
    globalThis.fetch = (async () => new Response("temporarily unavailable", { status: 403 })) as unknown as typeof fetch

    expect(await OpenScience.syncServices()).toBeNull()

    expect(await OpenScience.getSession()).toMatchObject({
      api_key: "thk_workspace.secret",
      organization_id: "org_legacy_selection",
    })
    expect(await Bun.file(synced).exists()).toBe(true)
    expect(await Bun.file(settings).exists()).toBe(true)
    expect(process.env.GITHUB_TOKEN).toBe("personal-synced-secret")
  })

  test("a delayed organization denial cannot clear a newly selected workspace", async () => {
    await seed({ api_key: "osk_workspace.secret", organization_id: "org_alpha", workspace_locked: true })
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    globalThis.fetch = (async (input: string | URL | Request) => {
      if (new URL(String(input)).pathname.endsWith("/api/cli/sync")) {
        started.resolve()
        await release.promise
        return new Response("old membership unavailable", { status: 403 })
      }
      return Response.json({ analytics_enabled: true })
    }) as typeof fetch

    const pending = OpenScience.syncServices()
    await started.promise
    await OpenScience.saveSession({
      api_key: "thk_new-workspace.secret",
      user_id: "user-workspace",
      workspace_locked: true,
    })
    await fs.mkdir(config, { recursive: true })
    await Bun.write(synced, JSON.stringify({ GITHUB_TOKEN: "new-personal-secret" }))
    await Bun.write(settings, JSON.stringify({ model: "personal/model" }))
    process.env.GITHUB_TOKEN = "new-personal-secret"
    release.resolve()

    expect(await pending).toBeNull()
    expect((await OpenScience.getSession())?.organization_id).toBeUndefined()
    expect(await Bun.file(synced).exists()).toBe(true)
    expect(await Bun.file(settings).exists()).toBe(true)
    expect(process.env.GITHUB_TOKEN).toBe("new-personal-secret")
  })

  test("a revoked organization key clears its session and cached team credentials", async () => {
    await seed({ api_key: "osk_workspace.secret", organization_id: "org_alpha", workspace_locked: true })
    await fs.mkdir(config, { recursive: true })
    await Bun.write(synced, JSON.stringify({ GITHUB_TOKEN: "revoked-team-secret" }))
    await Bun.write(settings, JSON.stringify({ model: "team/model" }))
    process.env.GITHUB_TOKEN = "revoked-team-secret"
    globalThis.fetch = (async () => new Response("revoked", { status: 401 })) as unknown as typeof fetch

    expect(await OpenScience.syncServices()).toBeNull()

    expect(await OpenScience.getSession()).toBeNull()
    expect(await Bun.file(synced).exists()).toBe(false)
    expect(await Bun.file(settings).exists()).toBe(false)
    expect(process.env.GITHUB_TOKEN).toBeUndefined()
  })
})

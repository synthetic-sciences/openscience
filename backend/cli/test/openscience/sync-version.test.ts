import { afterAll, beforeEach, expect, spyOn, test } from "bun:test"
import path from "node:path"

// The credential sync tick reads the server's digest first and fetches the
// full payload only when it moved, is unknown, or the periodic window
// elapsed. Every call here goes to an isolated loopback workspace.
const session = {
  api_key: "osk_fixture_sync_version",
  user_id: "user_v",
  organization_id: "org_v",
  workspace_locked: true,
}
function snapshot() {
  return {
    organization_id: "org_v",
    user: { user_id: "user_v" },
    services: {
      openai: {
        connected: true,
        env: { OPENAI_API_KEY: "fixture-cloud-openai" },
        metadata: { source: "workspace_byok" },
      },
      github: { connected: true, env: { GITHUB_TOKEN: "fixture-cloud-github" }, metadata: { source: "byok" } },
    },
    portable_credentials: {},
  }
}
const fixture = {
  payload: snapshot(),
  version: 7 as number | string,
  versionStatus: 200,
  versionBody: undefined as unknown,
  probes: 0,
  fulls: 0,
}
const funding = { "OpenScience-Funding-Protocol": "1", "OpenScience-Funding-Context": "organization:org_v" }
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const pathname = new URL(request.url).pathname
    if (pathname === "/api/cli/sync/version") {
      fixture.probes++
      expect(request.headers.get("authorization")).toBe(`Bearer ${session.api_key}`)
      return Response.json(fixture.versionBody ?? { version: fixture.version }, {
        status: fixture.versionStatus,
        headers: funding,
      })
    }
    if (pathname === "/api/cli/sync") {
      fixture.fulls++
      return Response.json(fixture.payload, { headers: funding })
    }
    return Response.json({})
  },
})
const previousApiBase = process.env.OPENSCIENCE_API_BASE
const envKeys = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "GITHUB_TOKEN", "GH_TOKEN"] as const
const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]))
process.env.OPENSCIENCE_API_BASE = server.url.toString()
const { OpenScience } = await import("../../src/openscience")
const { WorkspaceCredentials } = await import("../../src/openscience/workspace-credentials")
const { Auth } = await import("../../src/auth")
const { Global } = await import("../../src/global")
const { JsonStore } = await import("../../src/util/jsonstore")
const previousAuth = await Auth.all()

const expiresAt = async () => (await JsonStore.read(WorkspaceCredentials.filepath)).expires_at as number

beforeEach(async () => {
  fixture.payload = snapshot()
  fixture.version = 7
  fixture.versionStatus = 200
  fixture.versionBody = undefined
  fixture.probes = 0
  fixture.fulls = 0
  await OpenScience.clearSession()
  await JsonStore.update(path.join(Global.Path.data, "auth.json"), () => ({}))
  await OpenScience.saveSession(session)
})
afterAll(async () => {
  await OpenScience.clearSession()
  await JsonStore.update(path.join(Global.Path.data, "auth.json"), () => previousAuth)
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  server.stop(true)
  if (previousApiBase === undefined) delete process.env.OPENSCIENCE_API_BASE
  else process.env.OPENSCIENCE_API_BASE = previousApiBase
})

test("a tick fetches the payload only when the digest moved or the periodic window elapsed", async () => {
  let clock = Date.now()
  const now = spyOn(Date, "now").mockImplementation(() => clock)
  try {
    expect((await OpenScience.syncCredentials({ force: true })).state).toBe("ready")
    expect(fixture).toMatchObject({ probes: 1, fulls: 1 })
    expect(await Auth.get("openai")).toEqual({ type: "api", key: "fixture-cloud-openai" })
    const written = await expiresAt()

    // Unchanged digest: no payload, and the cached grant is renewed in place.
    clock += OpenScience.SYNC_INTERVAL
    const renewed = await OpenScience.syncCredentials()
    expect(renewed).toMatchObject({ state: "ready", organization_id: "org_v", synced_at: clock })
    expect(fixture).toMatchObject({ probes: 2, fulls: 1 })
    expect(await expiresAt()).toBe(clock + WorkspaceCredentials.TTL)
    expect(await expiresAt()).toBeGreaterThan(written)
    expect(WorkspaceCredentials.expiresAt()).toBe(clock + WorkspaceCredentials.TTL)
    expect(await Auth.get("openai")).toEqual({ type: "api", key: "fixture-cloud-openai" })

    // A moved digest fetches the payload and applies it.
    fixture.version = 8
    fixture.payload.services.openai.env.OPENAI_API_KEY = "fixture-rotated-openai"
    clock += OpenScience.SYNC_INTERVAL
    expect((await OpenScience.syncCredentials()).state).toBe("ready")
    expect(fixture).toMatchObject({ probes: 3, fulls: 2 })
    expect(await Auth.get("openai")).toEqual({ type: "api", key: "fixture-rotated-openai" })

    // Unchanged again inside the window, then the periodic full read.
    clock += OpenScience.SYNC_INTERVAL
    expect((await OpenScience.syncCredentials()).state).toBe("ready")
    expect(fixture).toMatchObject({ probes: 4, fulls: 2 })
    clock += OpenScience.SYNC_FULL_INTERVAL
    expect((await OpenScience.syncCredentials()).state).toBe("ready")
    expect(fixture).toMatchObject({ probes: 5, fulls: 3 })
  } finally {
    now.mockRestore()
  }
})

test("an unreadable digest, a forced sync or a missing grant fetches the payload", async () => {
  let clock = Date.now()
  const now = spyOn(Date, "now").mockImplementation(() => clock)
  try {
    expect((await OpenScience.syncCredentials({ force: true })).state).toBe("ready")
    expect(fixture).toMatchObject({ probes: 1, fulls: 1 })

    // A failing probe never blocks the sync; the full read decides.
    fixture.versionStatus = 503
    clock += OpenScience.SYNC_INTERVAL
    expect((await OpenScience.syncCredentials()).state).toBe("ready")
    expect(fixture).toMatchObject({ probes: 2, fulls: 2 })

    // A probe without a digest is unknown, not unchanged.
    fixture.versionStatus = 200
    fixture.versionBody = {}
    clock += OpenScience.SYNC_INTERVAL
    expect((await OpenScience.syncCredentials()).state).toBe("ready")
    expect(fixture).toMatchObject({ probes: 3, fulls: 3 })

    // The digest as a string still names the same payload.
    fixture.versionBody = undefined
    fixture.version = "7"
    clock += OpenScience.SYNC_INTERVAL
    expect((await OpenScience.syncCredentials()).state).toBe("ready")
    expect(fixture).toMatchObject({ probes: 4, fulls: 3 })

    // A forced sync (a login, a retry) always reads the payload.
    clock += OpenScience.SYNC_INTERVAL
    expect((await OpenScience.syncCredentials({ force: true })).state).toBe("ready")
    expect(fixture).toMatchObject({ probes: 5, fulls: 4 })

    // An unchanged digest cannot revive a grant that is no longer stored.
    await WorkspaceCredentials.clear()
    clock += OpenScience.SYNC_INTERVAL
    expect((await OpenScience.syncCredentials()).state).toBe("ready")
    expect(fixture).toMatchObject({ probes: 6, fulls: 5 })
    expect(await expiresAt()).toBe(clock + WorkspaceCredentials.TTL)
  } finally {
    now.mockRestore()
  }
})

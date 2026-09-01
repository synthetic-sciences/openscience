import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

const session = {
  api_key: "osk_fixture_workspace_a",
  user_id: "user_a",
  organization_id: "org_a",
  workspace_locked: true,
}
const device = {
  key_id: "device_a",
  name: "OpenScience CLI",
  key_prefix: "osk_fixture",
  created_at: "2026-09-01T00:00:00Z",
  last_used_at: "2026-09-01T01:00:00Z",
  expires_at: null,
}
function snapshot(organizationID = "org_a", userID = "user_a") {
  return {
    organization_id: organizationID,
    user: { user_id: userID },
    services: {
      openai: {
        connected: true,
        env: { OPENAI_API_KEY: "fixture-cloud-openai", AWS_ACCESS_KEY_ID: "ignored" },
        metadata: { source: "workspace_byok" },
      },
      openrouter: {
        connected: true,
        env: { OPENROUTER_API_KEY: "fixture-cloud-router" },
        metadata: { source: "workspace_byok" },
      },
      github: { connected: true, env: { GITHUB_TOKEN: "fixture-cloud-github" }, metadata: { source: "byok" } },
      nvidia: { connected: true, metadata: { source: "workspace_credential" } },
    },
    portable_credentials: { nvidia: { fields: { api_key: "fixture-cloud-nvidia", unexpected: "ignored" } } },
  }
}
let payload = snapshot()
let status = 200
let count = 0
let headers: Headers | undefined
let wait: Promise<void> | undefined
let stallBody = false
let permissions: unknown = {}
let authOrg: string | undefined = "org_a"
let authUser = "user_a"
let authStatus = 200
let authReads = 0
let browser: { state: string; redirect_uri: string } | undefined
let redeemed = session
let revokes: string[] = []
let activeRevokes: string[] = []
let revokeStatus = 204
let deviceBody: unknown = device
let deviceStatus = 200
let deviceReads: string[] = []
const previousApiBase = process.env.OPENSCIENCE_API_BASE
const envKeys = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_GENERATIVE_AI_BASE_URL",
  "GEMINI_API_KEY",
  "GEMINI_BASE_URL",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "XAI_API_KEY",
  "META_MODEL_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "NVIDIA_API_KEY",
  "AWS_ACCESS_KEY_ID",
] as const
const previousEnv = new Map(envKeys.map((key) => [key, process.env[key]]))
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(input) {
    if (new URL(input.url).pathname === "/api/v1/auth/cli/browser/start") {
      browser = (await input.json()) as { state: string; redirect_uri: string }
      return Response.json({ approval_url: new URL("/approve", input.url).toString() })
    }
    if (new URL(input.url).pathname === "/api/v1/auth/cli/browser/redeem") {
      const body = (await input.json()) as { state: string; exchange_token: string; redirect_uri: string }
      if (
        body.state !== browser?.state ||
        body.redirect_uri !== browser.redirect_uri ||
        body.exchange_token !== "fixture-exchange"
      )
        return new Response(null, { status: 400 })
      return Response.json(redeemed)
    }
    if (new URL(input.url).pathname === "/api/v1/auth/status") {
      authReads++
      return Response.json(
        {
          user: { user_id: authUser },
          api_key: { organization_id: authOrg, workspace_locked: true },
          funding_context: authOrg
            ? { type: "organization", organization_id: authOrg, locked: true }
            : { type: "personal", locked: true },
          organizations: authOrg
            ? [
                {
                  organization_id: authOrg,
                  name: "Workspace",
                  funding_available: true,
                  effective_permissions: permissions,
                },
              ]
            : [],
        },
        {
          status: authStatus,
          headers: {
            "OpenScience-Funding-Protocol": "1",
            "OpenScience-Funding-Context": authOrg ? `organization:${authOrg}` : "personal",
          },
        },
      )
    }
    if (new URL(input.url).pathname === "/api/cli/devices/current") {
      if (input.method === "GET") {
        deviceReads.push(input.headers.get("authorization") ?? "")
        return Response.json(deviceBody, { status: deviceStatus })
      }
      expect(input.method).toBe("DELETE")
      revokes.push(input.headers.get("authorization") ?? "")
      activeRevokes.push((await OpenScience.getSession())?.api_key ?? "")
      return new Response(null, { status: revokeStatus })
    }
    if (new URL(input.url).pathname !== "/api/cli/sync") return Response.json({})
    headers = new Headers(input.headers)
    count++
    await wait
    const responseHeaders = {
      "content-type": "application/json",
      "OpenScience-Funding-Protocol": "1",
      "OpenScience-Funding-Context": `organization:${payload.organization_id}`,
    }
    if (stallBody)
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"))
          },
        }),
        { headers: responseHeaders },
      )
    return Response.json(payload, { status, headers: responseHeaders })
  },
})
process.env.OPENSCIENCE_API_BASE = server.url.toString()
const { OpenScience } = await import("../../src/openscience")
const { WorkspaceCredentials } = await import("../../src/openscience/workspace-credentials")
const { Auth } = await import("../../src/auth")
const { Config } = await import("../../src/config/config")
const { Global } = await import("../../src/global")
const { JsonStore } = await import("../../src/util/jsonstore")
const { CredentialLifecycle } = await import("../../src/credentials/lifecycle")
const { CredentialsRoutes, resolveCredentialFields } = await import("../../src/server/routes/settings/credentials")
const { AccountRoutes } = await import("../../src/server/routes/account")
const { Provider } = await import("../../src/provider/provider")
const { SessionProcessor } = await import("../../src/session/processor")
const previousAuth = await Auth.all()
const previousConfig = await Config.getGlobalRaw()

beforeEach(async () => {
  payload = snapshot()
  status = 200
  count = 0
  headers = undefined
  wait = undefined
  stallBody = false
  permissions = {}
  authOrg = "org_a"
  authUser = "user_a"
  authStatus = 200
  authReads = 0
  browser = undefined
  redeemed = session
  revokes = []
  activeRevokes = []
  revokeStatus = 204
  deviceBody = device
  deviceStatus = 200
  deviceReads = []
  await OpenScience.clearSession()
  await JsonStore.update(path.join(Global.Path.data, "auth.json"), () => ({}))
  await JsonStore.update(path.join(Global.Path.data, "credentials.json"), () => ({}))
  await OpenScience.saveSession(session)
})
afterAll(async () => {
  await OpenScience.clearSession()
  await JsonStore.update(path.join(Global.Path.data, "auth.json"), () => previousAuth)
  await Config.replaceGlobal(previousConfig.content)
  for (const [key, value] of previousEnv) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  Provider.invalidate()
  server.stop(true)
  if (previousApiBase === undefined) delete process.env.OPENSCIENCE_API_BASE
  else process.env.OPENSCIENCE_API_BASE = previousApiBase
})

describe("workspace credential sync", () => {
  function github() {
    Object.assign(payload.services.github.metadata, {
      source: "github_connection",
      token_kind: "app",
      credential_renewal: {
        kind: "github-app-installation",
        authority: "a".repeat(64),
        expires_at: Date.now() + 60 * 60_000,
      },
    })
  }

  test("same-authority GitHub renewal refreshes env without aborting active work", async () => {
    github()
    await OpenScience.syncCredentials({ force: true })
    const before = await Bun.file(CredentialLifecycle.revisionPath()).json()
    const active = new AbortController()
    let refreshed = 0
    const off = CredentialLifecycle.onRevoke(() => active.abort())
    const refresh = CredentialLifecycle.onRefresh(() => {
      refreshed++
    })
    try {
      payload.services.github.env.GITHUB_TOKEN = "fixture-renewed-github"
      github()
      expect((await OpenScience.syncCredentials({ force: true })).state).toBe("ready")
      expect(process.env.GITHUB_TOKEN).toBe("fixture-renewed-github")
      expect(active.signal.aborted).toBe(false)
      expect(refreshed).toBe(1)
      const after = await Bun.file(CredentialLifecycle.revisionPath()).json()
      expect(after.reason).toBe("workspace-sync.renew")
      expect(after.revocation).toBe(before.revocation)
      // A simultaneous provider-key change is a real revocation, even with a
      // valid GitHub renewal receipt.
      payload.services.openai.env.OPENAI_API_KEY = "fixture-replaced-provider"
      expect((await OpenScience.syncCredentials({ force: true })).state).toBe("ready")
      expect(active.signal.aborted).toBe(true)
      expect((await Bun.file(CredentialLifecycle.revisionPath()).json()).revocation).not.toBe(before.revocation)
    } finally {
      off()
      refresh()
    }
  })

  test("credential comparisons ignore JSON property order but never credential changes", async () => {
    await OpenScience.syncCredentials({ force: true })
    const before = await Bun.file(CredentialLifecycle.revisionPath()).json()
    payload.services = Object.fromEntries(Object.entries(payload.services).reverse()) as typeof payload.services
    await OpenScience.syncCredentials({ force: true })
    expect((await Bun.file(CredentialLifecycle.revisionPath()).json()).token).toBe(before.token)
  })

  test("snapshot classification happens after acquiring the credential lease", async () => {
    github()
    await OpenScience.syncCredentials({ force: true })
    const active = new AbortController()
    const off = CredentialLifecycle.onRevoke(() => active.abort())
    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const blocker = CredentialLifecycle.serialized(async () => {
      entered.resolve()
      await release.promise
      const changed = WorkspaceCredentials.parse(payload).snapshot
      changed.services.github.token = "fixture-concurrent-connection"
      changed.github_renewal!.authority = "b".repeat(64)
      await WorkspaceCredentials.write(session, changed)
    })
    try {
      await entered.promise
      const previousCount = count
      const request = OpenScience.syncCredentials({ force: true })
      while (count === previousCount) await Bun.sleep(1)
      await Bun.sleep(10)
      release.resolve()
      await blocker
      await request
      expect(active.signal.aborted).toBe(true)
    } finally {
      release.resolve()
      await blocker
      off()
    }
  })

  test("renewal classification fails closed on authority, identity, scope, receipt and expiry changes", () => {
    github()
    const before = WorkspaceCredentials.parse(payload).snapshot
    const now = Date.now()
    const rotate = () => {
      const next = structuredClone(before)
      next.services.github.token = "fixture-renewal"
      return next
    }
    expect(WorkspaceCredentials.change(before, rotate(), now)).toBe("renew")
    const invalid = [
      (next: typeof before) => {
        next.github_renewal!.authority = "b".repeat(64)
      },
      (next: typeof before) => {
        delete next.github_renewal
      },
      (next: typeof before) => {
        next.github_renewal!.expires_at = now - 1
      },
      (next: typeof before) => {
        next.github_renewal!.expires_at = now + 70 * 60_000
      },
      (next: typeof before) => {
        next.organization_id = "other"
      },
      (next: typeof before) => {
        delete next.services.github
      },
      (next: typeof before) => {
        next.services.nvidia.api_key = "other"
      },
      (next: typeof before) => {
        next.auth.openai.key = "other"
      },
    ]
    for (const mutate of invalid) {
      const next = rotate()
      mutate(next)
      expect(WorkspaceCredentials.change(before, next, now)).toBe("revoke")
    }
    const expired = structuredClone(before)
    expired.github_renewal!.expires_at = now - 1
    expect(WorkspaceCredentials.change(expired, rotate(), now)).toBe("revoke")
    expect(WorkspaceCredentials.change(expired, structuredClone(expired), now)).toBe("revoke")
    payload.services.github.metadata.source = "byok"
    expect(WorkspaceCredentials.parse(payload).snapshot.github_renewal).toBeUndefined()
  })

  test("browser approval redeems a scoped device and completes its first credential sync", async () => {
    await OpenScience.clearSession()
    const result = await OpenScience.browserLogin({
      timeoutMs: 2000,
      onApprovalUrl: () => {
        const callback = new URL(browser!.redirect_uri)
        callback.searchParams.set("state", browser!.state)
        callback.searchParams.set("exchange_token", "fixture-exchange")
        void fetch(callback).then((response) => response.body?.cancel())
      },
    })
    expect(result.organization_id).toBe("org_a")
    expect(result.workspace_locked).toBe(true)
    expect(OpenScience.credentialSyncStatus().state).toBe("ready")
    expect(await Auth.get("openai")).toEqual({ type: "api", key: "fixture-cloud-openai" })
  })

  test("browser workspace replacement revokes the prior device only after activating the new one", async () => {
    redeemed = {
      api_key: "osk_fixture_workspace_b",
      user_id: "user_b",
      organization_id: "org_b",
      workspace_locked: true,
    }
    payload = snapshot("org_b", "user_b")
    const result = await OpenScience.browserLogin({
      timeoutMs: 2000,
      onApprovalUrl: () => {
        const callback = new URL(browser!.redirect_uri)
        callback.searchParams.set("state", browser!.state)
        callback.searchParams.set("exchange_token", "fixture-exchange")
        void fetch(callback).then((response) => response.body?.cancel())
      },
    })

    expect(result).toMatchObject(redeemed)
    expect(await OpenScience.getSession()).toMatchObject(redeemed)
    expect(revokes).toEqual([`Bearer ${session.api_key}`])
    expect(activeRevokes).toEqual([redeemed.api_key])
    expect(headers?.get("X-Organization-ID")).toBe("org_b")
  })

  test("an explicit login key replaces the existing device session and syncs its workspace", async () => {
    const { runAtlasLogin } = await import("../../src/cli/cmd/connect")
    const key = "osk_fixture_reconnected"
    expect(await runAtlasLogin({ key, browser: false })).toBe(true)
    expect((await OpenScience.getSession())?.api_key).toBe(key)
    expect(OpenScience.credentialSyncStatus().state).toBe("ready")
    expect(revokes).toEqual([`Bearer ${session.api_key}`])
    expect(OpenScience.getLoginWarning()).toBeUndefined()
  })

  test("concurrent logins serialize replacement and revoke every nonfinal device", async () => {
    const keys = ["osk_fixture_concurrent_a", "osk_fixture_concurrent_b"]
    await Promise.all(keys.map((key) => OpenScience.loginWithKey(key)))

    const final = (await OpenScience.getSession())?.api_key
    if (!final) throw new Error("Expected one concurrent login to remain active")
    expect(keys).toContain(final)
    const loser = keys.find((key) => key !== final)!
    expect(new Set(revokes)).toEqual(new Set([`Bearer ${session.api_key}`, `Bearer ${loser}`]))
    expect(revokes).not.toContain(`Bearer ${final}`)
  })

  test("an old server without self-revoke keeps the replacement active and exposes a warning", async () => {
    revokeStatus = 404
    const key = "osk_fixture_old_server"
    const result = await OpenScience.loginWithKey(key)

    expect(result.api_key).toBe(key)
    expect((await OpenScience.getSession())?.api_key).toBe(key)
    expect(OpenScience.credentialSyncStatus().state).toBe("ready")
    expect(revokes).toEqual([`Bearer ${session.api_key}`])
    expect(OpenScience.getLoginWarning()).toContain("previous device could not be revoked")
  })

  test("logout can revoke only its own device without browser-administration access", async () => {
    expect(await OpenScience.revokeCurrentDevice(2_000)).toBe(true)
    expect(revokes).toEqual([`Bearer ${session.api_key}`])
    expect(await OpenScience.getSession()).toEqual(session)
  })

  test("device listing reads only the authenticated device and rejects malformed or denied responses", async () => {
    expect(await OpenScience.listDevices()).toEqual([device])
    expect(deviceReads).toEqual([`Bearer ${session.api_key}`])

    deviceBody = { ...device, key_id: 42 }
    expect(await OpenScience.listDevices()).toBeNull()
    deviceStatus = 403
    expect(await OpenScience.listDevices()).toBeNull()
    expect(deviceReads).toHaveLength(3)
  })

  test("the local account route can revoke only its exact current device", async () => {
    const denied = await AccountRoutes().request("/devices/device_peer", { method: "DELETE" })
    expect(denied.status).toBe(200)
    expect(await denied.json()).toBe(false)
    expect(revokes).toEqual([])
    expect(await OpenScience.getSession()).toEqual(session)

    const revoked = await AccountRoutes().request(`/devices/${device.key_id}`, { method: "DELETE" })
    expect(revoked.status).toBe(200)
    expect(await revoked.json()).toBe(true)
    expect(deviceReads).toEqual([`Bearer ${session.api_key}`, `Bearer ${session.api_key}`])
    expect(revokes).toEqual([`Bearer ${session.api_key}`])
    expect(await OpenScience.getSession()).toBeNull()
  })

  test("verified sync repairs a legacy session that discarded its immutable workspace", async () => {
    await OpenScience.clearSession()
    await OpenScience.saveSession({
      api_key: "thk_fixture_legacy",
      user_id: "",
      device_name: "legacy client",
    })

    expect((await OpenScience.syncCredentials({ force: true })).state).toBe("ready")
    expect(await OpenScience.getSession()).toEqual({
      api_key: "thk_fixture_legacy",
      user_id: "user_a",
      device_name: "legacy client",
      organization_id: "org_a",
      workspace_locked: true,
    })
    expect(await Auth.get("openai")).toEqual({ type: "api", key: "fixture-cloud-openai" })
    permissions = { use_shared_wallet: true }
    expect(await OpenScience.getFundingContext()).toMatchObject({
      type: "organization",
      organization_id: "org_a",
      available: true,
      locked: true,
    })

    await OpenScience.syncCredentials({ force: true })
    expect(headers?.get("X-Organization-ID")).toBe("org_a")
  })

  test("account status reconciles a legacy session and returns one immutable billing snapshot", async () => {
    await OpenScience.clearSession()
    await OpenScience.saveSession({ api_key: "thk_fixture_status", user_id: "" })
    permissions = { use_shared_wallet: true }

    const state = await OpenScience.getReconciledFundingState()
    expect(state?.snapshot).toMatchObject({
      api_key: "thk_fixture_status",
      user_id: "user_a",
      organization_id: "org_a",
      workspace_locked: true,
    })
    expect(state?.context).toMatchObject({
      type: "organization",
      organization_id: "org_a",
      available: true,
      locked: true,
    })
  })

  test("a managed turn starting from a legacy snapshot binds the verified workspace before dispatch", async () => {
    await OpenScience.clearSession()
    await OpenScience.saveSession({ api_key: "thk_fixture_pre_sync", user_id: "" })
    const stale = (await OpenScience.getFundingSnapshot())!
    const drift = Response.json(
      {},
      {
        headers: {
          "OpenScience-Funding-Protocol": "1",
          "OpenScience-Funding-Context": "organization:org_other",
        },
      },
    )
    await expect(OpenScience.validateFundingResponse(drift, stale)).rejects.toThrow("verify the selected workspace")

    const selected = await OpenScience.managedRequestSnapshot(stale.api_key, stale)
    expect(selected).toMatchObject({
      api_key: stale.api_key,
      user_id: "user_a",
      organization_id: "org_a",
      workspace_locked: true,
    })
    expect(await OpenScience.getSession()).toMatchObject({
      api_key: selected.api_key,
      user_id: selected.user_id,
      organization_id: selected.organization_id,
      workspace_locked: selected.workspace_locked,
    })
    expect(authReads).toBeGreaterThan(0)
  })

  test("a scoped account cannot be relabeled by another self-consistent workspace response", async () => {
    authOrg = "org_b"
    authUser = "user_b"
    permissions = { use_shared_wallet: true }

    const state = await OpenScience.getReconciledFundingState()
    expect(state?.snapshot).toMatchObject(session)
    expect(state?.context).toMatchObject({ type: "organization", organization_id: "org_a", available: false })
    expect(await OpenScience.getSession()).toEqual(session)
  })

  test("unsaved legacy and workspace keys both fail before managed dispatch", async () => {
    await OpenScience.clearSession()
    for (const key of ["thk_fixture_unsaved", "osk_fixture_unsaved"]) {
      await expect(OpenScience.managedRequestSnapshot(key)).rejects.toThrow("Sign in again")
    }
    expect(authReads).toBe(0)
  })

  test("a BYOK turn never consults Atlas because an Ace session is saved", async () => {
    authStatus = 503
    expect(await SessionProcessor.fundingSnapshot("byok")).toBeUndefined()
    expect(authReads).toBe(0)
  })

  test("uses the scoped wire contract and real encrypted provider/trusted-service consumers without changing Ace", async () => {
    await Config.updateGlobal({ billing: { llm: "managed" } }, { preserveInstances: true })
    expect((await OpenScience.syncCredentials({ force: true })).state).toBe("ready")
    expect(headers?.get("X-Organization-ID")).toBe("org_a")
    expect(headers?.get("authorization")).toBe(`Bearer ${session.api_key}`)
    expect(await Auth.get("openai")).toEqual({ type: "api", key: "fixture-cloud-openai" })
    expect((await Config.getGlobal()).billing?.llm).toBe("managed")
    expect(await resolveCredentialFields("nvidia")).toEqual({ api_key: "fixture-cloud-nvidia" })
    expect(process.env.GITHUB_TOKEN).toBe("fixture-cloud-github")
    expect(process.env.NVIDIA_API_KEY).toBeUndefined()
    expect(process.env.AWS_ACCESS_KEY_ID).toBeUndefined()
    const file = await Bun.file(WorkspaceCredentials.filepath).text()
    expect(file).not.toContain("fixture-cloud")
    expect((await fs.stat(WorkspaceCredentials.filepath)).mode & 0o777).toBe(0o600)
  })

  test("local provider and service credentials override sync; snapshot deletion removes only cloud-owned keys", async () => {
    await Auth.set("openai", { type: "api", key: "fixture-local-openai" })
    await CredentialsRoutes().request("/github", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fields: { token: "fixture-local-github" } }),
    })
    await OpenScience.syncCredentials({ force: true })
    expect(await Auth.get("openai")).toEqual({ type: "api", key: "fixture-local-openai" })
    expect(process.env.GITHUB_TOKEN).toBe("fixture-local-github")
    payload.services = {} as ReturnType<typeof snapshot>["services"]
    payload.portable_credentials = {} as ReturnType<typeof snapshot>["portable_credentials"]
    await OpenScience.syncCredentials({ force: true })
    expect(await Auth.get("openrouter")).toBeUndefined()
    expect(await Auth.get("openai")).toEqual({ type: "api", key: "fixture-local-openai" })
    expect(await resolveCredentialFields("nvidia")).toBeUndefined()
    expect(process.env.GITHUB_TOKEN).toBe("fixture-local-github")
  })

  test("local provider env beats synced keys without changing saved-key priority or adopting cloud env", async () => {
    const { Provider } = await import("../../src/provider/provider")
    const { Instance } = await import("../../src/project/instance")
    const { tmpdir } = await import("../fixture/fixture")
    const names = ["OPENAI_API_KEY", "OPENROUTER_API_KEY", ...WorkspaceCredentials.providerEnv("google")]
    const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]))
    Object.assign(payload.services, {
      gemini: {
        connected: true,
        env: { GOOGLE_GENERATIVE_AI_API_KEY: "fixture-cloud-google" },
        metadata: { source: "workspace_byok" },
      },
    })
    await OpenScience.syncCredentials({ force: true })
    await using tmp = await tmpdir({ config: { billing: { llm: "byok" } } })
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          process.env.OPENAI_API_KEY = "fixture-shell-openai"
          process.env.OPENROUTER_API_KEY = "fixture-shell-router"
          Provider.invalidate()
          const local = await Provider.list()
          expect(Provider.effectiveKey(local.openai)).toBe("fixture-shell-openai")
          expect(Provider.effectiveKey(local.openrouter)).toBe("fixture-shell-router")
          expect(await Auth.get("openai")).toBeUndefined()
          await Auth.set("openai", { type: "api", key: "fixture-saved-openai" })
          expect(Provider.effectiveKey((await Provider.list()).openai)).toBe("fixture-saved-openai")
          await Auth.remove("openai")
          for (const name of WorkspaceCredentials.providerEnv("google")) {
            process.env[name] = "fixture-local-google"
            Provider.invalidate()
            expect(await Auth.get("google")).toBeUndefined()
            expect(Provider.effectiveKey((await Provider.list()).google)).toBe("fixture-local-google")
            delete process.env[name]
          }
          // An equal-valued shell key is still local, while an Ace token is
          // never a direct-provider credential and cannot suppress the overlay.
          process.env.OPENAI_API_KEY = "fixture-cloud-openai"
          expect(await Auth.get("openai")).toBeUndefined()
          process.env.OPENAI_API_KEY = "osk_fixture_not_a_provider_key"
          process.env.GOOGLE_GENERATIVE_AI_API_KEY = "thk_fixture_not_a_provider_key"
          delete process.env.OPENROUTER_API_KEY
          Provider.invalidate()
          const cloud = await Provider.list()
          expect(Provider.effectiveKey(cloud.openai)).toBe("fixture-cloud-openai")
          expect(Provider.effectiveKey(cloud.google)).toBe("fixture-cloud-google")
          expect(Provider.effectiveKey(cloud.openrouter)).toBe("fixture-cloud-router")
          expect(process.env.GITHUB_TOKEN).toBe("fixture-cloud-github")
        },
      })
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      Provider.invalidate()
    }
  })

  test("permission revocation removes cloud credentials without logging out or deleting local keys", async () => {
    await Auth.set("openai", { type: "api", key: "fixture-local" })
    await OpenScience.syncCredentials({ force: true })
    status = 403
    expect((await OpenScience.syncCredentials({ force: true })).state).toBe("error")
    expect(await OpenScience.getSession()).toEqual(session)
    expect(await Auth.get("openrouter")).toBeUndefined()
    expect(await Auth.get("openai")).toEqual({ type: "api", key: "fixture-local" })
    expect(process.env.GITHUB_TOKEN).toBeUndefined()
  })

  test("synced-only credentials cannot report a successful local deletion", async () => {
    await OpenScience.syncCredentials({ force: true })
    await expect(Auth.remove("openrouter")).rejects.toThrow("Manage this synced provider key")
    const result = await CredentialsRoutes().request("/nvidia", { method: "DELETE" })
    expect(result.status).toBe(409)
    expect(await resolveCredentialFields("nvidia")).toEqual({ api_key: "fixture-cloud-nvidia" })
  })

  test("device revocation clears the matching account and overlay, preserving local keys", async () => {
    await Auth.set("openai", { type: "api", key: "fixture-local" })
    await OpenScience.syncCredentials({ force: true })
    status = 401
    await OpenScience.syncCredentials({ force: true })
    expect(await OpenScience.getSession()).toBeNull()
    expect(await Auth.get("openrouter")).toBeUndefined()
    expect(await Auth.get("openai")).toEqual({ type: "api", key: "fixture-local" })
  })

  test("a response from another workspace is rejected before credentials are installed", async () => {
    payload.organization_id = "org_other"
    expect((await OpenScience.syncCredentials({ force: true })).state).toBe("error")
    expect(await Auth.get("openai")).toBeUndefined()
  })

  test("an old account response cannot overwrite a newly connected account", async () => {
    let release = () => {}
    wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const pending = OpenScience.syncCredentials({ force: true })
    while (!count) await Bun.sleep(1)
    await OpenScience.saveSession({ ...session, api_key: "osk_fixture_workspace_b", organization_id: "org_b" })
    release()
    await pending
    expect((await OpenScience.getSession())?.organization_id).toBe("org_b")
    expect(await Auth.get("openai")).toBeUndefined()
  })

  test("legacy scope reconciliation cannot overwrite a newly connected account", async () => {
    await OpenScience.clearSession()
    await OpenScience.saveSession({ api_key: "thk_fixture_legacy", user_id: "" })
    const release = Promise.withResolvers<void>()
    wait = release.promise
    const pending = OpenScience.syncCredentials({ force: true })
    while (!count) await Bun.sleep(1)
    await OpenScience.saveSession({
      api_key: "osk_fixture_workspace_b",
      user_id: "user_b",
      organization_id: "org_b",
      workspace_locked: true,
    })
    release.resolve()
    await pending
    expect(await OpenScience.getSession()).toEqual({
      api_key: "osk_fixture_workspace_b",
      user_id: "user_b",
      organization_id: "org_b",
      workspace_locked: true,
    })
    expect(await Auth.get("openai")).toBeUndefined()
  })

  test("a stalled response body has a deadline, preserves the temporary cache, and can be retried", async () => {
    await OpenScience.syncCredentials({ force: true })
    stallBody = true
    const start = Date.now()
    const result = await OpenScience.syncCredentials({ force: true, timeoutMs: 40 })
    expect(result.state).toBe("error")
    expect(Date.now() - start).toBeLessThan(1000)
    expect(await Auth.get("openai")).toEqual({ type: "api", key: "fixture-cloud-openai" })
    stallBody = false
    expect((await OpenScience.syncCredentials({ force: true })).state).toBe("ready")
  })

  test("simultaneous refreshes join one request", async () => {
    await Promise.all([OpenScience.syncCredentials({ force: true }), OpenScience.syncCredentials({ force: true })])
    expect(count).toBe(1)
  })

  test("expired grants revoke injected environment as well as provider keys", async () => {
    await OpenScience.syncCredentials({ force: true })
    await JsonStore.update(WorkspaceCredentials.filepath, (store) => ({ ...store, expires_at: Date.now() - 1 }))
    await WorkspaceCredentials.expire()
    expect(await Auth.get("openai")).toBeUndefined()
    expect(process.env.GITHUB_TOKEN).toBeUndefined()
  })

  test("managed placeholders and OAuth proxy carriers never become direct API keys", () => {
    payload.services.openai.metadata.source = "openai_codex_oauth"
    payload.services.openrouter.env.OPENROUTER_API_KEY = session.api_key
    expect(WorkspaceCredentials.parse(payload).snapshot.auth).toEqual({})
  })

  test("a GitHub App connection uses its real short-lived token", () => {
    payload.services.github.metadata.source = "github_connection"
    expect(WorkspaceCredentials.parse(payload).snapshot.services.github).toEqual({ token: "fixture-cloud-github" })
  })

  test("funding permissions accept only true-valued hosted permission fields", async () => {
    permissions = { use_shared_wallet: true, manage_billing: false }
    expect((await OpenScience.getFundingContext()).available).toBe(true)
    permissions = { use_shared_wallet: "true" }
    expect((await OpenScience.getFundingContext()).available).toBe(false)
    permissions = ["use_shared_wallet"]
    expect((await OpenScience.getFundingContext()).available).toBe(true)
  })

  test("legacy account-attributed service entries cannot become permanent local credentials", async () => {
    await JsonStore.update(path.join(Global.Path.data, "credentials.json"), () => ({
      nvidia: { source: "account", fields: { api_key: "old-ciphertext" }, updated_at: new Date().toISOString() },
    }))
    const result = await CredentialsRoutes().request("/")
    const body = (await result.json()) as { services: { id: string; source: string | null; connected: boolean }[] }
    expect(body.services.find((service) => service.id === "nvidia")).toMatchObject({
      source: null,
      connected: false,
      category: "integration",
    })
  })
})

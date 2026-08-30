import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"

const session = {
  api_key: "osk_fixture_workspace_a",
  user_id: "user_a",
  organization_id: "org_a",
  workspace_locked: true,
}
function snapshot() {
  return {
    organization_id: "org_a",
    user: { user_id: "user_a" },
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
let browser: { state: string; redirect_uri: string } | undefined
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
      return Response.json(session)
    }
    if (new URL(input.url).pathname === "/api/v1/auth/status")
      return Response.json(
        {
          user: { user_id: "user_a" },
          funding_context: { type: "organization", organization_id: "org_a", locked: true },
          organizations: [
            {
              organization_id: "org_a",
              name: "Workspace",
              funding_available: true,
              effective_permissions: permissions,
            },
          ],
        },
        { headers: { "OpenScience-Funding-Protocol": "1", "OpenScience-Funding-Context": "organization:org_a" } },
      )
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
const { CredentialsRoutes, resolveCredentialFields } = await import("../../src/server/routes/settings/credentials")

beforeEach(async () => {
  payload = snapshot()
  status = 200
  count = 0
  headers = undefined
  wait = undefined
  stallBody = false
  permissions = {}
  browser = undefined
  await OpenScience.clearSession()
  await JsonStore.update(path.join(Global.Path.data, "auth.json"), () => ({}))
  await JsonStore.update(path.join(Global.Path.data, "credentials.json"), () => ({}))
  await OpenScience.saveSession(session)
})
afterAll(async () => {
  await OpenScience.clearSession()
  server.stop(true)
})

describe("workspace credential sync", () => {
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

  test("an explicit login key replaces the existing device session and syncs its workspace", async () => {
    const { runAtlasLogin } = await import("../../src/cli/cmd/connect")
    const key = "osk_fixture_reconnected"
    expect(await runAtlasLogin({ key, browser: false })).toBe(true)
    expect((await OpenScience.getSession())?.api_key).toBe(key)
    expect(OpenScience.credentialSyncStatus().state).toBe("ready")
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
    expect(body.services.find((service) => service.id === "nvidia")).toMatchObject({ source: null, connected: false })
  })
})

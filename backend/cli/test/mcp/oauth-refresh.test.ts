import { test, expect, beforeEach } from "bun:test"
import { createHash } from "node:crypto"
import path from "path"
import fs from "fs/promises"
import { Global } from "../../src/global"
import { McpAuth } from "../../src/mcp/auth"
import { McpOAuthProvider } from "../../src/mcp/oauth-provider"
import { Log } from "../../src/util/log"

const authorityFingerprint = createHash("sha256").update("mcp-oauth-refresh-authority").digest("hex")

beforeEach(async () => {
  await fs.mkdir(Global.Path.data, { recursive: true })
  const entries = await fs.readdir(Global.Path.data)
  await Promise.all(
    entries
      .filter((name) => name.startsWith("mcp-auth.json"))
      .map((name) => fs.rm(path.join(Global.Path.data, name), { force: true })),
  )
})

// Real OAuth authorization server on a loopback port. Serves discovery
// metadata and a token endpoint whose behavior each test controls.
function serve(token: (params: URLSearchParams, origin: string) => Promise<Response> | Response) {
  return Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: url.origin,
          authorization_endpoint: `${url.origin}/authorize`,
          token_endpoint: `${url.origin}/token`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          token_endpoint_auth_methods_supported: ["none"],
        })
      }
      if (url.pathname === "/token") {
        return token(new URLSearchParams(await req.text()), url.origin)
      }
      return new Response("not found", { status: 404 })
    },
  })
}

function provider(name: string, url: string) {
  return new McpOAuthProvider(
    name,
    url,
    { clientId: "client-1" },
    { onRedirect: async () => {} },
    { verify: async () => undefined, authorityFingerprint },
  )
}

test("expired tokens refresh once across concurrent callers", async () => {
  const name = "refresh-single-flight"
  const counter = { refreshes: 0 }
  const server = serve((params) => {
    expect(params.get("grant_type")).toBe("refresh_token")
    expect(params.get("refresh_token")).toBe("rotate-1")
    counter.refreshes++
    return Response.json({
      access_token: "fresh-access",
      token_type: "Bearer",
      refresh_token: "rotate-2",
      expires_in: 3600,
    })
  })
  const url = `http://127.0.0.1:${server.port}`
  await McpAuth.set(
    name,
    {
      tokens: { accessToken: "stale-access", refreshToken: "rotate-1", expiresAt: Date.now() / 1000 - 60 },
      credentialAuthorityFingerprint: authorityFingerprint,
    },
    url,
  )

  const client = provider(name, url)
  const [first, second] = await Promise.all([client.tokens(), client.tokens()])
  expect(counter.refreshes).toBe(1)
  expect(first?.access_token).toBe("fresh-access")
  expect(second?.access_token).toBe("fresh-access")

  const saved = await McpAuth.get(name)
  expect(saved?.tokens?.accessToken).toBe("fresh-access")
  expect(saved?.tokens?.refreshToken).toBe("rotate-2")

  server.stop(true)
  await McpAuth.remove(name)
})

test("failed refresh recovers with the rotated token another process persisted", async () => {
  const name = "refresh-recovery"
  const attempts: string[] = []
  const server = serve(async (params) => {
    const sent = params.get("refresh_token") ?? ""
    attempts.push(sent)
    if (sent === "revoked-1") {
      // Simulate the winning process: it already persisted the rotated pair
      // (with an expired access token, so recovery must retry the refresh).
      await McpAuth.updateTokens(name, {
        accessToken: "stale-access",
        refreshToken: "rotated-2",
        expiresAt: Date.now() / 1000 - 60,
      })
      return Response.json({ error: "invalid_grant" }, { status: 400 })
    }
    expect(sent).toBe("rotated-2")
    return Response.json({
      access_token: "recovered-access",
      token_type: "Bearer",
      refresh_token: "rotated-3",
      expires_in: 3600,
    })
  })
  const url = `http://127.0.0.1:${server.port}`
  await McpAuth.set(
    name,
    {
      tokens: { accessToken: "stale-access", refreshToken: "revoked-1", expiresAt: Date.now() / 1000 - 60 },
      credentialAuthorityFingerprint: authorityFingerprint,
    },
    url,
  )

  const tokens = await provider(name, url).tokens()
  expect(attempts).toEqual(["revoked-1", "rotated-2"])
  expect(tokens?.access_token).toBe("recovered-access")

  const saved = await McpAuth.get(name)
  expect(saved?.tokens?.refreshToken).toBe("rotated-3")

  server.stop(true)
  await McpAuth.remove(name)
})

test("failed refresh uses a still-valid access token another process persisted", async () => {
  const name = "refresh-reuse"
  const attempts: string[] = []
  const server = serve(async (params) => {
    attempts.push(params.get("refresh_token") ?? "")
    // Simulate the winning process persisting a fresh, unexpired pair.
    await McpAuth.updateTokens(name, {
      accessToken: "winner-access",
      refreshToken: "winner-refresh",
      expiresAt: Date.now() / 1000 + 3600,
    })
    return Response.json({ error: "invalid_grant" }, { status: 400 })
  })
  const url = `http://127.0.0.1:${server.port}`
  await McpAuth.set(
    name,
    {
      tokens: { accessToken: "stale-access", refreshToken: "revoked-1", expiresAt: Date.now() / 1000 - 60 },
      credentialAuthorityFingerprint: authorityFingerprint,
    },
    url,
  )

  const tokens = await provider(name, url).tokens()
  expect(attempts).toEqual(["revoked-1"])
  expect(tokens?.access_token).toBe("winner-access")

  server.stop(true)
  await McpAuth.remove(name)
})

test("an SDK refresh loser cannot invalidate a newer rotated winner", async () => {
  const name = "refresh-loser-preserves-winner"
  const url = "https://refresh.example/mcp"
  await McpAuth.set(
    name,
    {
      tokens: {
        accessToken: "access-1",
        refreshToken: "refresh-1",
        expiresAt: Date.now() / 1000 + 3600,
      },
      credentialAuthorityFingerprint: authorityFingerprint,
    },
    url,
  )

  const winner = provider(name, url)
  const loser = provider(name, url)
  expect((await winner.tokens())?.refresh_token).toBe("refresh-1")
  expect((await loser.tokens())?.refresh_token).toBe("refresh-1")

  // The winner's SDK exchange rotates R1 -> R2 before the losing exchange
  // reports invalid_grant and asks the provider to invalidate its rejected
  // credentials.
  await winner.saveTokens({
    access_token: "access-2",
    token_type: "Bearer",
    refresh_token: "refresh-2",
    expires_in: 3600,
  })
  await loser.invalidateCredentials("tokens")

  expect((await McpAuth.getForAuthority(name, url, authorityFingerprint))?.tokens).toMatchObject({
    accessToken: "access-2",
    refreshToken: "refresh-2",
  })
  await McpAuth.remove(name)
})

test("refresh keeps the current refresh token and scope when the server omits replacements", async () => {
  const name = "refresh-preserves-optional-fields"
  const server = serve(() =>
    Response.json({
      access_token: "fresh-access",
      token_type: "Bearer",
      expires_in: 3600,
    }),
  )
  const url = `http://127.0.0.1:${server.port}`
  await McpAuth.set(
    name,
    {
      tokens: {
        accessToken: "stale-access",
        refreshToken: "keep-refresh",
        expiresAt: Date.now() / 1000 - 60,
        scope: "read tools",
      },
      credentialAuthorityFingerprint: authorityFingerprint,
    },
    url,
  )

  const tokens = await provider(name, url).tokens()
  expect(tokens?.access_token).toBe("fresh-access")
  expect(tokens?.refresh_token).toBe("keep-refresh")
  expect(tokens?.scope).toBe("read tools")
  expect((await McpAuth.get(name))?.tokens).toMatchObject({
    accessToken: "fresh-access",
    refreshToken: "keep-refresh",
    scope: "read tools",
  })

  server.stop(true)
  await McpAuth.remove(name)
})

test("OAuth refresh never follows a redirect carrying the refresh token", async () => {
  const name = "refresh-no-redirect"
  const expiredAccess = `expired-access-${createHash("sha256").update(name).digest("hex")}`
  let sinkRequests = 0
  const sink = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      sinkRequests++
      await req.text()
      return Response.json({ access_token: "leaked", token_type: "Bearer" })
    },
  })
  const source = serve(
    (_params, origin) =>
      new Response(null, {
        status: 307,
        headers: { location: `http://127.0.0.1:${sink.port}/leak`, "x-origin": origin },
      }),
  )
  const url = `http://127.0.0.1:${source.port}`
  await McpAuth.set(
    name,
    {
      tokens: { accessToken: expiredAccess, refreshToken: "never-forward", expiresAt: Date.now() / 1000 - 60 },
      credentialAuthorityFingerprint: authorityFingerprint,
    },
    url,
  )

  await provider(name, url).tokens()
  expect(sinkRequests).toBe(0)
  expect((await McpAuth.getForUrl(name, url))?.tokens?.refreshToken).toBe("never-forward")

  source.stop(true)
  sink.stop(true)
  await McpAuth.remove(name)
})

test("provider-controlled refresh errors never enter OpenScience logs", async () => {
  const name = "refresh-log-redaction"
  const marker = `provider-private-${crypto.randomUUID()}`
  const server = serve(() =>
    Response.json(
      {
        error: "invalid_grant",
        error_description: marker,
      },
      { status: 400 },
    ),
  )
  const url = `http://127.0.0.1:${server.port}`
  await McpAuth.set(
    name,
    {
      tokens: { accessToken: "stale-access", refreshToken: "stale-refresh", expiresAt: Date.now() / 1000 - 60 },
      credentialAuthorityFingerprint: authorityFingerprint,
    },
    url,
  )

  try {
    await Log.flush()
    const before = await Bun.file(Log.file()).text()
    const tokens = await provider(name, url).tokens()
    await Log.flush()
    const appended = (await Bun.file(Log.file()).text()).slice(before.length)

    expect(tokens?.access_token).toBe("stale-access")
    expect(appended).toContain("token refresh failed; re-authentication may be required")
    expect(appended).not.toContain(marker)
  } finally {
    server.stop(true)
    await McpAuth.remove(name)
  }
})

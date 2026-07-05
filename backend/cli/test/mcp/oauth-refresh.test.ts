import { test, expect, beforeEach } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Global } from "../../src/global"
import { McpAuth } from "../../src/mcp/auth"
import { McpOAuthProvider } from "../../src/mcp/oauth-provider"

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
  return new McpOAuthProvider(name, url, { clientId: "client-1" }, { onRedirect: async () => {} })
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
    { tokens: { accessToken: "stale-access", refreshToken: "rotate-1", expiresAt: Date.now() / 1000 - 60 } },
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
    { tokens: { accessToken: "stale-access", refreshToken: "revoked-1", expiresAt: Date.now() / 1000 - 60 } },
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
    { tokens: { accessToken: "stale-access", refreshToken: "revoked-1", expiresAt: Date.now() / 1000 - 60 } },
    url,
  )

  const tokens = await provider(name, url).tokens()
  expect(attempts).toEqual(["revoked-1"])
  expect(tokens?.access_token).toBe("winner-access")

  server.stop(true)
  await McpAuth.remove(name)
})

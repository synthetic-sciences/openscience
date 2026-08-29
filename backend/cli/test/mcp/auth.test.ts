import { test, expect, beforeEach, afterAll } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Global } from "../../src/global"
import { McpAuth } from "../../src/mcp/auth"
import { JsonStore } from "../../src/util/jsonstore"

const filepath = path.join(Global.Path.data, "mcp-auth.json")

// Decoded authority fingerprints enter the process-wide secret redaction set.
// Use fixture-specific digests instead of common repeated-hex placeholders so
// this suite cannot redact unrelated integrity hashes in later test files.
const authorityFingerprint = (label: string) =>
  new Bun.CryptoHasher("sha256").update(`mcp-auth-test:${label}`).digest("hex")
const oauthAuthority = authorityFingerprint("oauth-authority")
const completedAuthority = authorityFingerprint("completed-authority")
const credentialAuthority = authorityFingerprint("credential-authority")

async function clean() {
  await fs.mkdir(Global.Path.data, { recursive: true })
  const entries = await fs.readdir(Global.Path.data)
  await Promise.all(
    entries
      .filter((name) => name.startsWith("mcp-auth.json"))
      .map((name) => fs.rm(path.join(Global.Path.data, name), { force: true })),
  )
}

beforeEach(clean)
afterAll(clean)

test("concurrent updates keep every server entry", async () => {
  await Promise.all([
    McpAuth.updateTokens("server-a", { accessToken: "token-a" }, "https://a.example"),
    McpAuth.updateTokens("server-b", { accessToken: "token-b" }, "https://b.example"),
    McpAuth.updateClientInfo("server-c", { clientId: "client-c" }, "https://c.example"),
  ])
  const all = await McpAuth.all()
  expect(Object.keys(all).sort()).toEqual(["server-a", "server-b", "server-c"])
  expect(all["server-a"].tokens?.accessToken).toBe("token-a")
  expect(all["server-c"].clientInfo?.clientId).toBe("client-c")
})

test("an auth write merges a data-root import that wins the file lease first", async () => {
  let entered!: () => void
  let release!: () => void
  const inside = new Promise<void>((resolve) => (entered = resolve))
  const gate = new Promise<void>((resolve) => (release = resolve))
  const importing = JsonStore.update(filepath, async (data) => {
    entered()
    await gate
    data.imported = { tokens: { accessToken: "imported-token" }, serverUrl: "https://imported.example" }
  })
  await inside

  const writing = McpAuth.updateTokens("current", { accessToken: "current-token" }, "https://current.example")
  release()
  await Promise.all([importing, writing])

  const all = await McpAuth.all()
  expect(all.imported?.tokens?.accessToken).toBe("imported-token")
  expect(all.current?.tokens?.accessToken).toBe("current-token")
})

test("seals OAuth tokens, client secrets, PKCE state, and callback codes at rest", async () => {
  await McpAuth.set(
    "sealed",
    {
      tokens: { accessToken: "access-real", refreshToken: "refresh-real", expiresAt: 123 },
      clientInfo: { clientId: "public-client", clientSecret: "client-secret-real" },
      codeVerifier: "pkce-real",
      oauthState: "state-real",
      oauthStartedAt: Date.now(),
      oauthAuthorizationUrl: "https://id.example/authorize?state=state-real",
      oauthServerUrl: "https://mcp.example/",
      oauthAuthorityFingerprint: oauthAuthority,
      oauthCallback: { type: "code", value: "authorization-code-real" },
      oauthCompletedState: "completed-state-real",
      oauthCompletedAt: Date.now(),
      oauthCompletedAuthorityFingerprint: completedAuthority,
      credentialAuthorityFingerprint: credentialAuthority,
    },
    "https://mcp.example",
  )

  const disk = await Bun.file(filepath).text()
  expect(disk).toContain("openscience-secret:v1:")
  for (const secret of [
    "access-real",
    "refresh-real",
    "client-secret-real",
    "pkce-real",
    "state-real",
    "https://id.example/authorize?state=state-real",
    "authorization-code-real",
    oauthAuthority,
    "completed-state-real",
    completedAuthority,
  ]) {
    expect(disk).not.toContain(secret)
  }
  expect(await McpAuth.get("sealed")).toMatchObject({
    tokens: { accessToken: "access-real", refreshToken: "refresh-real" },
    clientInfo: { clientId: "public-client", clientSecret: "client-secret-real" },
    codeVerifier: "pkce-real",
    oauthState: "state-real",
    oauthAuthorizationUrl: "https://id.example/authorize?state=state-real",
    oauthCallback: { type: "code", value: "authorization-code-real" },
    oauthAuthorityFingerprint: oauthAuthority,
    oauthCompletedState: "completed-state-real",
    oauthCompletedAuthorityFingerprint: completedAuthority,
    credentialAuthorityFingerprint: credentialAuthority,
  })
})

test("OAuth token settlement is exact, durable, and cancellation-aware", async () => {
  const name = "settlement"
  const state = "state-settlement"
  const url = "https://mcp.example/"
  const fingerprint = credentialAuthority
  await McpAuth.updateOAuthState(name, state, {
    serverUrl: url,
    authorityFingerprint: fingerprint,
    allowDisabled: true,
  })
  await McpAuth.recordOAuthCallback(state, { type: "code", value: "code-settlement" })
  expect(await McpAuth.claimOAuthSettlement(name, state, "code-settlement")).toBeTrue()
  expect(
    await McpAuth.updateTokensIfOAuthFlow(name, state, url, fingerprint, { accessToken: "settled-access" }),
  ).toBeTrue()
  expect(await McpAuth.pendingOAuthFlow(name)).toBeUndefined()
  expect(await McpAuth.completedOAuthFlow(name, state, url, fingerprint)).toBeTrue()

  const cancelled = "cancelled"
  await McpAuth.updateOAuthState(cancelled, "cancel-state", {
    serverUrl: url,
    authorityFingerprint: fingerprint,
    allowDisabled: false,
  })
  await McpAuth.cancelOAuthFlow(cancelled, "cancel-state")
  expect(
    await McpAuth.updateTokensIfOAuthFlow(cancelled, "cancel-state", url, fingerprint, {
      accessToken: "must-not-land",
    }),
  ).toBeFalse()
  expect((await McpAuth.get(cancelled))?.tokens).toBeUndefined()
})

test("OAuth authority rebinding never carries URL-only or cross-tenant credentials forward", async () => {
  const name = `rebind-${crypto.randomUUID()}`
  const state = `state-${crypto.randomUUID()}`
  const nextFingerprint = "e".repeat(64)
  await McpAuth.set(
    name,
    {
      tokens: { accessToken: "old-access", refreshToken: "old-refresh" },
      clientInfo: { clientId: "old-client", clientSecret: "old-secret" },
    },
    "https://same.example/mcp",
  )
  await McpAuth.updateOAuthState(name, state, {
    serverUrl: "https://same.example/mcp",
    authorityFingerprint: nextFingerprint,
    allowDisabled: false,
  })
  const applied = await McpAuth.updateClientInfoIfOAuthFlow(name, state, "https://same.example/mcp", nextFingerprint, {
    clientId: "new-client",
  })
  expect(applied).toBeTrue()

  const rebound = await McpAuth.get(name)
  expect(rebound?.tokens).toBeUndefined()
  expect(rebound?.clientInfo).toEqual({ clientId: "new-client" })
  expect(rebound?.credentialAuthorityFingerprint).toBe(nextFingerprint)
})

test("treats config-shaped and ciphertext-prefixed provider tokens as literal secret authority", async () => {
  const values = ["{env:DO_NOT_EXPAND}", "{file:/do/not/read}", "••••••••", "openscience-secret:v1:not-ciphertext"]
  for (const [index, value] of values.entries()) {
    await McpAuth.updateTokens(`literal-${index}`, { accessToken: value })
  }

  const disk = await Bun.file(filepath).text()
  for (const value of values) expect(disk).not.toContain(value)
  for (const [index, value] of values.entries()) {
    expect((await McpAuth.get(`literal-${index}`))?.tokens?.accessToken).toBe(value)
  }
})

test("migrates a verified plaintext store only after an encrypted round trip", async () => {
  const legacy = {
    old: {
      tokens: { accessToken: "legacy-access", refreshToken: "legacy-refresh" },
      clientInfo: { clientId: "legacy-client", clientSecret: "legacy-secret" },
      serverUrl: "https://legacy.example",
    },
  }
  await fs.writeFile(filepath, JSON.stringify(legacy), { mode: 0o600 })

  expect(await McpAuth.all()).toEqual(legacy)
  const migrated = await Bun.file(filepath).text()
  expect(migrated).not.toContain("legacy-access")
  expect(migrated).not.toContain("legacy-refresh")
  expect(migrated).not.toContain("legacy-secret")
  expect(migrated).toContain("openscience-secret:v1:")
})

test("does not trust a version marker when its secret fields are still plaintext", async () => {
  await fs.writeFile(
    filepath,
    JSON.stringify({ marked: { storageVersion: 1, tokens: { accessToken: "marked-plaintext" } } }),
    { mode: 0o600 },
  )

  expect((await McpAuth.get("marked"))?.tokens?.accessToken).toBe("marked-plaintext")
  const disk = await Bun.file(filepath).text()
  expect(disk).not.toContain("marked-plaintext")
  expect(disk).toContain("openscience-secret:v1:")
})

test("migrates a partially sealed versioned entry without double-encrypting its sealed fields", async () => {
  await McpAuth.updateTokens("seed", { accessToken: "already-sealed" })
  const seeded = JSON.parse(await Bun.file(filepath).text()) as Record<string, unknown>
  await fs.writeFile(
    filepath,
    JSON.stringify({
      mixed: {
        ...(seeded.seed as object),
        tokens: {
          ...((seeded.seed as { tokens: object }).tokens ?? {}),
          refreshToken: "plaintext-refresh",
        },
      },
    }),
    { mode: 0o600 },
  )

  expect((await McpAuth.get("mixed"))?.tokens).toMatchObject({
    accessToken: "already-sealed",
    refreshToken: "plaintext-refresh",
  })
  const migrated = await Bun.file(filepath).text()
  expect(migrated).not.toContain("already-sealed")
  expect(migrated).not.toContain("plaintext-refresh")
})

test("leaves mixed plaintext untouched when an existing encrypted entry cannot be verified", async () => {
  const original = JSON.stringify({
    broken: { storageVersion: 1, tokens: { accessToken: "openscience-secret:v1:not-valid-gcm" } },
    legacy: { tokens: { accessToken: "do-not-delete" } },
  })
  await fs.writeFile(filepath, original, { mode: 0o600 })

  await expect(McpAuth.all()).rejects.toThrow()
  expect(await Bun.file(filepath).text()).toBe(original)
  await expect(McpAuth.updateTokens("new", { accessToken: "new-token" })).rejects.toThrow(/Refusing to overwrite/)
  expect(await Bun.file(filepath).text()).toBe(original)
})

test("rejects unsupported versioned authority instead of treating it as legacy plaintext", async () => {
  const original = JSON.stringify({ future: { storageVersion: 2, tokens: { accessToken: "future-token" } } })
  await fs.writeFile(filepath, original, { mode: 0o600 })

  await expect(McpAuth.all()).rejects.toThrow(/Unsupported or malformed MCP auth storage version/)
  await expect(McpAuth.updateTokens("new", { accessToken: "must-not-land" })).rejects.toThrow(
    /Unsupported or malformed MCP auth storage version/,
  )
  expect(await fs.readFile(filepath, "utf8")).toBe(original)
})

test("updateTokens does not drop the rest of an entry", async () => {
  await McpAuth.updateClientInfo("server-a", { clientId: "client-a" }, "https://a.example")
  await McpAuth.updateTokens("server-a", { accessToken: "token-a" })
  const entry = await McpAuth.get("server-a")
  expect(entry?.clientInfo?.clientId).toBe("client-a")
  expect(entry?.tokens?.accessToken).toBe("token-a")
  expect(entry?.serverUrl).toBe("https://a.example/")
})

test("set on a corrupt mcp-auth.json throws and leaves a backup", async () => {
  const corrupt = "{ definitely not json"
  await fs.writeFile(filepath, corrupt)

  await expect(McpAuth.set("server-a", { tokens: { accessToken: "token-a" } })).rejects.toThrow(/backed up/)
  expect(await Bun.file(filepath).text()).toBe(corrupt)
  expect(await Bun.file(`${filepath}.corrupt-${process.pid}`).text()).toBe(corrupt)

  // Reads fail closed as well; a corrupt encrypted authority store must never
  // look like a harmless signed-out state.
  await expect(McpAuth.all()).rejects.toThrow()
})

test("empty or whitespace auth stores are treated as truncated and never overwritten", async () => {
  for (const contents of ["", "  \n\t"]) {
    await fs.writeFile(filepath, contents, { mode: 0o600 })
    await expect(McpAuth.updateTokens("new", { accessToken: "must-not-land" })).rejects.toThrow(/Refusing to overwrite/)
    expect(await fs.readFile(filepath, "utf8")).toBe(contents)
    await clean()
  }
})

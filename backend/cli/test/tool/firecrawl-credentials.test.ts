import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "../../src/global"
import { OpenScience } from "../../src/openscience"
import { WorkspaceCredentials } from "../../src/openscience/workspace-credentials"
import { resolveCredentialFields } from "../../src/server/routes/settings/credentials"
import { ResearchSearchTool } from "../../src/tool/research-search"
import { SecretBox } from "../../src/util/secret-box"

// test/preload.ts redirects Global.Path.data and all API traffic to an isolated
// test directory / loopback. These fixtures never touch a user's credentials.
const store = path.join(Global.Path.data, "credentials.json")
afterEach(async () => {
  await Bun.write(store, "{}")
  await Bun.write(WorkspaceCredentials.filepath, "{}")
  await OpenScience.clearSession()
})

test("a missing Firecrawl credential remains distinct from an unreadable saved key", async () => {
  await Bun.write(store, "{}")
  expect(await resolveCredentialFields("firecrawl", { required: ["api_key"] })).toBeUndefined()
  await Bun.write(
    store,
    JSON.stringify({ firecrawl: { fields: { api_key: "invalid-ciphertext" }, updated_at: new Date().toISOString() } }),
  )
  expect(await resolveCredentialFields("firecrawl")).toBeUndefined()
  await expect(resolveCredentialFields("firecrawl", { required: ["api_key"] })).rejects.toThrow(
    "no other funding source was used",
  )
})

test("a malformed local credential store cannot be mistaken for no BYOK key", async () => {
  for (const contents of ["{broken-json", "null", "[]", '{"firecrawl":{"fields":42}}']) {
    await Bun.write(store, contents)
    await expect(resolveCredentialFields("firecrawl", { required: ["api_key"] })).rejects.toThrow("could not be read")
  }
})

test("the tool stops before funding lookup when a connected key is unreadable", async () => {
  await Bun.write(
    store,
    JSON.stringify({ firecrawl: { fields: { api_key: "invalid-ciphertext" }, updated_at: new Date().toISOString() } }),
  )
  const tool = await ResearchSearchTool.init()
  const result = await tool.execute(
    { query: "protein research", source: "web", mode: "balanced", content: "snippets", limit: 8 },
    {
      sessionID: "ses_credential_test",
      messageID: "msg_credential_test",
      callID: "call_credential_test",
      agent: "research",
      abort: new AbortController().signal,
      messages: [],
      metadata() {},
      async ask() {},
    },
  )
  expect(result.metadata.creditState).toBe("unavailable")
  expect(JSON.parse(result.output)).toMatchObject({ type: "search_unavailable", retryable: false })
  expect(result.output).toContain("no other funding source was used")
  expect(result.output).not.toContain("invalid-ciphertext")
})

async function workspace() {
  const session = {
    api_key: "osk_fixture_workspace_a",
    user_id: "user_a",
    organization_id: "org_a",
    workspace_locked: true,
  }
  await OpenScience.saveSession(session)
  await WorkspaceCredentials.write(session, {
    organization_id: "org_a",
    auth: {},
    services: { firecrawl: { api_key: "fc-workspace-fixture" } },
  })
  return Bun.file(WorkspaceCredentials.filepath).json()
}

test("a damaged current workspace credential cannot silently fall back to Wallet", async () => {
  const envelope = await workspace()
  expect(await resolveCredentialFields("firecrawl", { required: ["api_key"] })).toEqual({
    api_key: "fc-workspace-fixture",
  })
  await Bun.write(WorkspaceCredentials.filepath, JSON.stringify({ ...envelope, payload: "corrupt-ciphertext" }))
  expect(await WorkspaceCredentials.read()).toBeUndefined()
  await expect(resolveCredentialFields("firecrawl", { required: ["api_key"] })).rejects.toThrow(
    "Saved workspace credentials could not be read",
  )
  const tool = await ResearchSearchTool.init()
  const result = await tool.execute(
    { query: "protein research", source: "web", mode: "balanced", content: "snippets", limit: 8 },
    {
      sessionID: "ses_workspace_credential_test",
      messageID: "msg_workspace_credential_test",
      callID: "call_workspace_credential_test",
      agent: "research",
      abort: new AbortController().signal,
      messages: [],
      metadata() {},
      async ask() {},
    },
  )
  expect(result.metadata.creditState).toBe("unavailable")
  expect(result.output).toContain("Saved workspace credentials could not be read")
  expect(result.output).not.toContain("corrupt-ciphertext")
})

test("strict workspace reads reject malformed active envelopes and decrypted schemas", async () => {
  const envelope = await workspace()
  const key = Buffer.from(await Bun.file(path.join(Global.Path.data, "credentials.key")).arrayBuffer())
  for (const contents of [
    "{broken-json",
    "null",
    "[]",
    JSON.stringify({ unexpected: true }),
    JSON.stringify({ ...envelope, expires_at: "tomorrow" }),
    JSON.stringify({ ...envelope, identity: null }),
    JSON.stringify({ ...envelope, payload: "" }),
    JSON.stringify({ ...envelope, payload: SecretBox.seal(key, JSON.stringify({ organization_id: "org_a" })) }),
  ]) {
    await Bun.write(WorkspaceCredentials.filepath, contents)
    expect(await WorkspaceCredentials.read()).toBeUndefined()
    await expect(WorkspaceCredentials.read({ strict: true })).rejects.toThrow(
      "Saved workspace credentials could not be read",
    )
  }
  // Restore a parseable store so normal session cleanup can clear it safely.
  await Bun.write(WorkspaceCredentials.filepath, JSON.stringify(envelope))
})

test("an unreadable workspace decryption key fails closed only for strict callers", async () => {
  await workspace()
  const filepath = path.join(Global.Path.data, "credentials.key")
  const key = await Bun.file(filepath).arrayBuffer()
  try {
    await Bun.write(filepath, "bad-key")
    expect(await WorkspaceCredentials.read()).toBeUndefined()
    await expect(WorkspaceCredentials.read({ strict: true })).rejects.toThrow(
      "Saved workspace credentials could not be read",
    )
  } finally {
    await Bun.write(filepath, key)
  }
})

test("an unreadable workspace store is not confused with a missing store", async () => {
  await workspace()
  const backup = `${WorkspaceCredentials.filepath}.fixture-backup`
  await fs.rename(WorkspaceCredentials.filepath, backup)
  try {
    await fs.mkdir(WorkspaceCredentials.filepath)
    expect(await WorkspaceCredentials.read()).toBeUndefined()
    await expect(WorkspaceCredentials.read({ strict: true })).rejects.toThrow(
      "Saved workspace credentials could not be read",
    )
  } finally {
    await fs.rmdir(WorkspaceCredentials.filepath)
    await fs.rename(backup, WorkspaceCredentials.filepath)
  }
})

test("cleared, expired and other-account workspace grants remain absent rather than funding errors", async () => {
  const envelope = await workspace()
  for (const value of [
    {},
    { ...envelope, expires_at: Date.now() - 1, payload: "expired-ciphertext" },
    { ...envelope, identity: "b".repeat(64), payload: "" },
  ]) {
    await Bun.write(WorkspaceCredentials.filepath, JSON.stringify(value))
    expect(await WorkspaceCredentials.read({ strict: true })).toBeUndefined()
    expect(await resolveCredentialFields("firecrawl", { required: ["api_key"] })).toBeUndefined()
  }
})

test("a valid local Firecrawl credential does not depend on a corrupt unrelated workspace overlay", async () => {
  const envelope = await workspace()
  const key = Buffer.from(await Bun.file(path.join(Global.Path.data, "credentials.key")).arrayBuffer())
  await Bun.write(
    store,
    JSON.stringify({
      firecrawl: { fields: { api_key: SecretBox.seal(key, "fc-local-fixture") }, updated_at: new Date().toISOString() },
    }),
  )
  try {
    await Bun.write(WorkspaceCredentials.filepath, "{broken-json")
    expect(await resolveCredentialFields("firecrawl", { required: ["api_key"] })).toEqual({
      api_key: "fc-local-fixture",
    })
  } finally {
    await Bun.write(WorkspaceCredentials.filepath, JSON.stringify(envelope))
  }
})

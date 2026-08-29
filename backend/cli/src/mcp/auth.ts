import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { CredentialLifecycle } from "../credentials/lifecycle"
import { Global } from "../global"
import { JsonStore } from "../util/jsonstore"
import { McpSecretStorage } from "./secret-storage"
import { OpenScience } from "../openscience"

export namespace McpAuth {
  export const Tokens = z.object({
    accessToken: z.string(),
    refreshToken: z.string().optional(),
    expiresAt: z.number().optional(),
    scope: z.string().optional(),
  })
  export type Tokens = z.infer<typeof Tokens>

  export const ClientInfo = z.object({
    clientId: z.string(),
    clientSecret: z.string().optional(),
    clientIdIssuedAt: z.number().optional(),
    clientSecretExpiresAt: z.number().optional(),
  })
  export type ClientInfo = z.infer<typeof ClientInfo>

  export const OAuthCallback = z.discriminatedUnion("type", [
    z.object({ type: z.literal("code"), value: z.string() }),
    z.object({ type: z.literal("error"), value: z.string() }),
    z.object({ type: z.literal("cancelled") }),
  ])
  export type OAuthCallback = z.infer<typeof OAuthCallback>

  export const Entry = z.object({
    tokens: Tokens.optional(),
    clientInfo: ClientInfo.optional(),
    codeVerifier: z.string().optional(),
    oauthState: z.string().optional(),
    oauthStartedAt: z.number().optional(),
    oauthAuthorizationUrl: z.string().url().optional(),
    oauthServerUrl: z.string().url().optional(),
    oauthAuthorityFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    oauthAllowDisabled: z.boolean().optional(),
    oauthSettling: z.boolean().optional(),
    oauthCompletedState: z.string().optional(),
    oauthCompletedAt: z.number().optional(),
    oauthCompletedFinalized: z.boolean().optional(),
    oauthCompletedAuthorityFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    oauthCallback: OAuthCallback.optional(),
    serverUrl: z.string().optional(),
    credentialAuthorityFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
  })
  export type Entry = z.infer<typeof Entry>

  const StoredEntry = z.object({
    storageVersion: z.literal(1),
    tokens: z
      .object({
        accessToken: z.string(),
        refreshToken: z.string().optional(),
        expiresAt: z.number().optional(),
        scope: z.string().optional(),
      })
      .optional(),
    clientInfo: z
      .object({
        clientId: z.string(),
        clientSecret: z.string().optional(),
        clientIdIssuedAt: z.number().optional(),
        clientSecretExpiresAt: z.number().optional(),
      })
      .optional(),
    codeVerifier: z.string().optional(),
    oauthState: z.string().optional(),
    oauthStartedAt: z.number().optional(),
    oauthAuthorizationUrl: z.string().optional(),
    oauthServerUrl: z.string().optional(),
    oauthAuthorityFingerprint: z.string().optional(),
    oauthAllowDisabled: z.boolean().optional(),
    oauthSettling: z.boolean().optional(),
    oauthCompletedState: z.string().optional(),
    oauthCompletedAt: z.number().optional(),
    oauthCompletedFinalized: z.boolean().optional(),
    oauthCompletedAuthorityFingerprint: z.string().optional(),
    oauthCallback: z
      .discriminatedUnion("type", [
        z.object({ type: z.literal("code"), value: z.string() }),
        z.object({ type: z.literal("error"), value: z.string() }),
        z.object({ type: z.literal("cancelled") }),
      ])
      .optional(),
    serverUrl: z.string().optional(),
    credentialAuthorityFingerprint: z.string().optional(),
  })
  type StoredEntry = z.infer<typeof StoredEntry>

  const filepath = path.join(Global.Path.data, "mcp-auth.json")
  const FLOW_TTL_MS = 10 * 60 * 1000

  function normalizeServerUrl(value: string): string {
    return new URL(value).toString()
  }

  function durableShape(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(durableShape)
    if (!value || typeof value !== "object") return value
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, durableShape(item)]),
    )
  }

  function durableEqual(left: unknown, right: unknown): boolean {
    return JSON.stringify(durableShape(left)) === JSON.stringify(durableShape(right))
  }

  function activeFlow(entry: Entry, state: string): boolean {
    if (entry.oauthState !== state || entry.oauthStartedAt === undefined) return false
    const age = Date.now() - entry.oauthStartedAt
    return age >= 0 && age <= FLOW_TTL_MS
  }

  function fullySealed(entry: StoredEntry): boolean {
    const values = [
      entry.tokens?.accessToken,
      entry.tokens?.refreshToken,
      entry.clientInfo?.clientSecret,
      entry.codeVerifier,
      entry.oauthState,
      entry.oauthAuthorizationUrl,
      entry.oauthAuthorityFingerprint,
      entry.oauthCompletedState,
      entry.oauthCompletedAuthorityFingerprint,
      entry.credentialAuthorityFingerprint,
      entry.oauthCallback?.type === "code" || entry.oauthCallback?.type === "error"
        ? entry.oauthCallback.value
        : undefined,
    ].filter((value): value is string => value !== undefined)
    return values.every(McpSecretStorage.sealed)
  }

  async function encode(entry: Entry): Promise<StoredEntry> {
    return StoredEntry.parse({
      storageVersion: 1,
      tokens: entry.tokens
        ? {
            ...entry.tokens,
            accessToken: await McpSecretStorage.sealAuthority(entry.tokens.accessToken),
            refreshToken: entry.tokens.refreshToken
              ? await McpSecretStorage.sealAuthority(entry.tokens.refreshToken)
              : undefined,
          }
        : undefined,
      clientInfo: entry.clientInfo
        ? {
            ...entry.clientInfo,
            clientSecret: entry.clientInfo.clientSecret
              ? await McpSecretStorage.sealAuthority(entry.clientInfo.clientSecret)
              : undefined,
          }
        : undefined,
      codeVerifier: entry.codeVerifier ? await McpSecretStorage.sealAuthority(entry.codeVerifier) : undefined,
      oauthState: entry.oauthState ? await McpSecretStorage.sealAuthority(entry.oauthState) : undefined,
      oauthStartedAt: entry.oauthStartedAt,
      oauthAuthorizationUrl: entry.oauthAuthorizationUrl
        ? await McpSecretStorage.sealAuthority(entry.oauthAuthorizationUrl)
        : undefined,
      oauthServerUrl: entry.oauthServerUrl,
      oauthAuthorityFingerprint: entry.oauthAuthorityFingerprint
        ? await McpSecretStorage.sealAuthority(entry.oauthAuthorityFingerprint)
        : undefined,
      oauthAllowDisabled: entry.oauthAllowDisabled,
      oauthSettling: entry.oauthSettling,
      oauthCompletedState: entry.oauthCompletedState
        ? await McpSecretStorage.sealAuthority(entry.oauthCompletedState)
        : undefined,
      oauthCompletedAt: entry.oauthCompletedAt,
      oauthCompletedFinalized: entry.oauthCompletedFinalized,
      oauthCompletedAuthorityFingerprint: entry.oauthCompletedAuthorityFingerprint
        ? await McpSecretStorage.sealAuthority(entry.oauthCompletedAuthorityFingerprint)
        : undefined,
      oauthCallback:
        entry.oauthCallback?.type === "code" || entry.oauthCallback?.type === "error"
          ? { ...entry.oauthCallback, value: await McpSecretStorage.sealAuthority(entry.oauthCallback.value) }
          : entry.oauthCallback,
      serverUrl: entry.serverUrl,
      credentialAuthorityFingerprint: entry.credentialAuthorityFingerprint
        ? await McpSecretStorage.sealAuthority(entry.credentialAuthorityFingerprint)
        : undefined,
    })
  }

  async function decode(entry: StoredEntry): Promise<Entry> {
    const decoded = Entry.parse({
      tokens: entry.tokens
        ? {
            ...entry.tokens,
            accessToken: await McpSecretStorage.open(entry.tokens.accessToken),
            refreshToken: entry.tokens.refreshToken
              ? await McpSecretStorage.open(entry.tokens.refreshToken)
              : undefined,
          }
        : undefined,
      clientInfo: entry.clientInfo
        ? {
            ...entry.clientInfo,
            clientSecret: entry.clientInfo.clientSecret
              ? await McpSecretStorage.open(entry.clientInfo.clientSecret)
              : undefined,
          }
        : undefined,
      codeVerifier: entry.codeVerifier ? await McpSecretStorage.open(entry.codeVerifier) : undefined,
      oauthState: entry.oauthState ? await McpSecretStorage.open(entry.oauthState) : undefined,
      oauthStartedAt: entry.oauthStartedAt,
      oauthAuthorizationUrl: entry.oauthAuthorizationUrl
        ? await McpSecretStorage.open(entry.oauthAuthorizationUrl)
        : undefined,
      oauthServerUrl: entry.oauthServerUrl,
      oauthAuthorityFingerprint: entry.oauthAuthorityFingerprint
        ? await McpSecretStorage.open(entry.oauthAuthorityFingerprint)
        : undefined,
      oauthAllowDisabled: entry.oauthAllowDisabled,
      oauthSettling: entry.oauthSettling,
      oauthCompletedState: entry.oauthCompletedState
        ? await McpSecretStorage.open(entry.oauthCompletedState)
        : undefined,
      oauthCompletedAt: entry.oauthCompletedAt,
      oauthCompletedFinalized: entry.oauthCompletedFinalized,
      oauthCompletedAuthorityFingerprint: entry.oauthCompletedAuthorityFingerprint
        ? await McpSecretStorage.open(entry.oauthCompletedAuthorityFingerprint)
        : undefined,
      oauthCallback:
        entry.oauthCallback?.type === "code" || entry.oauthCallback?.type === "error"
          ? { ...entry.oauthCallback, value: await McpSecretStorage.open(entry.oauthCallback.value) }
          : entry.oauthCallback,
      serverUrl: entry.serverUrl,
      credentialAuthorityFingerprint: entry.credentialAuthorityFingerprint
        ? await McpSecretStorage.open(entry.credentialAuthorityFingerprint)
        : undefined,
    })
    OpenScience.registerSecretValues(
      [
        decoded.tokens?.accessToken,
        decoded.tokens?.refreshToken,
        decoded.clientInfo?.clientSecret,
        decoded.codeVerifier,
        decoded.oauthState,
        decoded.oauthAuthorizationUrl,
        decoded.oauthAuthorityFingerprint,
        decoded.oauthCompletedState,
        decoded.oauthCompletedAuthorityFingerprint,
        decoded.credentialAuthorityFingerprint,
        decoded.oauthCallback?.type === "code" || decoded.oauthCallback?.type === "error"
          ? decoded.oauthCallback.value
          : undefined,
      ].filter((value): value is string => !!value),
    )
    return decoded
  }

  async function encodeStore(store: Record<string, Entry>): Promise<Record<string, StoredEntry>> {
    return Object.fromEntries(
      await Promise.all(Object.entries(store).map(async ([name, entry]) => [name, await encode(entry)])),
    )
  }

  async function decodeStore(store: Record<string, StoredEntry>): Promise<Record<string, Entry>> {
    return Object.fromEntries(
      await Promise.all(Object.entries(store).map(async ([name, entry]) => [name, await decode(entry)])),
    )
  }

  async function raw(): Promise<Record<string, unknown>> {
    const file = Bun.file(filepath)
    if (!(await file.exists())) return {}
    const text = await file.text()
    if (!text.trim()) throw new Error("MCP auth store is empty or truncated")
    const value: unknown = JSON.parse(text)
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("MCP auth store is not an object")
    return value as Record<string, unknown>
  }

  async function decodeMixed(
    data: Record<string, unknown>,
  ): Promise<{ entries: Record<string, Entry>; migration: boolean }> {
    const entries: Record<string, Entry> = {}
    let migration = false
    for (const [name, value] of Object.entries(data)) {
      const stored = StoredEntry.safeParse(value)
      if (stored.success) {
        entries[name] = await decode(stored.data)
        if (!fullySealed(stored.data)) migration = true
        continue
      }
      if (value && typeof value === "object" && !Array.isArray(value) && "storageVersion" in value) {
        throw new Error(`Unsupported or malformed MCP auth storage version for ${name}`)
      }
      entries[name] = Entry.parse(value)
      migration = true
    }
    return { entries, migration }
  }

  async function mixed(): Promise<{ entries: Record<string, Entry>; migration: boolean }> {
    return decodeMixed(await raw())
  }

  async function backupCorrupt(error: unknown): Promise<never> {
    const backup = `${filepath}.corrupt-${process.pid}`
    await fs.copyFile(filepath, backup).catch(() => undefined)
    await fs.chmod(backup, 0o600).catch(() => undefined)
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(
      `${filepath} could not be verified (${reason}). Refusing to overwrite it; the original was copied to ${backup}.`,
    )
  }

  async function migrateUnlocked(): Promise<Record<string, Entry>> {
    let entries: Record<string, Entry> = {}
    await JsonStore.update(filepath, async (data) => {
      const current = await decodeMixed(data).catch(backupCorrupt)
      entries = current.entries
      if (!current.migration) return data
      const stored = await encodeStore(entries)
      const verified = await decodeMixed(stored)
      if (verified.migration || !durableEqual(verified.entries, entries)) {
        throw new Error("Encrypted MCP auth candidate did not round-trip exactly")
      }
      return stored
    })
    return entries
  }

  async function ensureMigrated(): Promise<void> {
    const current = await mixed()
    if (!current.migration) return
    await CredentialLifecycle.mutate("mcp-auth.migrate", migrateUnlocked, { reconcileLocal: false })
  }

  async function update(
    reason: string,
    fn: (store: Record<string, Entry>) => void | Promise<void>,
    options: {
      authority?: boolean
      reconcileLocal?: boolean
      condition?: (store: Record<string, Entry>) => boolean | Promise<boolean>
    } = {},
  ): Promise<boolean> {
    const authority = options.authority ?? true
    const write = async (): Promise<boolean> => {
      let applied = true
      let expected: Record<string, Entry> | undefined
      await JsonStore.update(filepath, async (data) => {
        const current = await decodeMixed(data).catch(backupCorrupt)
        if (!authority && current.migration) {
          throw new Error("MCP auth storage changed during a metadata update; retry after verified migration")
        }
        if (options.condition && !(await options.condition(current.entries))) {
          applied = false
          return data
        }
        await fn(current.entries)
        expected = current.entries
        return encodeStore(current.entries)
      })
      if (!applied) return false
      const verified = await mixed()
      if (!expected || verified.migration || !durableEqual(verified.entries, expected)) {
        throw new Error("MCP auth write did not verify after durable replacement")
      }
      return true
    }
    if (authority) {
      const lifecycle = options.reconcileLocal ? {} : { reconcileLocal: false }
      if (options.condition) {
        const result = await CredentialLifecycle.mutateIf(
          reason,
          async () => options.condition!((await mixed()).entries),
          write,
          lifecycle,
        )
        return result.applied ? result.value : false
      }
      return CredentialLifecycle.mutate(reason, write, lifecycle)
    }
    // Flow bookkeeping must serialize with authority writes but must not
    // publish a credential revision: a callback in another process should not
    // cancel unrelated jobs or dispose the transport exchanging that code.
    await ensureMigrated()
    let applied = true
    await CredentialLifecycle.serialized(async () => {
      applied = await write()
    })
    return applied
  }

  export async function get(mcpName: string): Promise<Entry | undefined> {
    return (await all())[mcpName]
  }

  export async function getForUrl(mcpName: string, serverUrl: string): Promise<Entry | undefined> {
    const entry = await get(mcpName)
    if (!entry?.serverUrl || normalizeServerUrl(entry.serverUrl) !== normalizeServerUrl(serverUrl)) return undefined
    return entry
  }

  export async function getForAuthority(
    mcpName: string,
    serverUrl: string,
    authorityFingerprint: string,
  ): Promise<Entry | undefined> {
    const entry = await getForUrl(mcpName, serverUrl)
    return entry?.credentialAuthorityFingerprint === authorityFingerprint ? entry : undefined
  }

  export async function all(): Promise<Record<string, Entry>> {
    await ensureMigrated()
    return mixed().then((value) => value.entries)
  }

  export async function set(mcpName: string, entry: Entry, serverUrl?: string): Promise<void> {
    const bound = serverUrl ?? entry.serverUrl
    const next = Entry.parse({ ...entry, serverUrl: bound ? normalizeServerUrl(bound) : undefined })
    await update(`mcp-auth.set:${mcpName}`, (store) => {
      store[mcpName] = next
    })
  }

  export async function remove(mcpName: string): Promise<void> {
    await update(
      `mcp-auth.remove:${mcpName}`,
      (store) => {
        delete store[mcpName]
      },
      { reconcileLocal: true },
    )
  }

  async function updateEntry(
    reason: string,
    mcpName: string,
    fn: (entry: Entry) => void,
    serverUrl?: string,
    options: { authority?: boolean } = {},
  ) {
    await update(
      reason,
      (store) => {
        const entry = Entry.parse(store[mcpName] ?? {})
        fn(entry)
        if (serverUrl) entry.serverUrl = normalizeServerUrl(serverUrl)
        store[mcpName] = entry
      },
      options,
    )
  }

  function rebindAuthority(entry: Entry, serverUrl: string, authorityFingerprint: string): void {
    const url = normalizeServerUrl(serverUrl)
    const hasBoundAuthority = !!(entry.tokens || entry.clientInfo || entry.serverUrl)
    if (
      (entry.serverUrl && normalizeServerUrl(entry.serverUrl) !== url) ||
      (hasBoundAuthority && entry.credentialAuthorityFingerprint !== authorityFingerprint)
    ) {
      delete entry.tokens
      delete entry.clientInfo
      delete entry.oauthCompletedState
      delete entry.oauthCompletedAt
      delete entry.oauthCompletedFinalized
      delete entry.oauthCompletedAuthorityFingerprint
    }
    entry.serverUrl = url
    entry.credentialAuthorityFingerprint = authorityFingerprint
  }

  export function updateTokens(mcpName: string, tokens: Tokens, serverUrl?: string): Promise<void> {
    return updateEntry(
      `mcp-auth.tokens:${mcpName}`,
      mcpName,
      (entry) => (entry.tokens = Tokens.parse(tokens)),
      serverUrl,
    )
  }

  function exactOAuthFlow(
    entry: Entry | undefined,
    expectedState: string,
    serverUrl: string,
    authorityFingerprint: string,
    requireSettlement = false,
  ): boolean {
    return !!(
      entry &&
      activeFlow(entry, expectedState) &&
      entry.oauthServerUrl === normalizeServerUrl(serverUrl) &&
      entry.oauthAuthorityFingerprint === authorityFingerprint &&
      entry.oauthCallback?.type !== "cancelled" &&
      entry.oauthCallback?.type !== "error" &&
      (!requireSettlement || (entry.oauthSettling === true && entry.oauthCallback?.type === "code"))
    )
  }

  export function updateTokensIfOAuthFlow(
    mcpName: string,
    expectedState: string,
    serverUrl: string,
    authorityFingerprint: string,
    tokens: Tokens,
  ): Promise<boolean> {
    const next = Tokens.parse(tokens)
    return update(
      `mcp-auth.tokens.flow:${mcpName}`,
      (store) => {
        const entry = Entry.parse(store[mcpName] ?? {})
        rebindAuthority(entry, serverUrl, authorityFingerprint)
        entry.tokens = next
        entry.oauthCompletedState = expectedState
        entry.oauthCompletedAt = Date.now()
        entry.oauthCompletedFinalized = false
        entry.oauthCompletedAuthorityFingerprint = authorityFingerprint
        delete entry.oauthState
        delete entry.oauthStartedAt
        delete entry.oauthAuthorizationUrl
        delete entry.oauthServerUrl
        delete entry.oauthAuthorityFingerprint
        delete entry.oauthAllowDisabled
        delete entry.oauthSettling
        delete entry.oauthCallback
        delete entry.codeVerifier
        store[mcpName] = entry
      },
      { condition: (store) => exactOAuthFlow(store[mcpName], expectedState, serverUrl, authorityFingerprint, true) },
    )
  }

  export async function completedOAuthFlow(
    mcpName: string,
    expectedState: string,
    serverUrl: string,
    authorityFingerprint: string,
  ): Promise<boolean> {
    const entry = await get(mcpName)
    if (
      !entry?.tokens ||
      !entry.serverUrl ||
      normalizeServerUrl(entry.serverUrl) !== normalizeServerUrl(serverUrl) ||
      entry.credentialAuthorityFingerprint !== authorityFingerprint ||
      entry.oauthCompletedState !== expectedState ||
      entry.oauthCompletedAuthorityFingerprint !== authorityFingerprint ||
      entry.oauthCompletedAt === undefined
    ) {
      return false
    }
    const age = Date.now() - entry.oauthCompletedAt
    return age >= 0 && age <= FLOW_TTL_MS
  }

  export async function recentOAuthCompletion(
    mcpName: string,
  ): Promise<{ state: string; finalized: boolean } | undefined> {
    const entry = await get(mcpName)
    if (!entry?.tokens || !entry.oauthCompletedState || entry.oauthCompletedAt === undefined) return undefined
    const age = Date.now() - entry.oauthCompletedAt
    if (age < 0 || age > FLOW_TTL_MS) return undefined
    return { state: entry.oauthCompletedState, finalized: entry.oauthCompletedFinalized === true }
  }

  export function finalizeOAuthCompletion(mcpName: string, expectedState: string): Promise<boolean> {
    return update(
      `mcp-auth.flow.finalize:${mcpName}`,
      (store) => {
        store[mcpName]!.oauthCompletedFinalized = true
      },
      {
        authority: false,
        condition: (store) => store[mcpName]?.oauthCompletedState === expectedState,
      },
    )
  }

  export function claimOAuthSettlement(mcpName: string, expectedState: string, authorizationCode: string) {
    return update(
      `mcp-auth.flow.settle:${mcpName}`,
      (store) => {
        const entry = store[mcpName]!
        entry.oauthSettling = true
      },
      {
        authority: false,
        condition: (store) => {
          const entry = store[mcpName]
          return !!(
            entry &&
            activeFlow(entry, expectedState) &&
            entry.oauthCallback?.type === "code" &&
            entry.oauthCallback.value === authorizationCode
          )
        },
      },
    )
  }

  /** Persist one refresh response only if it still corresponds to the exact
   * rotating refresh token that authorized the request. A late response can
   * never overwrite a newer pair saved by another process. */
  export function updateTokensIfRefreshToken(
    mcpName: string,
    expectedRefreshToken: string,
    tokens: Tokens,
    serverUrl: string,
    authorityFingerprint: string,
  ): Promise<boolean> {
    const next = Tokens.parse(tokens)
    return update(
      `mcp-auth.tokens.refresh:${mcpName}`,
      (store) => {
        const entry = Entry.parse(store[mcpName] ?? {})
        rebindAuthority(entry, serverUrl, authorityFingerprint)
        entry.tokens = next
        store[mcpName] = entry
      },
      {
        condition: (store) => {
          const entry = store[mcpName]
          return (
            !!entry?.serverUrl &&
            normalizeServerUrl(entry.serverUrl) === normalizeServerUrl(serverUrl) &&
            entry.credentialAuthorityFingerprint === authorityFingerprint &&
            entry.tokens?.refreshToken === expectedRefreshToken
          )
        },
      },
    )
  }

  type InvalidationScope = "all" | "client" | "tokens" | "verifier"

  function invalidate(entry: Entry, scope: InvalidationScope): void {
    if (scope === "all" || scope === "client") delete entry.clientInfo
    if (scope === "all" || scope === "tokens") delete entry.tokens
    if (scope === "all" || scope === "verifier") delete entry.codeVerifier
  }

  /** Apply an SDK invalidation only to the exact still-bound browser flow. */
  export function invalidateIfOAuthFlow(
    mcpName: string,
    expectedState: string,
    serverUrl: string,
    authorityFingerprint: string,
    scope: InvalidationScope,
  ): Promise<boolean> {
    return update(`mcp-auth.invalidate.flow:${mcpName}:${scope}`, (store) => invalidate(store[mcpName]!, scope), {
      condition: (store) => exactOAuthFlow(store[mcpName], expectedState, serverUrl, authorityFingerprint),
    })
  }

  /** Passive startup may forget rejected URL-bound credentials, but it cannot
   * create a browser flow or replace authority. */
  export function invalidateForAuthority(
    mcpName: string,
    serverUrl: string,
    authorityFingerprint: string,
    scope: InvalidationScope,
  ): Promise<boolean> {
    return update(`mcp-auth.invalidate.url:${mcpName}:${scope}`, (store) => invalidate(store[mcpName]!, scope), {
      condition: (store) => {
        const entry = store[mcpName]
        return (
          !!entry?.serverUrl &&
          normalizeServerUrl(entry.serverUrl) === normalizeServerUrl(serverUrl) &&
          entry.credentialAuthorityFingerprint === authorityFingerprint
        )
      },
    })
  }

  /** Invalidate only the refresh-token generation that the SDK actually
   * rejected. Another process may already have rotated and persisted a newer
   * pair; an `invalid_grant` for the old token must never delete that winner. */
  export function invalidateTokensIfRefreshToken(
    mcpName: string,
    serverUrl: string,
    authorityFingerprint: string,
    expectedRefreshToken: string,
  ): Promise<boolean> {
    return update(
      `mcp-auth.invalidate.refresh:${mcpName}`,
      (store) => {
        delete store[mcpName]!.tokens
      },
      {
        condition: (store) => {
          const entry = store[mcpName]
          return (
            !!entry?.serverUrl &&
            normalizeServerUrl(entry.serverUrl) === normalizeServerUrl(serverUrl) &&
            entry.credentialAuthorityFingerprint === authorityFingerprint &&
            entry.tokens?.refreshToken === expectedRefreshToken
          )
        },
      },
    )
  }

  export function updateClientInfo(mcpName: string, clientInfo: ClientInfo, serverUrl?: string): Promise<void> {
    return updateEntry(
      `mcp-auth.client:${mcpName}`,
      mcpName,
      (entry) => (entry.clientInfo = ClientInfo.parse(clientInfo)),
      serverUrl,
    )
  }

  export function updateClientInfoIfOAuthFlow(
    mcpName: string,
    expectedState: string,
    serverUrl: string,
    authorityFingerprint: string,
    clientInfo: ClientInfo,
  ): Promise<boolean> {
    const next = ClientInfo.parse(clientInfo)
    return update(
      `mcp-auth.client.flow:${mcpName}`,
      (store) => {
        const entry = Entry.parse(store[mcpName] ?? {})
        rebindAuthority(entry, serverUrl, authorityFingerprint)
        entry.clientInfo = next
        store[mcpName] = entry
      },
      { condition: (store) => exactOAuthFlow(store[mcpName], expectedState, serverUrl, authorityFingerprint) },
    )
  }

  export function updateCodeVerifier(mcpName: string, codeVerifier: string): Promise<void> {
    return updateEntry(
      `mcp-auth.verifier:${mcpName}`,
      mcpName,
      (entry) => (entry.codeVerifier = codeVerifier),
      undefined,
      { authority: false },
    )
  }

  export function updateCodeVerifierIfOAuthFlow(
    mcpName: string,
    expectedState: string,
    serverUrl: string,
    authorityFingerprint: string,
    codeVerifier: string,
  ): Promise<boolean> {
    return update(
      `mcp-auth.verifier.flow:${mcpName}`,
      (store) => {
        store[mcpName]!.codeVerifier = codeVerifier
      },
      {
        authority: false,
        condition: (store) => exactOAuthFlow(store[mcpName], expectedState, serverUrl, authorityFingerprint),
      },
    )
  }

  export async function codeVerifierForOAuthFlow(
    mcpName: string,
    expectedState: string,
    serverUrl: string,
    authorityFingerprint: string,
  ): Promise<string | undefined> {
    const entry = await get(mcpName)
    if (!exactOAuthFlow(entry, expectedState, serverUrl, authorityFingerprint)) return undefined
    return entry?.codeVerifier
  }

  export function clearCodeVerifier(mcpName: string): Promise<void> {
    return updateEntry(`mcp-auth.verifier.clear:${mcpName}`, mcpName, (entry) => delete entry.codeVerifier, undefined, {
      authority: false,
    })
  }

  export function updateOAuthState(
    mcpName: string,
    oauthState: string,
    binding?: { serverUrl: string; authorityFingerprint: string; allowDisabled: boolean },
  ): Promise<void> {
    return updateEntry(
      `mcp-auth.flow:${mcpName}`,
      mcpName,
      (entry) => {
        if (entry.oauthState === oauthState && activeFlow(entry, oauthState)) return
        if (entry.oauthState && activeFlow(entry, entry.oauthState)) {
          throw new Error(`OAuth authorization is already in progress for MCP server: ${mcpName}`)
        }
        entry.oauthState = oauthState
        entry.oauthStartedAt = Date.now()
        entry.oauthServerUrl = binding ? new URL(binding.serverUrl).toString() : undefined
        entry.oauthAuthorityFingerprint = binding?.authorityFingerprint
        entry.oauthAllowDisabled = binding?.allowDisabled
        delete entry.oauthSettling
        delete entry.oauthCompletedState
        delete entry.oauthCompletedAt
        delete entry.oauthCompletedFinalized
        delete entry.oauthCompletedAuthorityFingerprint
        delete entry.oauthAuthorizationUrl
        delete entry.oauthCallback
        delete entry.codeVerifier
      },
      undefined,
      { authority: false },
    )
  }

  export async function getOAuthState(mcpName: string): Promise<string | undefined> {
    return (await get(mcpName))?.oauthState
  }

  export async function findByOAuthState(state: string): Promise<string | undefined> {
    const matches = Object.entries(await all()).filter(([, entry]) => activeFlow(entry, state))
    return matches.length === 1 ? matches[0]![0] : undefined
  }

  export async function pendingOAuthFlow(mcpName: string): Promise<
    | {
        state: string
        authorizationUrl?: string
        callback?: OAuthCallback
        serverUrl?: string
        authorityFingerprint?: string
        allowDisabled?: boolean
      }
    | undefined
  > {
    const entry = await get(mcpName)
    if (!entry?.oauthState || !activeFlow(entry, entry.oauthState)) return undefined
    return {
      state: entry.oauthState,
      authorizationUrl: entry.oauthAuthorizationUrl,
      callback: entry.oauthCallback,
      serverUrl: entry.oauthServerUrl,
      authorityFingerprint: entry.oauthAuthorityFingerprint,
      allowDisabled: entry.oauthAllowDisabled,
    }
  }

  export function updateOAuthAuthorizationUrl(
    mcpName: string,
    expectedState: string,
    authorizationUrl: string,
  ): Promise<void> {
    const parsed = new URL(authorizationUrl).toString()
    return updateEntry(
      `mcp-auth.flow.url:${mcpName}`,
      mcpName,
      (entry) => {
        if (entry.oauthState !== expectedState || !activeFlow(entry, expectedState)) {
          throw new Error("OAuth state changed before its authorization URL could be saved")
        }
        entry.oauthAuthorizationUrl = parsed
      },
      undefined,
      { authority: false },
    )
  }

  export function recordOAuthCallback(state: string, callback: OAuthCallback): Promise<string> {
    const owner = { name: "" }
    return update(
      "mcp-auth.callback",
      (store) => {
        const matches = Object.entries(store).filter(([, entry]) => activeFlow(entry, state))
        if (matches.length !== 1) throw new Error("Invalid or expired OAuth state")
        const [name, entry] = matches[0]!
        if (entry.oauthCallback && JSON.stringify(entry.oauthCallback) !== JSON.stringify(callback)) {
          throw new Error("OAuth state has already been completed")
        }
        entry.oauthCallback = callback
        owner.name = name
      },
      { authority: false },
    ).then(() => owner.name)
  }

  export async function callback(mcpName: string, state: string): Promise<OAuthCallback | undefined> {
    const entry = await get(mcpName)
    if (!entry || !activeFlow(entry, state)) return { type: "cancelled" }
    return entry.oauthCallback
  }

  export function cancelOAuthFlow(mcpName: string, expectedState: string): Promise<boolean> {
    return update(
      `mcp-auth.flow.cancel:${mcpName}`,
      (store) => {
        const entry = store[mcpName]!
        entry.oauthCallback = { type: "cancelled" }
        delete entry.oauthSettling
      },
      {
        authority: false,
        condition: (store) => {
          const entry = store[mcpName]
          return !!entry && activeFlow(entry, expectedState)
        },
      },
    )
  }

  export function clearOAuthFlow(mcpName: string, expected: string): Promise<void> {
    return updateEntry(
      `mcp-auth.flow.clear:${mcpName}`,
      mcpName,
      (entry) => {
        if (entry.oauthState !== expected) throw new Error("OAuth state changed before it could be cleared")
        delete entry.oauthState
        delete entry.oauthStartedAt
        delete entry.oauthAuthorizationUrl
        delete entry.oauthServerUrl
        delete entry.oauthAuthorityFingerprint
        delete entry.oauthAllowDisabled
        delete entry.oauthSettling
        delete entry.oauthCallback
        delete entry.codeVerifier
      },
      undefined,
      { authority: false },
    )
  }

  /** Idempotent compare-and-clear for the cancellation owner. A local waiter
   * may observe the durable cancelled marker and clear the same state first;
   * that is success, while a replacement state must remain untouched. */
  export function clearOAuthFlowIfCurrent(mcpName: string, expected: string): Promise<boolean> {
    return update(
      `mcp-auth.flow.clear-if-current:${mcpName}`,
      (store) => {
        const entry = store[mcpName]!
        delete entry.oauthState
        delete entry.oauthStartedAt
        delete entry.oauthAuthorizationUrl
        delete entry.oauthServerUrl
        delete entry.oauthAuthorityFingerprint
        delete entry.oauthAllowDisabled
        delete entry.oauthSettling
        delete entry.oauthCallback
        delete entry.codeVerifier
      },
      {
        authority: false,
        condition: (store) => store[mcpName]?.oauthState === expected,
      },
    )
  }

  export async function isTokenExpired(mcpName: string): Promise<boolean | null> {
    const entry = await get(mcpName)
    if (!entry?.tokens) return null
    if (!entry.tokens.expiresAt) return false
    return entry.tokens.expiresAt < Date.now() / 1000
  }
}

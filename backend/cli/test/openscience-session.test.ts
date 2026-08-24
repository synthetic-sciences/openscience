import { test, expect, afterEach, spyOn } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Global } from "../src/global"
import { OpenScience } from "../src/openscience"
import { CredentialLifecycle } from "../src/credentials/lifecycle"
import { Provider } from "../src/provider/provider"
import { GlobalBus } from "../src/bus/global"
import { CONSENT_VERSION, OutboundTelemetry } from "../src/telemetry/outbound"

const file = path.join(Global.Path.data, "openscience-session.json")
const syncedDir = path.join(process.env.XDG_CONFIG_HOME!, "openscience")
const syncedSnapshot = path.join(syncedDir, "synced-env.json")
const syncedConfig = path.join(syncedDir, "openscience-synced.json")
const traceQueue = path.join(Global.Path.data, "telemetry-queue-v2.jsonl")
const traceConsent = path.join(Global.Path.data, "telemetry-consent-v2.json")
const original = globalThis.fetch

function enabledConsent() {
  return Response.json({
    consent_version: CONSENT_VERSION,
    analytics_enabled: true,
    research_content_enabled: true,
    consent_epoch: "e".repeat(32),
  })
}

afterEach(async () => {
  globalThis.fetch = original
  if (process.env.GITHUB_TOKEN === "account-a-synced-secret") delete process.env.GITHUB_TOKEN
  await Promise.all(
    [file, syncedSnapshot, syncedConfig, traceQueue, traceConsent].map((target) =>
      fs.rm(target, { force: true }).catch(() => {}),
    ),
  )
})

test("getSession carries the sync bookkeeping fields", async () => {
  await fs.mkdir(Global.Path.data, { recursive: true })
  await Bun.write(
    file,
    JSON.stringify({
      api_key: "thk_test.secret",
      user_id: "user-1",
      device_name: "test-device",
      cached_v: 7,
      last_check_ts: 1751700000000,
    }),
  )

  const session = await OpenScience.getSession()
  expect(session).not.toBeNull()
  expect(session!.cached_v).toBe(7)
  expect(session!.last_check_ts).toBe(1751700000000)
})

test("scheduled credential refresh is non-blocking and single-flight", async () => {
  await fs.mkdir(Global.Path.data, { recursive: true })
  await Bun.write(
    file,
    JSON.stringify({
      api_key: "thk_test.secret",
      user_id: "user-1",
      cached_v: 7,
      last_check_ts: 0,
    }),
  )
  const gate = Promise.withResolvers<void>()
  const started = Promise.withResolvers<void>()
  const state = { calls: 0 }
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (!String(input).endsWith("/api/cli/sync/version")) return new Response("not found", { status: 404 })
    state.calls++
    started.resolve()
    await gate.promise
    return Response.json({ v: 7 })
  }) as typeof fetch

  const first = OpenScience.scheduleRefresh()
  const second = OpenScience.scheduleRefresh()
  expect(first).toBe(second)
  await started.promise
  expect(state.calls).toBe(1)
  gate.resolve()
  await first
})

test("scheduled credential refresh does not revoke the active runtime", async () => {
  await fs.mkdir(Global.Path.data, { recursive: true })
  await Bun.write(
    file,
    JSON.stringify({
      api_key: "thk_test.secret",
      user_id: "user-1",
      cached_v: 7,
      last_check_ts: 0,
    }),
  )

  const state = { revocations: 0 }
  const unregister = CredentialLifecycle.onRevoke(() => {
    state.revocations++
  })
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).endsWith("/api/cli/sync/version")) return Response.json({ v: 8 })
    if (String(input).endsWith("/api/cli/sync")) {
      return Response.json({ user: {}, services: {} })
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch

  try {
    await OpenScience.refreshIfStale()
    for (const _ of Array.from({ length: 200 })) {
      if ((await OpenScience.getSession())?.cached_v === 8) break
      await Bun.sleep(10)
    }
    expect((await OpenScience.getSession())?.cached_v).toBe(8)
    expect(state.revocations).toBe(0)
  } finally {
    unregister()
  }
})

test("an authenticated control-plane 401 clears the matching session and announces the account change", async () => {
  await OpenScience.clearSession()
  await OpenScience.saveSession({ api_key: "thk_revoked.secret", user_id: "user-revoked" })
  OpenScience.invalidateBalance()

  const disposed: string[] = []
  const onEvent = (event: { payload?: { type?: string } }) => {
    if (event.payload?.type === "global.disposed") disposed.push(event.payload.type)
  }
  GlobalBus.on("event", onEvent)
  const invalidate = spyOn(Provider, "invalidate")
  globalThis.fetch = (async (_input: string | URL | Request) =>
    new Response("revoked", { status: 401 })) as typeof fetch

  try {
    expect(await OpenScience.getBalance()).toBeNull()
    expect(await OpenScience.getSession()).toBeNull()
    expect(invalidate).toHaveBeenCalled()
    expect(disposed).toEqual(["global.disposed"])
  } finally {
    invalidate.mockRestore()
    GlobalBus.off("event", onEvent)
  }
})

test("403, 5xx, and network failures keep the authenticated session for offline use", async () => {
  for (const scenario of [403, 503, "network"] as const) {
    await OpenScience.clearSession()
    await OpenScience.saveSession({ api_key: `thk_keep_${scenario}.secret`, user_id: `user-${scenario}` })
    OpenScience.invalidateBalance()
    globalThis.fetch = (async (_input: string | URL | Request) => {
      if (scenario === "network") throw new TypeError("offline")
      return new Response("unavailable", { status: scenario })
    }) as typeof fetch

    expect(await OpenScience.getBalance()).toBeNull()
    expect((await OpenScience.getSession())?.api_key).toBe(`thk_keep_${scenario}.secret`)
  }
})

test("a late 401 from an old key cannot clear a newly authenticated session", async () => {
  await OpenScience.clearSession()
  await OpenScience.saveSession({ api_key: "thk_old.secret", user_id: "old" })
  OpenScience.invalidateBalance()

  const started = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const disposed: string[] = []
  const onEvent = (event: { payload?: { type?: string } }) => {
    if (event.payload?.type === "global.disposed") disposed.push(event.payload.type)
  }
  GlobalBus.on("event", onEvent)
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).endsWith("/api/v1/telemetry/consent")) return enabledConsent()
    started.resolve()
    await release.promise
    return new Response("revoked", { status: 401 })
  }) as typeof fetch

  try {
    const oldRequest = OpenScience.getBalance()
    await started.promise
    await OpenScience.saveSession({ api_key: "thk_new.secret", user_id: "new" })
    OpenScience.invalidateBalance()
    const revision = await fs.readFile(CredentialLifecycle.revisionPath(), "utf8")
    release.resolve()

    expect(await oldRequest).toBeNull()
    expect((await OpenScience.getSession())?.api_key).toBe("thk_new.secret")
    expect(disposed).toEqual([])
    expect(await fs.readFile(CredentialLifecycle.revisionPath(), "utf8")).toBe(revision)
  } finally {
    GlobalBus.off("event", onEvent)
  }
})

test("pasted-key validation persists the canonical account id", async () => {
  await OpenScience.clearSession()
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.endsWith("/api/cli/balance")) return Response.json({ balance_cents: 0, balance_usd: 0 })
    if (url.endsWith("/api/cli/sync")) {
      return Response.json({ user: { user_id: "canonical-user-id" }, services: {}, config: null })
    }
    if (url.endsWith("/api/v1/telemetry/consent")) {
      return enabledConsent()
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch

  const signedIn = await OpenScience.loginWithKey("thk_legacy-pasted-key-secret")
  expect(signedIn.user_id).toBe("canonical-user-id")
  expect((await OpenScience.getSession())?.user_id).toBe("canonical-user-id")
})

test("replacing an account clears A credentials and traces before a failed B sync", async () => {
  await OpenScience.clearSession()
  await fs.mkdir(syncedDir, { recursive: true })
  await Bun.write(file, JSON.stringify({ api_key: "thk_account_a.secret", user_id: "account-a" }))
  await Bun.write(syncedSnapshot, JSON.stringify({ GITHUB_TOKEN: "account-a-synced-secret" }))
  await Bun.write(syncedConfig, JSON.stringify({ model: "account-a/model" }))
  await Bun.write(traceQueue, '{"account":"a","prompt":"must-be-purged"}\n')
  process.env.GITHUB_TOKEN = "account-a-synced-secret"
  globalThis.fetch = (async () => new Response("offline", { status: 503 })) as unknown as typeof fetch

  await OpenScience.saveSession({ api_key: "thk_account_b.secret", user_id: "account-b" })
  expect(await OpenScience.syncServices()).toBeNull()

  expect(await OpenScience.getSession()).toMatchObject({ api_key: "thk_account_b.secret", user_id: "account-b" })
  expect(await Bun.file(syncedSnapshot).exists()).toBe(false)
  expect(await Bun.file(syncedConfig).exists()).toBe(false)
  expect(await Bun.file(traceQueue).exists()).toBe(false)
  expect(process.env.GITHUB_TOKEN).toBeUndefined()
})

test("authenticated control-plane activity retries an offline opt-out without reopening Settings", async () => {
  await OpenScience.saveSession({ api_key: "thk_account_activity.secret", user_id: "account-activity" })
  globalThis.fetch = (async () => {
    throw new TypeError("offline")
  }) as unknown as typeof fetch
  expect(await OutboundTelemetry.setAnalytics(false)).toMatchObject({ analyticsEnabled: false, pending: true })

  let purges = 0
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith("/api/cli/balance")) return Response.json({ balance_usd: 12 })
    if (url.endsWith("/api/v1/telemetry/consent")) {
      purges++
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer thk_account_activity.secret")
      return Response.json({
        consent_version: CONSENT_VERSION,
        analytics_enabled: false,
        research_content_enabled: false,
      })
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch

  OpenScience.invalidateBalance()
  expect(await OpenScience.getBalance()).toBe(12)
  expect(purges).toBe(1)
  expect(await OutboundTelemetry.status()).toMatchObject({ analyticsEnabled: false, pending: false })
})

test("account replacement retains A's deletion proof without applying it to B", async () => {
  const accountA = {
    api_key: `thk_${"a".repeat(32)}.${"account-a-secret".repeat(2)}`,
    user_id: "account-a",
  }
  const accountB = {
    api_key: `thk_${"b".repeat(32)}.${"account-b-secret".repeat(2)}`,
    user_id: "account-b",
  }
  await OpenScience.saveSession(accountA)
  globalThis.fetch = (async () => {
    throw new TypeError("offline")
  }) as unknown as typeof fetch
  expect(await OutboundTelemetry.setAnalytics(false)).toMatchObject({ analyticsEnabled: false, pending: true })

  await OpenScience.saveSession(accountB)
  expect(await OpenScience.getSession()).toMatchObject(accountB)

  const proofRequests: Array<{ authorization: string | null; proof: string | null }> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith("/api/cli/balance")) return Response.json({ balance_usd: 9 })
    expect(url).toEndWith("/api/v1/telemetry/account-data/by-key-proof")
    const headers = new Headers(init?.headers)
    proofRequests.push({
      authorization: headers.get("authorization"),
      proof: headers.get("x-openscience-telemetry-deletion-proof"),
    })
    return Response.json({ status: "completed", scope: "traces" })
  }) as typeof fetch

  OpenScience.invalidateBalance()
  expect(await OpenScience.getBalance()).toBe(9)
  expect(proofRequests).toHaveLength(1)
  expect(proofRequests[0]).toMatchObject({ authorization: null })
  expect(Buffer.from(proofRequests[0].proof!.split(".")[1], "hex").toString()).toBe(`thk_${"a".repeat(8)}`)
  expect(await OpenScience.getSession()).toMatchObject(accountB)
  const localConsent = await Bun.file(traceConsent).text()
  expect(localConsent).not.toContain(accountA.api_key)
  expect(localConsent).not.toContain(accountB.api_key)
  expect(localConsent).not.toContain("deletion_proof")
})

test("canonical account-id migration retries and preserves a legacy session opt-out", async () => {
  const apiKey = "thk_legacy_subject.secret"
  const legacy = { api_key: apiKey, user_id: "" }
  const canonical = { api_key: apiKey, user_id: "canonical-account" }
  await OpenScience.saveSession(legacy)
  globalThis.fetch = (async () => {
    throw new TypeError("offline")
  }) as unknown as typeof fetch
  expect(await OutboundTelemetry.setAnalytics(false)).toMatchObject({ analyticsEnabled: false, pending: true })

  await OpenScience.saveSession(canonical)
  expect(await OpenScience.getSession()).toMatchObject(canonical)

  const authorizations: Array<string | null> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toEndWith("/api/v1/telemetry/consent")
    authorizations.push(new Headers(init?.headers).get("authorization"))
    return Response.json({
      consent_version: CONSENT_VERSION,
      analytics_enabled: false,
      research_content_enabled: false,
    })
  }) as typeof fetch

  await OutboundTelemetry.initializeAccount()
  expect(authorizations).toEqual([`Bearer ${apiKey}`])
  expect(await OpenScience.getSession()).toMatchObject(canonical)
  expect(await OutboundTelemetry.status()).toMatchObject({ analyticsEnabled: false, pending: false })
  const consent = JSON.parse(await Bun.file(traceConsent).text()) as {
    subjects: Record<string, { analytics_enabled: boolean; research_content_enabled: boolean; pending?: boolean }>
  }
  expect(Object.values(consent.subjects)).toHaveLength(2)
  expect(Object.values(consent.subjects)).toEqual(
    Array.from({ length: 2 }, () =>
      expect.objectContaining({
        analytics_enabled: false,
        research_content_enabled: false,
        pending: false,
      }),
    ),
  )
  expect(JSON.stringify(consent)).not.toContain(apiKey)
})

test("an opt-out that wins the account boundary purges A before replacement", async () => {
  const accountA = { api_key: "thk_boundary_a.secret", user_id: "boundary-a" }
  const accountB = { api_key: "thk_boundary_b.secret", user_id: "boundary-b" }
  await OpenScience.saveSession(accountA)

  const purgeStarted = Promise.withResolvers<void>()
  const finishPurge = Promise.withResolvers<void>()
  const requests: Array<{ authorization: string | null; enabled: boolean }> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toEndWith("/api/v1/telemetry/consent")
    if (init?.method === "GET") return enabledConsent()
    const body = JSON.parse(String(init?.body)) as { analytics_enabled: boolean }
    requests.push({
      authorization: new Headers(init?.headers).get("authorization"),
      enabled: body.analytics_enabled,
    })
    purgeStarted.resolve()
    await finishPurge.promise
    return Response.json({
      consent_version: CONSENT_VERSION,
      analytics_enabled: body.analytics_enabled,
      research_content_enabled: body.analytics_enabled,
    })
  }) as typeof fetch

  let optOut: ReturnType<typeof OutboundTelemetry.setAnalytics> | undefined
  let replacement: Promise<void> | undefined
  try {
    optOut = OutboundTelemetry.setAnalytics(false)
    await purgeStarted.promise
    let replacementSettled = false
    replacement = OpenScience.saveSession(accountB).finally(() => {
      replacementSettled = true
    })
    await Bun.sleep(30)
    expect(replacementSettled).toBe(false)
    expect(await OpenScience.getSession()).toMatchObject(accountA)

    finishPurge.resolve()
    expect(await optOut).toMatchObject({ analyticsEnabled: false, pending: false })
    await replacement
    expect(await OpenScience.getSession()).toMatchObject(accountB)
    expect(requests).toEqual([{ authorization: `Bearer ${accountA.api_key}`, enabled: false }])
  } finally {
    finishPurge.resolve()
    await Promise.allSettled([optOut, replacement].filter((value) => value !== undefined))
  }
})

test("a replacement that wins the account boundary makes the later opt-out apply only to B", async () => {
  const accountA = { api_key: "thk_replace_first_a.secret", user_id: "replace-first-a" }
  const accountB = { api_key: "thk_replace_first_b.secret", user_id: "replace-first-b" }
  await OpenScience.saveSession(accountA)

  const sessionWriteStarted = Promise.withResolvers<void>()
  const finishSessionWrite = Promise.withResolvers<void>()
  const renameOriginal = fs.rename.bind(fs)
  let intercepted = false
  const rename = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
    if (!intercepted && destination === file) {
      intercepted = true
      sessionWriteStarted.resolve()
      await finishSessionWrite.promise
    }
    return renameOriginal(source, destination)
  })
  const requests: Array<{ authorization: string | null; enabled: boolean }> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toEndWith("/api/v1/telemetry/consent")
    if (init?.method === "GET") return enabledConsent()
    const body = JSON.parse(String(init?.body)) as { analytics_enabled: boolean }
    requests.push({
      authorization: new Headers(init?.headers).get("authorization"),
      enabled: body.analytics_enabled,
    })
    return Response.json({
      consent_version: CONSENT_VERSION,
      analytics_enabled: body.analytics_enabled,
      research_content_enabled: body.analytics_enabled,
    })
  }) as typeof fetch

  let replacement: Promise<void> | undefined
  let optOut: ReturnType<typeof OutboundTelemetry.setAnalytics> | undefined
  try {
    replacement = OpenScience.saveSession(accountB)
    await sessionWriteStarted.promise
    let optOutSettled = false
    optOut = OutboundTelemetry.setAnalytics(false).finally(() => {
      optOutSettled = true
    })
    await Bun.sleep(30)
    expect(optOutSettled).toBe(false)
    expect(requests).toEqual([])
    expect(await OpenScience.getSession()).toMatchObject(accountA)

    finishSessionWrite.resolve()
    await replacement
    expect(await optOut).toMatchObject({ analyticsEnabled: false, pending: false })
    expect(await OpenScience.getSession()).toMatchObject(accountB)
    expect(requests).toEqual([{ authorization: `Bearer ${accountB.api_key}`, enabled: false }])
  } finally {
    finishSessionWrite.resolve()
    await Promise.allSettled([replacement, optOut].filter((value) => value !== undefined))
    rename.mockRestore()
  }
})

test("canonical-id migration wins atomically before a concurrent opt-out", async () => {
  const apiKey = "thk_canonical_boundary.secret"
  const legacy = { api_key: apiKey, user_id: "" }
  const canonical = { api_key: apiKey, user_id: "canonical-boundary" }
  await OpenScience.saveSession(legacy)

  const sessionWriteStarted = Promise.withResolvers<void>()
  const finishSessionWrite = Promise.withResolvers<void>()
  const renameOriginal = fs.rename.bind(fs)
  let intercepted = false
  const rename = spyOn(fs, "rename").mockImplementation(async (source, destination) => {
    if (!intercepted && destination === file) {
      intercepted = true
      sessionWriteStarted.resolve()
      await finishSessionWrite.promise
    }
    return renameOriginal(source, destination)
  })
  const requests: Array<{ authorization: string | null; enabled: boolean }> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    expect(String(input)).toEndWith("/api/v1/telemetry/consent")
    if (init?.method === "GET") return enabledConsent()
    const body = JSON.parse(String(init?.body)) as { analytics_enabled: boolean }
    requests.push({
      authorization: new Headers(init?.headers).get("authorization"),
      enabled: body.analytics_enabled,
    })
    return Response.json({
      consent_version: CONSENT_VERSION,
      analytics_enabled: body.analytics_enabled,
      research_content_enabled: body.analytics_enabled,
    })
  }) as typeof fetch

  let migration: Promise<void> | undefined
  let optOut: ReturnType<typeof OutboundTelemetry.setAnalytics> | undefined
  try {
    migration = OpenScience.saveSession(canonical)
    await sessionWriteStarted.promise
    let optOutSettled = false
    optOut = OutboundTelemetry.setAnalytics(false).finally(() => {
      optOutSettled = true
    })
    await Bun.sleep(30)
    expect(optOutSettled).toBe(false)
    expect(requests).toEqual([])
    expect(await OpenScience.getSession()).toMatchObject(legacy)

    finishSessionWrite.resolve()
    await migration
    expect(await optOut).toMatchObject({ analyticsEnabled: false, pending: false })
    expect(await OpenScience.getSession()).toMatchObject(canonical)
    expect(requests).toEqual([{ authorization: `Bearer ${apiKey}`, enabled: false }])

    const consent = JSON.parse(await Bun.file(traceConsent).text()) as {
      active_subject?: string
      subjects: Record<string, { analytics_enabled: boolean; research_content_enabled: boolean; pending?: boolean }>
    }
    expect(consent.active_subject).toBe("account:canonical-boundary")
    expect(consent.subjects["account:canonical-boundary"]).toMatchObject({
      analytics_enabled: false,
      research_content_enabled: false,
      pending: false,
    })
    expect(
      Object.entries(consent.subjects).find(([subject]) => subject !== "account:canonical-boundary")?.[1],
    ).toMatchObject({
      analytics_enabled: true,
      research_content_enabled: true,
      pending: false,
    })
    expect(JSON.stringify(consent)).not.toContain(apiKey)
  } finally {
    finishSessionWrite.resolve()
    await Promise.allSettled([migration, optOut].filter((value) => value !== undefined))
    rename.mockRestore()
  }
})

test("a 401 cleanup waits for an in-flight opt-out without deadlocking", async () => {
  const account = { api_key: "thk_user.secret", user_id: "boundary-401" }
  await OpenScience.saveSession(account)
  OpenScience.invalidateBalance()

  const purgeStarted = Promise.withResolvers<void>()
  const finishPurge = Promise.withResolvers<void>()
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith("/api/v1/telemetry/consent")) {
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${account.api_key}`)
      purgeStarted.resolve()
      await finishPurge.promise
      return Response.json({
        consent_version: CONSENT_VERSION,
        analytics_enabled: false,
        research_content_enabled: false,
      })
    }
    if (url.endsWith("/api/cli/balance")) return new Response("revoked", { status: 401 })
    return new Response("not found", { status: 404 })
  }) as typeof fetch

  let optOut: ReturnType<typeof OutboundTelemetry.setAnalytics> | undefined
  let rejectedRequest: Promise<number | null> | undefined
  try {
    optOut = OutboundTelemetry.setAnalytics(false)
    await purgeStarted.promise
    let cleanupSettled = false
    rejectedRequest = OpenScience.getBalance().finally(() => {
      cleanupSettled = true
    })
    await Bun.sleep(30)
    expect(cleanupSettled).toBe(false)
    expect(await OpenScience.getSession()).toMatchObject(account)

    finishPurge.resolve()
    expect(await optOut).toMatchObject({ analyticsEnabled: false, pending: false })
    expect(await rejectedRequest).toBeNull()
    expect(await OpenScience.getSession()).toBeNull()
  } finally {
    finishPurge.resolve()
    await Promise.allSettled([optOut, rejectedRequest].filter((value) => value !== undefined))
  }
})

test("a revoked legacy-key 401 retries an offline opt-out after clearing the raw session", async () => {
  const apiKey = `thk_revoked_device.${"revoked-device-secret".repeat(2)}`
  const account = { api_key: apiKey, user_id: "revoked-proof-account" }
  await OpenScience.saveSession(account)
  globalThis.fetch = (async () => {
    throw new TypeError("offline")
  }) as unknown as typeof fetch
  expect(await OutboundTelemetry.setAnalytics(false)).toMatchObject({ pending: true })

  const proofRequests: Array<{ authorization: string | null; proof: string | null }> = []
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith("/api/cli/balance")) return new Response("revoked", { status: 401 })
    if (url.endsWith("/api/v1/telemetry/account-data/by-key-proof")) {
      const headers = new Headers(init?.headers)
      proofRequests.push({
        authorization: headers.get("authorization"),
        proof: headers.get("x-openscience-telemetry-deletion-proof"),
      })
      return Response.json({ status: "completed", scope: "traces" })
    }
    return new Response("not found", { status: 404 })
  }) as typeof fetch

  OpenScience.invalidateBalance()
  expect(await OpenScience.getBalance()).toBeNull()
  expect(await OpenScience.getSession()).toBeNull()
  expect(proofRequests).toHaveLength(1)
  expect(proofRequests[0]).toMatchObject({ authorization: null })
  expect(proofRequests[0].proof).toMatch(/^odp_v2\.[a-f0-9]{10,138}\.[a-f0-9]{32}\.[a-f0-9]{32}\.[a-f0-9]{64}$/)
  const state = await Bun.file(traceConsent).text()
  expect(state).not.toContain(apiKey)
  expect(state).not.toContain("deletion_proof")
})

test("logout that wins the account boundary prevents a later opt-out from using the old key", async () => {
  const account = { api_key: "thk_logout_boundary.secret", user_id: "boundary-logout" }
  await OpenScience.saveSession(account)

  const sessionDeleteStarted = Promise.withResolvers<void>()
  const finishSessionDelete = Promise.withResolvers<void>()
  const unlinkOriginal = fs.unlink.bind(fs)
  let intercepted = false
  const unlink = spyOn(fs, "unlink").mockImplementation(async (target) => {
    if (!intercepted && target === file) {
      intercepted = true
      sessionDeleteStarted.resolve()
      await finishSessionDelete.promise
    }
    return unlinkOriginal(target)
  })
  let telemetryRequests = 0
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).endsWith("/api/v1/telemetry/consent")) telemetryRequests++
    return new Response("unexpected", { status: 500 })
  }) as typeof fetch

  let logout: ReturnType<typeof OpenScience.clearSession> | undefined
  let optOut: ReturnType<typeof OutboundTelemetry.setAnalytics> | undefined
  try {
    logout = OpenScience.clearSession()
    await sessionDeleteStarted.promise
    let optOutSettled = false
    optOut = OutboundTelemetry.setAnalytics(false).finally(() => {
      optOutSettled = true
    })
    await Bun.sleep(30)
    expect(optOutSettled).toBe(false)
    expect(telemetryRequests).toBe(0)
    expect(await OpenScience.getSession()).toMatchObject(account)

    finishSessionDelete.resolve()
    expect(await logout).toBe(true)
    expect(await optOut).toMatchObject({ signedIn: false, analyticsEnabled: false, pending: false })
    expect(await OpenScience.getSession()).toBeNull()
    expect(telemetryRequests).toBe(0)
  } finally {
    finishSessionDelete.resolve()
    await Promise.allSettled([logout, optOut].filter((value) => value !== undefined))
    unlink.mockRestore()
  }
})

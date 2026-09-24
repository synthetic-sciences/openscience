import { afterEach, expect, test } from "bun:test"
import { Auth } from "../../src/auth"
import { CredentialLifecycle } from "../../src/credentials/lifecycle"
import { CredentialTeardown } from "../../src/credentials/teardown"
import { CodexAuthPlugin, CodexCredentialsChangedError, refreshCodexAuth } from "../../src/plugin/codex"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir } from "../fixture/fixture"

const realFetch = globalThis.fetch
const original: Auth.Oauth = {
  type: "oauth",
  access: "expired-access",
  refresh: "original-refresh",
  expires: 1,
  accountId: "original-account",
}
const response = () => Response.json({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 })

afterEach(async () => {
  globalThis.fetch = realFetch
  await Auth.remove("openai-codex")
})

test("a malformed token response cannot replace the saved Codex connection", async () => {
  await Auth.set("openai-codex", original)
  globalThis.fetch = (async () => Response.json({ expires_in: 3600 })) as unknown as typeof fetch
  await expect(refreshCodexAuth(original)).rejects.toThrow()
  expect(await Auth.get("openai-codex")).toEqual(original)
})

test.each(["expiry", "401"])(
  "Codex %s refresh completes its active turn without credential teardown",
  async (trigger) => {
    await Auth.set("openai-codex", { ...original, expires: trigger === "expiry" ? 1 : Date.now() + 3_600_000 })
    await using directory = await tmpdir({ git: true })
    const revoke = CredentialLifecycle.onRevoke(CredentialTeardown.apply)
    try {
      await Instance.provide({
        directory: directory.path,
        fn: async () => {
          const session = await Session.create({})
          const plugin = await CodexAuthPlugin()
          const options = await plugin.auth!.loader!(() => Auth.get("openai-codex"), {
            id: "openai-codex",
            name: "ChatGPT",
            source: "custom",
            env: [],
            options: {},
            models: {},
          })
          const request = options.fetch as (url: string, init: RequestInit) => Promise<Response>
          const attempts: string[] = []
          let refreshes = 0
          globalThis.fetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
            if (String(url) === "https://auth.openai.com/oauth/token") {
              refreshes++
              return response()
            }
            expect(String(url)).toBe("https://chatgpt.com/backend-api/codex/responses")
            init?.signal?.throwIfAborted()
            const headers = new Headers(init?.headers)
            expect(headers.get("ChatGPT-Account-Id")).toBe(original.accountId!)
            attempts.push(headers.get("authorization")!)
            return new Response("answer", { status: trigger === "401" && attempts.length === 1 ? 401 : 200 })
          }) as unknown as typeof fetch
          await SessionPrompt.withCancellation(session.id, async () => {
            const signal = SessionPrompt.activeController(session.id)!
            const result = await request("https://api.openai.com/v1/responses", {
              method: "POST",
              signal,
            })
            expect(await result.text()).toBe("answer")
            expect(signal.aborted).toBe(false)
          })
          expect(refreshes).toBe(1)
          expect(attempts).toEqual(
            trigger === "401" ? ["Bearer expired-access", "Bearer fresh-access"] : ["Bearer fresh-access"],
          )
          expect(await Auth.get("openai-codex")).toMatchObject({ access: "fresh-access", refresh: "fresh-refresh" })
          await Session.remove(session.id)
        },
      })
    } finally {
      revoke()
      await Instance.disposeAll()
    }
  },
)

test("concurrent Codex refreshes share the request and durable renewal", async () => {
  await Auth.set("openai-codex", original)
  let calls = 0
  let revisions = 0
  const refreshed = CredentialLifecycle.onRefresh(() => {
    revisions++
  })
  globalThis.fetch = (async () => {
    calls++
    return response()
  }) as unknown as typeof fetch
  try {
    const results = await Promise.all(Array.from({ length: 5 }, () => refreshCodexAuth(original)))
    expect(calls).toBe(1)
    expect(revisions).toBe(1)
    expect(results.every((item) => item.access === "fresh-access")).toBe(true)
    expect(await Auth.get("openai-codex")).toEqual(results[0])
  } finally {
    refreshed()
  }
})

test.each(["logout", "replacement"])("a pending Codex refresh respects %s", async (change) => {
  await Auth.set("openai-codex", original)
  const started = Promise.withResolvers<void>()
  const complete = Promise.withResolvers<Response>()
  globalThis.fetch = (async () => {
    started.resolve()
    return complete.promise
  }) as unknown as typeof fetch
  const pending = refreshCodexAuth(original)
  const settled = pending.then(
    (value) => value,
    (error: unknown) => error,
  )
  const replacement: Auth.Oauth = { ...original, refresh: "replacement-refresh", accountId: "replacement-account" }
  try {
    await started.promise
    if (change === "logout") await Auth.remove("openai-codex")
    if (change === "replacement") await Auth.set("openai-codex", replacement)
    complete.resolve(response())
    expect(await settled).toBeInstanceOf(CodexCredentialsChangedError)
    if (change === "logout") expect(await Auth.get("openai-codex")).toBeUndefined()
    if (change === "replacement") expect(await Auth.get("openai-codex")).toEqual(replacement)
  } finally {
    complete.resolve(response())
    await pending.catch(() => undefined)
  }
})

test("a newly connected account does not join the previous account's refresh", async () => {
  await Auth.set("openai-codex", original)
  const started = Promise.withResolvers<void>()
  const complete = Promise.withResolvers<Response>()
  const refreshes: string[] = []
  globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const token = new URLSearchParams(String(init?.body)).get("refresh_token")!
    refreshes.push(token)
    if (token === original.refresh) {
      started.resolve()
      return complete.promise
    }
    return response()
  }) as unknown as typeof fetch
  const pending = refreshCodexAuth(original)
  const settled = pending.then(
    (value) => value,
    (error: unknown) => error,
  )
  try {
    await started.promise
    const replacement: Auth.Oauth = { ...original, refresh: "replacement-refresh", accountId: "replacement-account" }
    await Auth.set("openai-codex", replacement)
    const renewed = await refreshCodexAuth(replacement)
    expect(renewed.accountId).toBe("replacement-account")
    complete.resolve(response())
    expect(await settled).toBeInstanceOf(CodexCredentialsChangedError)
    expect(refreshes).toEqual([original.refresh, replacement.refresh])
    expect(await Auth.get("openai-codex")).toEqual(renewed)
  } finally {
    complete.resolve(response())
    await pending.catch(() => undefined)
  }
})

test.each([200, 400])("a newer persisted pair wins over a late HTTP %s refresh response", async (status) => {
  await Auth.set("openai-codex", original)
  const started = Promise.withResolvers<void>()
  const complete = Promise.withResolvers<Response>()
  globalThis.fetch = (async () => {
    started.resolve()
    return complete.promise
  }) as unknown as typeof fetch
  const pending = refreshCodexAuth(original)
  const latest: Auth.Oauth = {
    ...original,
    refresh: "winner-refresh",
    access: "winner-access",
    expires: Date.now() + 60_000,
  }
  try {
    await started.promise
    expect(await Auth.renew("openai-codex", original, latest)).toBe(true)
    complete.resolve(status === 200 ? response() : new Response("invalid_grant", { status }))
    expect(await pending).toEqual(latest)
    expect(await Auth.get("openai-codex")).toEqual(latest)
  } finally {
    complete.resolve(response())
    await pending.catch(() => undefined)
  }
})

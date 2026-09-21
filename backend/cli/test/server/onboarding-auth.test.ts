import { afterEach, describe, expect, test } from "bun:test"
import { Auth } from "../../src/auth"
import { KeyCheck } from "../../src/provider/key-check"
import { OnboardingAuthRoutes } from "../../src/server/routes/onboarding-auth"

const PROVIDERS = ["anthropic", "openai", "openrouter", "google", "deepseek"]

afterEach(async () => {
  for (const id of PROVIDERS) await Auth.remove(id)
})

/**
 * The real route, credential store and key check; only the provider's answer
 * and the billing mode are stand-ins, so no test reaches the network.
 */
function setup(
  answer: (url: string, init: RequestInit) => Response | Promise<Response>,
  options: { config?: KeyCheck.Routing; env?: Record<string, string>; deadlineMs?: number } = {},
) {
  const calls: Array<{ url: string; headers: Record<string, string>; redirect?: string }> = []
  const state = { mode: "managed" as "managed" | "byok" | null, invalidated: 0 }
  const app = OnboardingAuthRoutes({
    readCredential: (providerID) => Auth.get(providerID),
    saveCredential: (providerID, auth) => Auth.set(providerID, auth),
    removeCredential: (providerID) => Auth.remove(providerID),
    verifyKey: (providerID, key) =>
      KeyCheck.verify({
        providerID,
        key,
        config: async () => options.config ?? {},
        env: options.env ?? {},
        deadlineMs: options.deadlineMs,
        fetch: async (url, init) => {
          calls.push({ url, headers: Object.fromEntries(new Headers(init.headers)), redirect: init.redirect })
          return answer(url, init)
        },
      }),
    readBillingMode: async () => state.mode,
    selectByok: async () => {
      state.mode = "byok"
    },
    restoreBillingMode: async (mode) => {
      state.mode = mode
    },
    invalidate: () => {
      state.invalidated += 1
    },
    serialize: (action) => action(),
  })
  const put = (providerID: string, key: string) =>
    app.request(`/${providerID}/onboarding`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "api", key }),
    })
  return { calls, state, put }
}

describe("PUT /auth/:providerID/onboarding", () => {
  test("a key the provider refuses is not saved, and the answer names the provider", async () => {
    const f = setup(() => Response.json({ error: { message: "invalid x-api-key" } }, { status: 401 }))
    const response = await f.put("anthropic", "sk-ant-this-is-not-a-real-key")
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "Anthropic did not accept that key." })
    expect(await Auth.get("anthropic")).toBeUndefined()
    expect(f.state).toEqual({ mode: "managed", invalidated: 0 })
  })

  test("a refused key leaves the key that was already stored in place", async () => {
    await Auth.set("openai", { type: "api", key: "sk-working" })
    const f = setup(() => new Response("unauthorized", { status: 401 }))
    const response = await f.put("openai", "sk-revoked")
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "OpenAI did not accept that key." })
    expect(await Auth.get("openai")).toEqual({ type: "api", key: "sk-working" })
  })

  test("a key that may not list models is saved unchecked: 403 says nothing about whether it runs them", async () => {
    const f = setup(() => Response.json({ error: { message: "insufficient permissions" } }, { status: 403 }))
    const response = await f.put("openai", "sk-restricted")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ configured: true, verified: false })
    expect(await Auth.get("openai")).toEqual({ type: "api", key: "sk-restricted" })
  })

  test("an accepted key is saved, selects BYOK, and reports that it was checked", async () => {
    const f = setup(() => Response.json({ data: [] }))
    const response = await f.put("anthropic", "sk-ant-real")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ configured: true, verified: true })
    expect(await Auth.get("anthropic")).toEqual({ type: "api", key: "sk-ant-real" })
    expect(f.state).toEqual({ mode: "byok", invalidated: 1 })
    expect(f.calls).toEqual([
      {
        url: "https://api.anthropic.com/v1/models",
        headers: { "x-api-key": "sk-ant-real", "anthropic-version": "2023-06-01" },
        redirect: "error",
      },
    ])
  })

  test("an unreachable provider does not block the save; the answer says the key was not checked", async () => {
    const offline = setup(() => Promise.reject(new Error("getaddrinfo ENOTFOUND api.openai.com")))
    const first = await offline.put("openai", "sk-offline")
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ configured: true, verified: false })
    expect(await Auth.get("openai")).toEqual({ type: "api", key: "sk-offline" })

    const overloaded = setup(() => new Response("upstream timeout", { status: 503 }))
    const second = await overloaded.put("openrouter", "sk-or-busy")
    expect(await second.json()).toEqual({ configured: true, verified: false })
    expect(await Auth.get("openrouter")).toEqual({ type: "api", key: "sk-or-busy" })
  })

  test("a provider that never answers is given up on at the deadline, and the key is still saved", async () => {
    const f = setup(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason))
        }),
      { deadlineMs: 20 },
    )
    const response = await f.put("anthropic", "sk-ant-slow")
    expect(await response.json()).toEqual({ configured: true, verified: false })
    expect(await Auth.get("anthropic")).toEqual({ type: "api", key: "sk-ant-slow" })
  })

  test("the Google key travels in a header, and a 400 that names the key as invalid is a refusal", async () => {
    const refused = setup(() =>
      Response.json(
        {
          error: {
            code: 400,
            status: "INVALID_ARGUMENT",
            details: [{ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "API_KEY_INVALID" }],
          },
        },
        { status: 400 },
      ),
    )
    const response = await refused.put("google", "AIza-made-up")
    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({ error: "Google did not accept that key." })
    expect(await Auth.get("google")).toBeUndefined()
    expect(refused.calls).toHaveLength(1)
    expect(refused.calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1")
    expect(refused.calls[0]!.url).not.toContain("AIza")
    expect(refused.calls[0]!.headers).toEqual({ "x-goog-api-key": "AIza-made-up" })

    // Any other 400 says nothing about the key, so it is treated like an outage.
    const malformed = setup(() => Response.json({ error: { code: 400, details: [] } }, { status: 400 }))
    expect(await (await malformed.put("google", "AIza-real")).json()).toEqual({ configured: true, verified: false })
    expect(await Auth.get("google")).toEqual({ type: "api", key: "AIza-real" })
  })

  test("a provider without a known check is saved as before, with no request made", async () => {
    const f = setup(() => new Response("unexpected", { status: 401 }))
    const response = await f.put("deepseek", "sk-deepseek")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ configured: true })
    expect(await Auth.get("deepseek")).toEqual({ type: "api", key: "sk-deepseek" })
    expect(f.calls).toEqual([])
  })

  test("a provider pointed at a custom endpoint never has its key sent to the public API", async () => {
    const configured = setup(() => new Response("unexpected", { status: 401 }), {
      config: { provider: { anthropic: { options: { baseURL: "https://llm.lab.example/v1" } } } },
    })
    expect(await (await configured.put("anthropic", "lab-proxy-key")).json()).toEqual({ configured: true })
    expect(configured.calls).toEqual([])
    expect(await Auth.get("anthropic")).toEqual({ type: "api", key: "lab-proxy-key" })

    const environment = setup(() => new Response("unexpected", { status: 401 }), {
      env: { OPENAI_BASE_URL: "https://llm.lab.example/v1" },
    })
    expect(await (await environment.put("openai", "lab-proxy-key")).json()).toEqual({ configured: true })
    expect(environment.calls).toEqual([])
  })
})

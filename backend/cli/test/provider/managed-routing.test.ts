import { test, expect, describe, mock } from "bun:test"
import { streamText } from "ai"

// Mock BunProc + default auth plugins so importing Provider never shells out or
// hits the network (mirrors test/provider/provider.test.ts).
mock.module("../../src/bun/index", () => ({
  BunProc: {
    install: async (pkg: string, _version?: string) => {
      const at = pkg.lastIndexOf("@")
      return at > 0 ? pkg.substring(0, at) : pkg
    },
    run: async () => {
      throw new Error("BunProc.run should not be called in tests")
    },
    which: () => process.execPath,
    InstallFailedError: class extends Error {},
  },
}))
const mockPlugin = () => ({})
mock.module("openscience-copilot-auth", () => ({ default: mockPlugin }))
mock.module("openscience-anthropic-auth", () => ({ default: mockPlugin }))
mock.module("@gitlab/openscience-gitlab-auth", () => ({ default: mockPlugin }))

import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Inference } from "../../src/provider/inference"
import { Env } from "../../src/env"
import { Auth } from "../../src/auth"
import { API_BASE, OpenScience } from "../../src/openscience"
import { Config } from "../../src/config/config"
import { BillingSettingsRoutes } from "../../src/server/routes/settings/billing"
import { Global } from "../../src/global"
import { GlobalBus } from "../../src/bus/global"
import { PermissionNext } from "../../src/permission/next"
import path from "path"
import fs from "fs/promises"

function clearManagedLLMEnv() {
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GOOGLE_GENERATIVE_AI_BASE_URL",
    "GEMINI_API_KEY",
    "GEMINI_BASE_URL",
    "OPENROUTER_API_KEY",
    "OPENROUTER_BASE_URL",
    "META_MODEL_API_KEY",
    "META_MODEL_BASE_URL",
    "SYNSCI_API_KEY",
  ]) {
    Env.remove(key)
  }
}

const PROXY = `${API_BASE}/api/llm/proxy`
const ACE = [
  "openai/gpt-5.6-sol",
  "openai/gpt-5.6-terra",
  "openai/gpt-5.6-luna",
  "openai/gpt-5.5",
  "openai/gpt-5.4",
  "openai/gpt-5.4-mini",
  "anthropic/claude-opus-5",
  "anthropic/claude-fable-5",
  "anthropic/claude-sonnet-5",
  "anthropic/claude-haiku-4.5",
  "google/gemini-3.1-pro-preview",
  "google/gemini-3.5-flash",
  "google/gemini-3.1-flash-lite",
  "x-ai/grok-4.6",
  "z-ai/glm-5.3",
  "z-ai/glm-5.3-flash",
  "deepseek/deepseek-v4-pro",
  "deepseek/deepseek-v4-flash",
  "qwen/qwen3.7-max",
  "moonshotai/kimi-k3",
  "moonshotai/kimi-k2.7-code",
  "minimax/minimax-m3",
  "mistralai/mistral-large-2512",
  "meta/muse-spark-1.1",
  "qwen/qwen3.8-27b",
] as const

// ── Pure decision helpers ────────────────────────────────────────────────────

describe("Provider.managedRoutesCuratedProvidersOnly (pure)", () => {
  test("true only when billing.llm === 'managed'", () => {
    expect(Provider.managedRoutesCuratedProvidersOnly({ billing: { llm: "managed" } } as any)).toBe(true)
  })
  test("false for explicit byok", () => {
    expect(Provider.managedRoutesCuratedProvidersOnly({ billing: { llm: "byok" } } as any)).toBe(false)
  })
  test("false for auto-detect (unset / empty billing / null)", () => {
    expect(Provider.managedRoutesCuratedProvidersOnly({} as any)).toBe(false)
    expect(Provider.managedRoutesCuratedProvidersOnly({ billing: {} } as any)).toBe(false)
    expect(Provider.managedRoutesCuratedProvidersOnly({ billing: { llm: null } } as any)).toBe(false)
  })
})

describe("Provider.managedProviderAllowed (pure)", () => {
  test("OpenRouter is the only managed provider", () => {
    expect(Provider.managedProviderAllowed("openrouter")).toBe(true)
  })
  test("legacy Synthetic Sciences, first-party proxies, Codex, and everything else are rejected", () => {
    for (const id of [
      "synsci",
      "synsci-hosted",
      "anthropic",
      "openai",
      "google",
      "meta",
      "openai-codex",
      "github-copilot",
      "gateway",
      "azure",
    ]) {
      expect(Provider.managedProviderAllowed(id)).toBe(false)
    }
  })
})

describe("Provider.isAtlasProxyBaseURL (pure)", () => {
  test("accepts only current first-party proxy routes", () => {
    expect(Provider.isAtlasProxyBaseURL(`${PROXY}/openrouter/v1`)).toBe(true)
    expect(Provider.isAtlasProxyBaseURL(`${PROXY}/openrouter/v1/chat/completions`)).toBe(true)
  })

  test("rejects lookalike origins and path/query tricks", () => {
    expect(Provider.isAtlasProxyBaseURL("https://evil.test/api/llm/proxy/openrouter/v1")).toBe(false)
    expect(Provider.isAtlasProxyBaseURL(`${API_BASE}/not-api/llm/proxy/openrouter/v1`)).toBe(false)
    expect(Provider.isAtlasProxyBaseURL(`${PROXY}/openrouter/v1?next=https://evil.test`)).toBe(false)
    expect(Provider.isAtlasProxyBaseURL(`not a url`)).toBe(false)
  })
})

describe("Provider.isManagedProxyBaseURL (pure)", () => {
  test("detects proxy-shaped routes for BYOK leak prevention", () => {
    expect(Provider.isManagedProxyBaseURL(`${PROXY}/openrouter/v1`)).toBe(true)
    expect(Provider.isManagedProxyBaseURL("https://legacy.example/api/llm/proxy/openrouter/v1")).toBe(true)
    expect(Provider.isManagedProxyBaseURL("https://openrouter.ai/api/v1")).toBe(false)
    expect(Provider.isManagedProxyBaseURL(`${PROXY}/openrouter/v1?key=value`)).toBe(false)
  })
})

describe("Provider.requestFundingHeaders (pure)", () => {
  const funding = {
    api_key: "osk_openrouter",
    user_id: "user-1",
    account: "user-1",
    organization_id: "org_alpha",
  }

  test("attaches the snapshotted organization to the exact managed proxy", () => {
    const headers = Provider.requestFundingHeaders({
      baseURL: `${PROXY}/openrouter/v1`,
      apiKey: "osk_openrouter",
      headers: { "X-Organization-ID": "org_untrusted", Accept: "application/json" },
      funding,
    })
    expect(headers.get("X-Organization-ID")).toBe("org_alpha")
    expect(headers.get("Accept")).toBe("application/json")
  })

  test("strips organization attribution from BYOK, OAuth, local, and lookalike routes", () => {
    for (const [baseURL, apiKey] of [
      ["https://openrouter.ai/api/v1", "sk-or-user"],
      ["https://api.openai.com/v1", "oauth-access"],
      ["http://127.0.0.1:11434/v1", "local-key"],
      ["https://evil.test/api/llm/proxy/openrouter/v1", "thk_openrouter"],
    ]) {
      const headers = Provider.requestFundingHeaders({
        baseURL,
        apiKey,
        headers: { "X-Organization-ID": "org_untrusted" },
        funding,
      })
      expect(headers.has("X-Organization-ID"), baseURL).toBe(false)
    }
  })

  test("fails closed when managed inference has no matching operation snapshot", () => {
    expect(() =>
      Provider.requestFundingHeaders({
        baseURL: `${PROXY}/openrouter/v1`,
        apiKey: "osk_openrouter",
      }),
    ).toThrow("no funding-account snapshot")
    expect(() =>
      Provider.requestFundingHeaders({
        baseURL: `${PROXY}/openrouter/v1`,
        apiKey: "thk_other",
        funding,
      }),
    ).toThrow("connected account changed")
  })
})

describe("Provider.managedIdempotencyKey (pure)", () => {
  const input = {
    endpoint: `${PROXY}/openrouter/v1/chat/completions`,
    body: '{"model":"openai/gpt-5.6-luna","stream":true}',
    sessionID: "session-1",
    messageID: "message-1",
    operation: "model",
  }

  test("is stable for an exact transport retry and changes across operations", () => {
    const first = Provider.managedIdempotencyKey(input)
    expect(first).toMatch(/^os_[a-f0-9]{64}$/)
    expect(Provider.managedIdempotencyKey(input)).toBe(first)
    expect(Provider.managedIdempotencyKey({ ...input, operation: "generate-image" })).not.toBe(first)
    expect(Provider.managedIdempotencyKey({ ...input, body: '{"stream":false}' })).not.toBe(first)
  })
})

describe("Provider.retryManagedPaymentRequired", () => {
  test("retries one exact managed operation only for a pending Ace reload", async () => {
    const headers = new Headers({ "Idempotency-Key": "os_operation" })
    const first = Response.json(
      {
        error: "insufficient_balance",
        recovery: {
          kind: "ace_reload",
          retryable: true,
          retry_after_seconds: 0,
          ace_reload: { state: "available", pending: true },
        },
      },
      { status: 402, headers: { "Retry-After": "0" } },
    )
    let retries = 0
    const second = new Response("ok")

    const result = await Provider.retryManagedPaymentRequired({
      response: first,
      managed: true,
      headers,
      retry: async () => {
        retries++
        return second
      },
    })

    expect(result).toBe(second)
    expect(retries).toBe(1)
  })

  test("does not retry an unproven, monthly-limit, or non-managed 402", async () => {
    const cases = [
      {
        managed: false,
        headers: new Headers({ "Idempotency-Key": "os_operation" }),
        body: { error: "insufficient_balance", recovery: { retryable: true } },
      },
      {
        managed: true,
        headers: new Headers(),
        body: { error: "insufficient_balance", recovery: { retryable: true } },
      },
      {
        managed: true,
        headers: new Headers({ "Idempotency-Key": "os_operation" }),
        responseHeaders: {},
        body: {
          error: "insufficient_balance",
          recovery: {
            kind: "ace_reload",
            retryable: true,
            retry_after_seconds: 0,
            ace_reload: { state: "available", pending: true },
          },
        },
      },
      {
        managed: true,
        headers: new Headers({ "Idempotency-Key": "os_operation" }),
        body: {
          error: "monthly_usage_limit",
          recovery: {
            kind: "monthly_usage_limit",
            retryable: false,
            retry_after_seconds: null,
            ace_reload: { state: "available", pending: false },
          },
        },
      },
    ]
    let retries = 0
    for (const item of cases) {
      const response = Response.json(item.body, {
        status: 402,
        headers: item.responseHeaders ?? { "Retry-After": "0" },
      })
      const result = await Provider.retryManagedPaymentRequired({
        response,
        managed: item.managed,
        headers: item.headers,
        retry: async () => {
          retries++
          return new Response("unexpected")
        },
      })
      expect(result).toBe(response)
    }
    expect(retries).toBe(0)
  })
})

test("managed inference sends the operation snapshot through the real provider fetch hook", async () => {
  await using tmp = await tmpdir({ config: { billing: { llm: "managed" } } })
  const file = path.join(Global.Path.data, "openscience-session.json")
  const original = globalThis.fetch
  const seen: Array<{ organization: string | null; protocol: string | null; idempotency: string | null }> = []
  const chunks = [
    {
      id: "chatcmpl_context",
      object: "chat.completion.chunk",
      created: 1,
      model: "anthropic/claude-sonnet-4.6",
      choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }],
    },
    {
      id: "chatcmpl_context",
      object: "chat.completion.chunk",
      created: 1,
      model: "anthropic/claude-sonnet-4.6",
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    },
  ]
  const body = chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") + "data: [DONE]\n\n"
  try {
    await Bun.write(
      file,
      JSON.stringify({
        api_key: "osk_openrouter",
        user_id: "user-1",
        organization_id: "org_alpha",
        workspace_locked: true,
      }),
    )
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      seen.push({
        organization: headers.get("X-Organization-ID"),
        protocol: headers.get("OpenScience-Funding-Protocol"),
        idempotency: headers.get("Idempotency-Key"),
      })
      return new Response(body, {
        headers: {
          "content-type": "text/event-stream",
          "OpenScience-Funding-Protocol": "1",
          "OpenScience-Funding-Context": "organization:org_alpha",
        },
      })
    }) as typeof fetch
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        clearManagedLLMEnv()
        Env.set("OPENROUTER_API_KEY", "osk_openrouter")
        Env.set("OPENROUTER_BASE_URL", `${PROXY}/openrouter/v1`)
        Provider.invalidate()
      },
      fn: async () => {
        const model = await Provider.getModel("openrouter", "anthropic/claude-sonnet-4.6")
        const language = await Provider.getLanguage(model)
        const funding = await OpenScience.getFundingSnapshot()
        expect(funding).not.toBeNull()
        const context = { sessionID: "session-1", messageID: "message-1", attempt: 1, funding: funding! }
        const result = Provider.withRequestContext(context, () => streamText({ model: language, prompt: "hello" }))
        for await (const _part of Provider.withRequestContextIterable(context, result.fullStream)) {
          // Consuming the real adapter stream drives its custom fetch hook.
        }
        expect(await result.text).toBe("ok")

        for (const prompt of ["generate a title", "generate a title", "generate a different title"]) {
          const internal = streamText({
            model: language,
            prompt,
            headers: {
              "x-openscience-session": "session-title",
              "x-openscience-request": "message-title",
            },
          })
          for await (const _part of internal.fullStream) {
            // Internal calls do not have an AsyncLocal request context. Their
            // managed session headers must still make transport retries safe.
          }
          expect(await internal.text).toBe("ok")
        }
      },
    })
    expect(seen).toHaveLength(4)
    expect(seen[0]).toMatchObject({ organization: "org_alpha", protocol: "1" })
    expect(seen[0]?.idempotency).toMatch(/^os_[a-f0-9]{64}$/)
    expect(seen[1]).toMatchObject({ organization: "org_alpha", protocol: "1" })
    expect(seen[1]?.idempotency).toMatch(/^os_[a-f0-9]{64}$/)
    expect(seen[1]?.idempotency).not.toBe(seen[0]?.idempotency)
    expect(seen[2]?.idempotency).toBe(seen[1]?.idempotency)
    expect(seen[3]?.idempotency).not.toBe(seen[1]?.idempotency)
  } finally {
    globalThis.fetch = original
    await fs.rm(file, { force: true })
    await fs.rm(path.join(Global.Path.data, "openscience-workspace-scope.json"), { force: true })
    delete process.env["OPENROUTER_API_KEY"]
    delete process.env["OPENROUTER_BASE_URL"]
    Provider.invalidate()
  }
})

test("managed organization inference rejects an old gateway before consuming its response", async () => {
  await using tmp = await tmpdir({ config: { billing: { llm: "managed" } } })
  const file = path.join(Global.Path.data, "openscience-session.json")
  const original = globalThis.fetch
  const body =
    `data: ${JSON.stringify({
      id: "chatcmpl_unverified",
      object: "chat.completion.chunk",
      created: 1,
      model: "anthropic/claude-sonnet-4.6",
      choices: [{ index: 0, delta: { role: "assistant", content: "must not be consumed" }, finish_reason: null }],
    })}\n\n` + "data: [DONE]\n\n"
  try {
    await Bun.write(
      file,
      JSON.stringify({
        api_key: "osk_openrouter",
        user_id: "user-1",
        organization_id: "org_alpha",
        workspace_locked: true,
      }),
    )
    globalThis.fetch = (async () =>
      new Response(body, { headers: { "content-type": "text/event-stream" } })) as unknown as typeof fetch
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        clearManagedLLMEnv()
        Env.set("OPENROUTER_API_KEY", "osk_openrouter")
        Env.set("OPENROUTER_BASE_URL", `${PROXY}/openrouter/v1`)
        Provider.invalidate()
      },
      fn: async () => {
        const model = await Provider.getModel("openrouter", "anthropic/claude-sonnet-4.6")
        const language = await Provider.getLanguage(model)
        const funding = await OpenScience.getFundingSnapshot()
        expect(funding).not.toBeNull()
        const context = { sessionID: "session-old", messageID: "message-old", attempt: 1, funding: funding! }
        const result = Provider.withRequestContext(context, () => streamText({ model: language, prompt: "hello" }))
        const parts = []
        for await (const part of result.fullStream) parts.push(part)
        expect(
          parts.some(
            (part) =>
              part.type === "error" && String(part.error).includes("could not verify the selected organization"),
          ),
        ).toBe(true)
        expect(parts.some((part) => part.type === "text-delta")).toBe(false)
      },
    })
  } finally {
    globalThis.fetch = original
    await fs.rm(file, { force: true })
    await fs.rm(path.join(Global.Path.data, "openscience-workspace-scope.json"), { force: true })
    delete process.env["OPENROUTER_API_KEY"]
    delete process.env["OPENROUTER_BASE_URL"]
    Provider.invalidate()
  }
})

// ── Availability filter (hermetic, catalog-backed) ───────────────────────────

describe("managed session availability", () => {
  test("Ace exposes exactly the reviewed 25 models and rejects every other OpenRouter model", async () => {
    await using tmp = await tmpdir({
      config: {
        billing: { llm: "managed" },
        provider: { openrouter: { whitelist: [...ACE] } },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        clearManagedLLMEnv()
        Env.set("OPENROUTER_API_KEY", "thk_openrouter")
        Env.set("OPENROUTER_BASE_URL", `${PROXY}/openrouter/v1`)
        Provider.invalidate()
      },
      fn: async () => {
        const openrouter = (await Provider.list())["openrouter"]
        expect(Object.keys(openrouter.models).sort()).toEqual([...ACE].sort())
        for (const model of ACE) {
          await expect(Provider.getModel("openrouter", model)).resolves.toBeDefined()
        }
        await expect(Provider.getModel("openrouter", "meta-llama/llama-3.3-70b-instruct")).rejects.toThrow()
      },
    })
  })

  test("managed ⇒ only OpenRouter loads; unsupported first-party and Meta proxies are dropped", async () => {
    await using tmp = await tmpdir({ config: { billing: { llm: "managed" } } })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        clearManagedLLMEnv()
        Env.set("ANTHROPIC_API_KEY", "thk_anthropic")
        Env.set("ANTHROPIC_BASE_URL", `${PROXY}/anthropic/v1`)
        Env.set("OPENAI_API_KEY", "thk_openai")
        Env.set("OPENAI_BASE_URL", `${PROXY}/openai/v1`)
        Env.set("GOOGLE_GENERATIVE_AI_API_KEY", "thk_google")
        Env.set("GOOGLE_GENERATIVE_AI_BASE_URL", `${PROXY}/gemini/v1beta`)
        Env.set("OPENROUTER_API_KEY", "thk_openrouter")
        Env.set("OPENROUTER_BASE_URL", `${PROXY}/openrouter/v1`)
        Env.set("META_MODEL_API_KEY", "thk_meta")
        Env.set("META_MODEL_BASE_URL", `${PROXY}/meta/v1`)
        Provider.invalidate()
      },
      fn: async () => {
        const providers = await Provider.list()
        expect(providers["openrouter"]).toBeDefined()
        expect(providers["openrouter"].options.baseURL).toBe(`${PROXY}/openrouter/v1`)
        expect(providers["meta"]).toBeUndefined()
        expect(providers["anthropic"]).toBeUndefined()
        expect(providers["openai"]).toBeUndefined()
        expect(providers["google"]).toBeUndefined()
      },
    })
  })

  test("the retired hosted provider never loads from catalog env or config", async () => {
    await using tmp = await tmpdir({
      config: {
        provider: {
          synsci: {
            options: { apiKey: "legacy-config-key" },
            models: { demo: { name: "Retired demo" } },
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        clearManagedLLMEnv()
        Env.set("SYNSCI_API_KEY", "legacy-env-key")
        Provider.invalidate()
      },
      fn: async () => {
        expect((await Provider.list())["synsci"]).toBeUndefined()
        await expect(Provider.getModel("synsci", "demo")).rejects.toThrow()
      },
    })
  })

  test("managed direct model selections resolve to OpenRouter vendor slugs", async () => {
    await using tmp = await tmpdir({
      config: {
        billing: { llm: "managed" },
        provider: {
          openrouter: {
            whitelist: ["anthropic/claude-sonnet-5", "google/gemini-3.6-flash", "x-ai/grok-4.5", "meta/muse-spark-1.1"],
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        clearManagedLLMEnv()
        Env.set("OPENROUTER_API_KEY", "thk_openrouter")
        Env.set("OPENROUTER_BASE_URL", `${PROXY}/openrouter/v1`)
        Provider.invalidate()
      },
      fn: async () => {
        const sonnet = await Provider.getModel("anthropic", "claude-sonnet-5")
        expect(sonnet.providerID).toBe("openrouter")
        expect(sonnet.id).toBe("anthropic/claude-sonnet-5")

        const gemini = await Provider.getModel("gemini", "gemini-3.6-flash")
        expect(gemini.providerID).toBe("openrouter")
        expect(gemini.id).toBe("google/gemini-3.6-flash")

        const grok = await Provider.getModel("xai", "grok-4.5")
        expect(grok.providerID).toBe("openrouter")
        expect(grok.id).toBe("x-ai/grok-4.5")

        const muse = await Provider.getModel("meta", "muse-spark-1.1")
        expect(muse.providerID).toBe("openrouter")
        expect(muse.id).toBe("meta/muse-spark-1.1")
      },
    })
  })

  test("managed OpenRouter self-heals a key-only synced env snapshot", async () => {
    await using tmp = await tmpdir({
      config: {
        billing: { llm: "managed" },
        provider: {
          openrouter: {
            whitelist: ["anthropic/claude-sonnet-4.6"],
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        clearManagedLLMEnv()
        Env.set("OPENROUTER_API_KEY", "thk_openrouter")
        Provider.invalidate()
      },
      fn: async () => {
        const providers = await Provider.list()
        const openrouter = providers["openrouter"]
        expect(openrouter).toBeDefined()
        expect(openrouter.options.apiKey).toStartWith("thk_")
        expect(openrouter.options.baseURL).toBe(`${PROXY}/openrouter/v1`)

        const model = await Provider.getModel("openrouter", "anthropic/claude-sonnet-4.6")
        await expect(Provider.getLanguage(model)).resolves.toBeDefined()
      },
    })
  })

  test("Fable is available through managed OpenRouter and direct Anthropic routes", async () => {
    await using managed = await tmpdir({
      config: {
        billing: { llm: "managed" },
        provider: {
          openrouter: {
            whitelist: ["anthropic/claude-fable-5", "anthropic/claude-sonnet-5"],
          },
        },
      },
    })
    await Instance.provide({
      directory: managed.path,
      init: async () => {
        clearManagedLLMEnv()
        Env.set("OPENROUTER_API_KEY", "thk_openrouter")
        Env.set("OPENROUTER_BASE_URL", `${PROXY}/openrouter/v1`)
        Provider.invalidate()
      },
      fn: async () => {
        const openrouter = (await Provider.list())["openrouter"]
        expect(openrouter.models["anthropic/claude-fable-5"]).toBeDefined()
        expect(openrouter.models["anthropic/claude-sonnet-5"]).toBeDefined()
        await expect(Provider.getModel("openrouter", "anthropic/claude-fable-5")).resolves.toBeDefined()
      },
    })

    await using byok = await tmpdir({ config: { billing: { llm: "byok" } } })
    await Instance.provide({
      directory: byok.path,
      init: async () => {
        clearManagedLLMEnv()
        Env.set("ANTHROPIC_API_KEY", "sk-ant-byok-key")
        Provider.invalidate()
      },
      fn: async () => {
        const anthropic = (await Provider.list())["anthropic"]
        expect(anthropic).toBeDefined()
        expect(anthropic.models["claude-fable-5"]).toBeDefined()
        expect(anthropic.models["claude-sonnet-5"]).toBeDefined()
      },
    })
  })

  test("unhealthy managed OpenRouter slugs are hidden from stale synced catalogs", async () => {
    await using tmp = await tmpdir({
      config: {
        billing: { llm: "managed" },
        provider: {
          openrouter: {
            whitelist: ["mistralai/mistral-small-3.2-24b-instruct", "mistralai/mistral-medium-3.1"],
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        clearManagedLLMEnv()
        Env.set("OPENROUTER_API_KEY", "thk_openrouter")
        Env.set("OPENROUTER_BASE_URL", `${PROXY}/openrouter/v1`)
        Provider.invalidate()
      },
      fn: async () => {
        const openrouter = (await Provider.list())["openrouter"]
        expect(openrouter.models["mistralai/mistral-small-3.2-24b-instruct"]).toBeUndefined()
        expect(openrouter.models["mistralai/mistral-medium-3.1"]).toBeDefined()
        await expect(Provider.getModel("openrouter", "mistralai/mistral-small-3.2-24b-instruct")).rejects.toThrow()
      },
    })
  })

  test("Meta BYOK overrides a path-prefixed stale managed proxy and bypasses the managed whitelist", async () => {
    await using tmp = await tmpdir({
      config: {
        billing: { llm: "byok" },
        provider: { meta: { whitelist: ["not-the-muse-model"] } },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        clearManagedLLMEnv()
        Env.set("META_MODEL_API_KEY", "meta-user-owned")
        Env.set("META_MODEL_BASE_URL", "https://atlas.example/control/api/llm/proxy/meta/v1")
        Provider.invalidate()
      },
      fn: async () => {
        const meta = (await Provider.list())["meta"]
        expect(meta).toBeDefined()
        expect(meta.options.apiKey).toBe("meta-user-owned")
        expect(meta.options.baseURL).toBe("https://api.meta.ai/v1")
        expect(meta.models["muse-spark-1.1"]).toBeDefined()
      },
    })
  })

  test("BYOK (managed off): anthropic keeps its public endpoint and no wallet token", async () => {
    await using tmp = await tmpdir({ config: { billing: { llm: "byok" } } })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        clearManagedLLMEnv()
        Env.set("ANTHROPIC_API_KEY", "sk-ant-byok-key")
        Provider.invalidate()
      },
      fn: async () => {
        const providers = await Provider.list()
        const anthropic = providers["anthropic"]
        expect(anthropic).toBeDefined()
        // No Atlas proxy baseURL injected → getSDK falls back to the public
        // model.api.url; the BYOK key is the only credential.
        expect(anthropic.options.baseURL).toBeUndefined()
        expect(anthropic.options.apiKey).toBeUndefined()
        expect(anthropic.key).toBe("sk-ant-byok-key")
      },
    })
  })

  test("legacy auto-detect rejects every non-OpenRouter thk_ proxy while keeping managed OpenRouter", async () => {
    await using tmp = await tmpdir({
      config: {
        provider: {
          xai: { options: { baseURL: `${PROXY}/xai/v1` } },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        clearManagedLLMEnv()
        Env.set("ANTHROPIC_API_KEY", "thk_anthropic")
        Env.set("ANTHROPIC_BASE_URL", `${PROXY}/anthropic/v1`)
        Env.set("OPENAI_API_KEY", "thk_openai")
        Env.set("OPENAI_BASE_URL", `${PROXY}/openai/v1`)
        Env.set("GOOGLE_GENERATIVE_AI_API_KEY", "thk_google")
        Env.set("GOOGLE_GENERATIVE_AI_BASE_URL", `${PROXY}/gemini/v1beta`)
        Env.set("META_MODEL_API_KEY", "thk_meta")
        Env.set("META_MODEL_BASE_URL", `${PROXY}/meta/v1`)
        Env.set("OPENROUTER_API_KEY", "thk_openrouter")
        Env.set("OPENROUTER_BASE_URL", `${PROXY}/openrouter/v1`)
        Provider.invalidate()
      },
      fn: async () => {
        const providers = await Provider.list()
        expect(providers["anthropic"]).toBeUndefined()
        expect(providers["openai"]).toBeUndefined()
        expect(providers["google"]).toBeUndefined()
        expect(providers["meta"]).toBeUndefined()
        // A stale Atlas proxy is itself a managed route, even if its paired
        // thk_* env value was lost from an old sync snapshot.
        expect(providers["xai"]).toBeUndefined()
        expect(providers["openrouter"]).toBeDefined()
        expect(providers["openrouter"].options.baseURL).toBe(`${PROXY}/openrouter/v1`)
      },
    })
  })

  test("legacy auto-detect still preserves explicit OAuth, Codex OAuth, and localhost routes", async () => {
    const previousAnthropic = await Auth.get("anthropic")
    const previousCodex = await Auth.get("openai-codex")
    await Auth.set("anthropic", {
      type: "oauth",
      refresh: "anthropic-refresh",
      access: "anthropic-access",
      expires: Date.now() + 60_000,
    })
    await Auth.set("openai-codex", {
      type: "oauth",
      refresh: "codex-refresh",
      access: "codex-access",
      expires: Date.now() + 60_000,
    })
    await using tmp = await tmpdir({
      config: {
        provider: {
          "openai-codex": {},
          ollama: {
            name: "Ollama (local)",
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "http://localhost:11434/v1", apiKey: "local" },
            models: { "llama3.1": { name: "llama3.1", limit: { context: 8192, output: 2048 } } },
          },
        },
      },
    })
    try {
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          clearManagedLLMEnv()
          // A stale sync value beside an explicit OAuth record must not hide
          // that user's direct subscription route.
          Env.set("ANTHROPIC_API_KEY", "thk_stale_anthropic")
          Env.set("ANTHROPIC_BASE_URL", `${PROXY}/anthropic/v1`)
          Env.set("OPENAI_API_KEY", "thk_stale_openai")
          Env.set("OPENAI_BASE_URL", `${PROXY}/openai/v1`)
          Provider.invalidate()
        },
        fn: async () => {
          const providers = await Provider.list()
          expect(providers["anthropic"]).toBeDefined()
          expect(providers["anthropic"].options.baseURL).toBeUndefined()
          expect(Provider.effectiveKey(providers["anthropic"])).toBeUndefined()
          expect(providers["openai-codex"]).toBeDefined()
          expect(providers["ollama"]).toBeDefined()
          expect(providers["openai"]).toBeUndefined()
        },
      })
    } finally {
      if (previousAnthropic) await Auth.set("anthropic", previousAnthropic)
      else await Auth.remove("anthropic")
      if (previousCodex) await Auth.set("openai-codex", previousCodex)
      else await Auth.remove("openai-codex")
      Provider.invalidate()
    }
  })
})

// ── billing.llm gates the own-key vs managed-proxy route (1a/1b/1c) ─────────

/** Auth.json lives outside the per-test tmp project (it's keyed by XDG dirs
 *  isolated for the whole test *run*, not per test) — set and restore it like
 *  provider.test.ts's Codex OAuth cases so a stored own key never leaks
 *  across tests. */
async function withOpenRouterOwnKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = await Auth.get("openrouter")
  await Auth.set("openrouter", { type: "api", key })
  try {
    return await fn()
  } finally {
    if (previous) await Auth.set("openrouter", previous)
    else await Auth.remove("openrouter")
  }
}

describe("billing.llm gates OpenRouter's own-key vs managed-proxy route (1a/1b/1c)", () => {
  test('managed: a stored own key is overridden — routes to the Atlas proxy with the thk_ token, and reports source "managed"; the own key is untouched in auth', async () => {
    await withOpenRouterOwnKey("sk-or-own-key", async () => {
      await using tmp = await tmpdir({ config: { billing: { llm: "managed" } } })
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          clearManagedLLMEnv()
          Env.set("OPENROUTER_API_KEY", "thk_openrouter")
          Env.set("OPENROUTER_BASE_URL", `${PROXY}/openrouter/v1`)
          Provider.invalidate()
        },
        fn: async () => {
          const openrouter = (await Provider.list())["openrouter"]
          expect(openrouter).toBeDefined()
          // 1a: managed spend wins over the stored own key — Atlas proxy, thk_ token.
          expect(openrouter.options.baseURL).toBe(`${PROXY}/openrouter/v1`)
          expect(openrouter.options.baseURL).not.toBe("https://openrouter.ai/api/v1")
          expect(openrouter.options.apiKey).toBe("thk_openrouter")
          expect(openrouter.options.apiKey).not.toBe("sk-or-own-key")
          // 1b: the managed route reports its true source.
          expect(openrouter.source).toBe("managed")
        },
      })
      // 1a: the own key is retained (never deleted/rewritten), just unused.
      expect(await Auth.get("openrouter")).toEqual({ type: "api", key: "sk-or-own-key" })
    })
  })

  test("managed with no managed credential fails closed instead of charging an OpenRouter own key", async () => {
    await withOpenRouterOwnKey("sk-or-own-key", async () => {
      await using tmp = await tmpdir({
        config: {
          billing: { llm: "managed" },
          provider: { openrouter: { whitelist: ["anthropic/claude-sonnet-5"] } },
        },
      })
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          clearManagedLLMEnv()
          Provider.invalidate()
        },
        fn: async () => {
          expect((await Provider.list())["openrouter"]).toBeUndefined()
        },
      })
      // The account key remains stored and becomes usable again after the user
      // switches to Accounts or Automatic; Credits never spends it silently.
      expect(await Auth.get("openrouter")).toEqual({ type: "api", key: "sk-or-own-key" })
    })
  })

  test("managed leaves a local provider alone even though its key reads as BYOK", async () => {
    // Ollama's config block carries `apiKey: "local"`, which is a non-managed,
    // non-"public" credential and therefore BYOK by isByokKey. It runs on the
    // user's own hardware and is free, so the managed guard must not reach it —
    // the same exemption isProviderAllowed already makes.
    await using tmp = await tmpdir({
      config: {
        billing: { llm: "managed" },
        provider: {
          ollama: {
            name: "Ollama (local)",
            npm: "@ai-sdk/openai-compatible",
            options: { baseURL: "http://localhost:11434/v1", apiKey: "local" },
            models: { "llama3.1": { name: "llama3.1", limit: { context: 8192, output: 2048 } } },
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        clearManagedLLMEnv()
        Provider.invalidate()
      },
      fn: async () => {
        expect((await Provider.list())["ollama"]).toBeDefined()
      },
    })
  })

  test("auto-detect (billing.llm unset) with a stored own key and no managed credential keeps the provider — the guard is opt-in only", async () => {
    // The legacy path this fix must not touch: identical to the managed case
    // above except billing.llm is unset. Nothing is dropped, and the own key
    // still routes to public OpenRouter.
    await withOpenRouterOwnKey("sk-or-own-key", async () => {
      await using tmp = await tmpdir({
        config: { provider: { openrouter: { whitelist: ["anthropic/claude-sonnet-5"] } } },
      })
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          clearManagedLLMEnv()
          Provider.invalidate()
        },
        fn: async () => {
          const openrouter = (await Provider.list())["openrouter"]
          expect(openrouter).toBeDefined()
          expect(openrouter.options.apiKey).toBe("sk-or-own-key")
          expect(openrouter.options.baseURL).toBe("https://openrouter.ai/api/v1")
        },
      })
    })
  })

  test('byok: a stored own key routes to public OpenRouter and reports source "api" (regression guard for 1c)', async () => {
    await withOpenRouterOwnKey("sk-or-own-key", async () => {
      // config.provider.openrouter must be genuinely present (here, via a
      // synced whitelist) for this to actually exercise 1c — otherwise the
      // "load config" loop never iterates openrouter at all and this test
      // would pass even without the 1c fix.
      await using tmp = await tmpdir({
        config: {
          billing: { llm: "byok" },
          provider: { openrouter: { whitelist: ["anthropic/claude-sonnet-5"] } },
        },
      })
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          clearManagedLLMEnv()
          Provider.invalidate()
        },
        fn: async () => {
          const openrouter = (await Provider.list())["openrouter"]
          expect(openrouter).toBeDefined()
          expect(openrouter.options.apiKey).toBe("sk-or-own-key")
          expect(openrouter.options.baseURL).toBe("https://openrouter.ai/api/v1")
          expect(openrouter.source).toBe("api")
        },
      })
    })
  })

  test("auto-detect (billing.llm unset): a stored own key still wins — unchanged from today's behaviour", async () => {
    await withOpenRouterOwnKey("sk-or-own-key", async () => {
      await using tmp = await tmpdir({ config: {} })
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          clearManagedLLMEnv()
          Provider.invalidate()
        },
        fn: async () => {
          const openrouter = (await Provider.list())["openrouter"]
          expect(openrouter).toBeDefined()
          expect(openrouter.options.apiKey).toBe("sk-or-own-key")
          expect(openrouter.options.baseURL).toBe("https://openrouter.ai/api/v1")
          expect(openrouter.source).toBe("api")
        },
      })
    })
  })

  test('auto-detect (billing.llm unset) with a synced thk_ token and no own key genuinely IS managed — source "managed" and Inference.classify "managed", not "unknown"', async () => {
    await using tmp = await tmpdir({ config: {} })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        clearManagedLLMEnv()
        Env.set("OPENROUTER_API_KEY", "thk_openrouter")
        Env.set("OPENROUTER_BASE_URL", `${PROXY}/openrouter/v1`)
        Provider.invalidate()
      },
      fn: async () => {
        const openrouter = (await Provider.list())["openrouter"]
        expect(openrouter).toBeDefined()
        expect(openrouter.options.apiKey).toBe("thk_openrouter")
        expect(openrouter.options.baseURL).toBe(`${PROXY}/openrouter/v1`)
        expect(openrouter.source).toBe("managed")

        // Feed the REAL provider.source this fixture produced straight into
        // classify — not Inference.resolve(), whose baseURL fallback would
        // resolve through this test harness's loopback OPENSCIENCE_API_BASE
        // (test/preload.ts) and get short-circuited by the unrelated
        // local()-heuristic before ever reaching the providerSource check.
        expect(Inference.classify({ providerID: "openrouter", providerSource: openrouter.source })).toBe("managed")
      },
    })
  })

  test('1c must not overshoot: a provider whose key genuinely comes from config.provider still reports source "config"', async () => {
    // No env var, no stored auth key, no billing toggle — OpenRouter's own
    // custom loader declines to register the provider (nothing to route
    // with), so the config loop below is the FIRST and only stage to claim
    // it. That's the "genuinely config" case the asymmetry note describes.
    await using tmp = await tmpdir({
      config: {
        provider: {
          openrouter: {
            options: { apiKey: "config-owned-key" },
          },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        clearManagedLLMEnv()
        Provider.invalidate()
      },
      fn: async () => {
        const openrouter = (await Provider.list())["openrouter"]
        expect(openrouter).toBeDefined()
        expect(openrouter.options.apiKey).toBe("config-owned-key")
        expect(openrouter.source).toBe("config")
      },
    })
  })

  test('1c must not overshoot the other way: an env-registered provider that also appears in config.provider (for its whitelist) keeps source "env"', async () => {
    await using tmp = await tmpdir({
      config: {
        provider: { anthropic: { whitelist: ["claude-sonnet-4-6"] } },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        clearManagedLLMEnv()
        Env.set("ANTHROPIC_API_KEY", "sk-ant-env-key")
        Provider.invalidate()
      },
      fn: async () => {
        const anthropic = (await Provider.list())["anthropic"]
        expect(anthropic).toBeDefined()
        expect(anthropic.key).toBe("sk-ant-env-key")
        // The config entry only supplies a whitelist — the credential is genuinely env's.
        expect(anthropic.source).toBe("env")
      },
    })
  })

  test('1c (narrowed): an autoloaded custom-loader provider that also appears in config.provider (for its whitelist) still reports source "config", not "custom"', async () => {
    // google-vertex autoloads off GOOGLE_CLOUD_PROJECT alone (no auth.json
    // entry). This fixture clears its catalog `env` list below so unrelated
    // ambient Vertex credentials cannot let the "load env" stage claim it.
    // CUSTOM_LOADERS is the first and only stage to register it, with
    // source "custom" — exactly the loader-assigned (not credential-derived)
    // case 1c must keep overwriting to "config" when a config.provider entry
    // exists, per the narrowed protected set (env/api/managed only).
    await using tmp = await tmpdir({
      config: {
        provider: {
          // Keep this provenance fixture hermetic when another suite case has
          // installed a real Vertex credential in the process environment.
          // GOOGLE_CLOUD_PROJECT still drives the custom-loader autoload below;
          // an empty catalog env list ensures only that loader claims it first.
          "google-vertex": { env: [], whitelist: ["gemini-3.5-flash"] },
        },
      },
    })
    await Instance.provide({
      directory: tmp.path,
      init: async () => {
        clearManagedLLMEnv()
        Env.set("GOOGLE_CLOUD_PROJECT", "test-project")
        Provider.invalidate()
      },
      fn: async () => {
        try {
          const vertex = (await Provider.list())["google-vertex"]
          expect(vertex).toBeDefined()
          expect(vertex.source).toBe("config")
        } finally {
          Env.remove("GOOGLE_CLOUD_PROJECT")
        }
      },
    })
  })
})

// ── settings/billing.ts PUT invalidates the provider cache at runtime (2a) ──

describe("billing PUT invalidates the provider cache — no restart needed", () => {
  test("switching managed -> byok through the real route drops the thk_-keyed OpenRouter provider from the very next Provider.list()", async () => {
    await using tmp = await tmpdir({ config: {} })
    let disposed = 0
    const runtimeState = Instance.state(
      () => ({}),
      async () => {
        disposed++
      },
    )
    try {
      // Seed env once so the instance exists and OPENROUTER_* is in place -
      // mirrors a project a user already has open before touching Settings.
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          clearManagedLLMEnv()
          Env.set("OPENROUTER_API_KEY", "thk_openrouter")
          Env.set("OPENROUTER_BASE_URL", `${PROXY}/openrouter/v1`)
        },
        fn: async () => {
          runtimeState()
        },
      })

      // settings/billing.ts is mounted OUTSIDE the Instance.provide wrapper
      // (see server.ts) - it never runs with an ambient project directory in
      // production, so drive it the same way here rather than nesting it
      // inside an Instance.provide() call.
      const toManaged = await BillingSettingsRoutes().request("/", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ llm: "managed" }),
      })
      expect(toManaged.status).toBe(200)

      // The next request for this project (a fresh Instance.provide(), just
      // like a real incoming chat/inference call) sees it immediately.
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const before = (await Provider.list())["openrouter"]
          expect(before).toBeDefined()
          expect(before.source).toBe("managed")
        },
      })

      // Flip to byok through the same route. The guard at provider.ts:1585
      // drops any provider whose effective credential is a managed thk_
      // token once byok is explicit — so openrouter must be gone on the
      // very next Provider.list() call, with no process restart and no
      // manual Provider.invalidate() from the test itself (the route is
      // responsible for that now).
      const toByok = await BillingSettingsRoutes().request("/", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ llm: "byok" }),
      })
      expect(toByok.status).toBe(200)

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const after = await Provider.list()
          expect(after["openrouter"]).toBeUndefined()
        },
      })
      expect(disposed).toBe(0)
    } finally {
      // The route writes to the GLOBAL config (not the tmpdir project config
      // every other test in this file relies on) - remove all three
      // candidate filenames Config.updateGlobal's globalConfigFile() can
      // pick (see config.ts) and reset the in-memory Config.global cache, so
      // a later test in this file (or a later file in the same `bun test`
      // run) does not inherit a flipped mode or a stray file that shadows
      // another candidate.
      for (const name of ["openscience.json", "openscience.jsonc", "config.json"]) {
        await fs.rm(path.join(Global.Path.config, name), { force: true }).catch(() => {})
      }
      Config.global.reset()
    }
  })
})

// ── the invalidation must precede the announcement, not follow it ────────────

describe("global config writes invalidate the provider cache before announcing", () => {
  test("a listener that refetches on global.disposed sees the map rebuilt under the new config", async () => {
    await using tmp = await tmpdir({ config: {} })
    let disposed = 0
    const runtimeState = Instance.state(
      () => ({}),
      async () => {
        disposed++
      },
    )
    try {
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          clearManagedLLMEnv()
          Env.set("OPENROUTER_API_KEY", "thk_openrouter")
          Env.set("OPENROUTER_BASE_URL", `${PROXY}/openrouter/v1`)
          Env.set("ANTHROPIC_API_KEY", "sk-ant-byok-key")
          Provider.invalidate()
        },
        fn: async () => {
          const activeRuntime = runtimeState()
          // Prime the module-level memo the way a long-running server has it
          // primed before the user ever opens Settings.
          expect((await Provider.list())["anthropic"]).toBeDefined()

          const pending = PermissionNext.ask({
            id: "permission_config_refresh",
            sessionID: "session_config_refresh",
            permission: "bash",
            patterns: ["ls"],
            metadata: {},
            always: [],
            ruleset: [{ permission: "bash", pattern: "*", action: "ask" }],
          }).catch((error) => error)

          // Stand in for the SPA's `global.disposed` handler, which fires
          // GET /provider the moment the event arrives. GlobalBus.emit
          // dispatches synchronously, so this listener runs at exactly the
          // point inside disposeGlobalInstances() where the announcement
          // happens — the narrowest possible version of the real window.
          let observed: ReturnType<typeof Provider.list> | undefined
          const listener = (e: { payload?: { type?: string } }) => {
            if (e.payload?.type !== "global.disposed") return
            observed = Provider.list()
          }
          GlobalBus.on("event", listener)
          try {
            await Config.updateGlobal({ billing: { llm: "managed" } })
          } finally {
            GlobalBus.off("event", listener)
          }

          const request = (await PermissionNext.list()).find((item) => item.id === "permission_config_refresh")
          if (request) await PermissionNext.reply({ requestID: request.id, reply: "reject" })
          const pendingResult = await pending

          expect(observed).toBeDefined()
          // The map is rebuilt before announcement: direct Anthropic stays
          // direct while the managed credit-spending route is OpenRouter.
          const refetched = await observed!
          expect(refetched["anthropic"]).toBeDefined()
          expect(refetched["anthropic"].source).toBe("env")
          expect(refetched["openrouter"]).toBeDefined()
          expect(refetched["openrouter"].source).toBe("managed")
          expect(runtimeState()).toBe(activeRuntime)
          expect(disposed).toBe(0)
          expect(request).toBeDefined()
          expect(pendingResult).toBeInstanceOf(PermissionNext.RejectedError)
        },
      })
    } finally {
      for (const name of ["openscience.json", "openscience.jsonc", "config.json"]) {
        await fs.rm(path.join(Global.Path.config, name), { force: true }).catch(() => {})
      }
      Config.global.reset()
      Provider.invalidate()
    }
  })

  test("a global write with no route behind it (replaceGlobal) invalidates on its own", async () => {
    await using tmp = await tmpdir({ config: {} })
    try {
      await Instance.provide({
        directory: tmp.path,
        init: async () => {
          clearManagedLLMEnv()
          Env.set("OPENROUTER_API_KEY", "thk_openrouter")
          Env.set("OPENROUTER_BASE_URL", `${PROXY}/openrouter/v1`)
          Env.set("ANTHROPIC_API_KEY", "sk-ant-byok-key")
          Provider.invalidate()
        },
        fn: async () => {
          expect((await Provider.list())["anthropic"]).toBeDefined()

          // replaceGlobal has no HTTP route and no caller anywhere that
          // follows it with Provider.invalidate() — so this passes only if
          // the write itself carries the invalidation. Per-call-site patching
          // cannot make it pass; nothing here is racing anything.
          await Config.replaceGlobal(
            JSON.stringify({
              $schema: "https://syntheticsciences.ai/config.json",
              billing: { llm: "managed" },
            }),
          )

          const after = await Provider.list()
          expect(after["anthropic"]).toBeDefined()
          expect(after["anthropic"].source).toBe("env")
          expect(after["openrouter"]).toBeDefined()
          expect(after["openrouter"].source).toBe("managed")
        },
      })
    } finally {
      for (const name of ["openscience.json", "openscience.jsonc", "config.json"]) {
        await fs.rm(path.join(Global.Path.config, name), { force: true }).catch(() => {})
      }
      Config.global.reset()
      Provider.invalidate()
    }
  })

  test("runtime-affecting global patches still rebuild project instances", async () => {
    await using tmp = await tmpdir({ config: {} })
    let disposed = 0
    const runtimeState = Instance.state(
      () => ({}),
      async () => {
        disposed++
      },
    )
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          runtimeState()
          await Config.updateGlobal({ plugin: [] })
          expect(disposed).toBe(1)
        },
      })
    } finally {
      for (const name of ["openscience.json", "openscience.jsonc", "config.json"]) {
        await fs.rm(path.join(Global.Path.config, name), { force: true }).catch(() => {})
      }
      Config.global.reset()
      Provider.invalidate()
    }
  })
})

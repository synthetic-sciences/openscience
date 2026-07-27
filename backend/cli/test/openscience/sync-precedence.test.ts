import { test, expect, afterEach } from "bun:test"
import path from "path"
import { OpenScience } from "../../src/openscience"
import { Global } from "../../src/global"
import { managedApiBase } from "../../src/endpoints"

// syncServices must respect credential precedence: a user's own shell-exported
// (or BYOK) OpenRouter key must survive a background sync — never be overwritten
// with a managed thk_ value, which would silently turn a free BYOK call into a
// billed managed one (the "billing flip" bug).
//
// OpenRouter is the only provider Atlas sync may deliver a managed credential
// for; every other model provider is BYOK-local-only, so its synced credential is dropped
// (see synced-env-policy.ts) — Atlas still emits them for the hosted web agents.

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env["OPENROUTER_API_KEY"]
  delete process.env["ANTHROPIC_API_KEY"]
  delete process.env["META_MODEL_API_KEY"]
  delete process.env["META_MODEL_BASE_URL"]
})

async function seedSession() {
  await Bun.write(
    path.join(Global.Path.data, "openscience-session.json"),
    JSON.stringify({ api_key: "thk_test.secret", user_id: "u1", device_name: "test" }),
  )
}

function stubSync(services: Record<string, Record<string, string>>) {
  globalThis.fetch = (async (url: string | URL) => {
    if (String(url).includes("/api/cli/sync")) {
      const svc = Object.fromEntries(Object.entries(services).map(([id, env]) => [id, { connected: true, env }]))
      return Response.json({ user: {}, services: svc, config: null })
    }
    return new Response("{}", { status: 200 })
  }) as unknown as typeof fetch
}

test("a user's exported OpenRouter key is NOT clobbered by a synced managed key", async () => {
  await seedSession()
  process.env["OPENROUTER_API_KEY"] = "sk-or-user-own-key"
  stubSync({
    openrouter: {
      OPENROUTER_API_KEY: "thk_managed.value",
      OPENROUTER_BASE_URL: "https://app.syntheticsciences.ai/api/llm/proxy/openrouter/v1",
    },
  })
  await OpenScience.syncServices()
  expect(process.env["OPENROUTER_API_KEY"]).toBe("sk-or-user-own-key")
})

test("a synced managed OpenRouter key IS applied when the slot is empty", async () => {
  await seedSession()
  delete process.env["OPENROUTER_API_KEY"]
  stubSync({ openrouter: { OPENROUTER_API_KEY: "thk_managed.value" } })
  await OpenScience.syncServices()
  expect(process.env["OPENROUTER_API_KEY"]).toBe("thk_managed.value")
})

test("Meta sync is dropped even when it looks like an old managed route", async () => {
  await seedSession()
  const proxyURL = `${managedApiBase()}/api/llm/proxy/meta/v1`
  stubSync({
    meta: {
      META_MODEL_API_KEY: "thk_managed.value",
      META_MODEL_BASE_URL: proxyURL,
    },
  })
  await OpenScience.syncServices()
  expect(process.env["META_MODEL_API_KEY"]).toBeUndefined()
  expect(process.env["META_MODEL_BASE_URL"]).toBeUndefined()
})

test("Meta sync rejects an upstream shared key or public endpoint", async () => {
  await seedSession()
  stubSync({
    meta: {
      META_MODEL_API_KEY: "meta-shared-secret",
      META_MODEL_BASE_URL: "https://api.meta.ai/v1",
    },
  })
  await OpenScience.syncServices()
  expect(process.env["META_MODEL_API_KEY"]).toBeUndefined()
  expect(process.env["META_MODEL_BASE_URL"]).toBeUndefined()
})

test("a synced non-OpenRouter LLM key is dropped — those providers are BYOK-local-only", async () => {
  await seedSession()
  delete process.env["ANTHROPIC_API_KEY"]
  stubSync({ anthropic: { ANTHROPIC_API_KEY: "thk_managed.value" } })
  await OpenScience.syncServices()
  expect(process.env["ANTHROPIC_API_KEY"]).toBeUndefined()
})

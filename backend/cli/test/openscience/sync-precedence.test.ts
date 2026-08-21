import { test, expect, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { OpenScience } from "../../src/openscience"
import { Global } from "../../src/global"
import { managedApiBase } from "../../src/endpoints"
import { managedOpenRouterBaseURL } from "../../src/openscience/synced-env-policy"

// syncServices must respect credential precedence: a user's own shell-exported
// (or BYOK) OpenRouter key must survive a background sync — never be overwritten
// with a managed thk_ value, which would silently turn a free BYOK call into a
// billed managed one (the "billing flip" bug).
//
// OpenRouter is the only provider Atlas sync may deliver a managed credential
// for. User-owned direct-provider keys may sync, but scoped thk_ credentials
// and provider base URLs are rejected (see synced-env-policy.ts).

const realFetch = globalThis.fetch
afterEach(async () => {
  const gcp = process.env["GOOGLE_APPLICATION_CREDENTIALS"]
  globalThis.fetch = realFetch
  delete process.env["OPENROUTER_API_KEY"]
  delete process.env["OPENROUTER_BASE_URL"]
  delete process.env["ANTHROPIC_API_KEY"]
  delete process.env["META_MODEL_API_KEY"]
  delete process.env["META_MODEL_BASE_URL"]
  delete process.env["AWS_ACCESS_KEY_ID"]
  delete process.env["AWS_SECRET_ACCESS_KEY"]
  delete process.env["GITHUB_TOKEN"]
  delete process.env["GH_TOKEN"]
  delete process.env["GOOGLE_APPLICATION_CREDENTIALS"]
  delete process.env["GOOGLE_CLOUD_PROJECT"]
  if (gcp) await fs.rm(gcp, { force: true })
  await fs.rm(path.join(Global.Path.data, "openscience-session.json"), { force: true })
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
  expect(process.env["OPENROUTER_BASE_URL"]).toBe(managedOpenRouterBaseURL())
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

test("Meta sync transfers a user-owned key but rejects its base URL", async () => {
  await seedSession()
  stubSync({
    meta: {
      META_MODEL_API_KEY: "meta-shared-secret",
      META_MODEL_BASE_URL: "https://api.meta.ai/v1",
    },
  })
  await OpenScience.syncServices()
  expect(process.env["META_MODEL_API_KEY"]).toBe("meta-shared-secret")
  expect(process.env["META_MODEL_BASE_URL"]).toBeUndefined()
})

test("a synced direct-provider managed token is dropped", async () => {
  await seedSession()
  delete process.env["ANTHROPIC_API_KEY"]
  stubSync({ anthropic: { ANTHROPIC_API_KEY: "thk_managed.value" } })
  await OpenScience.syncServices()
  expect(process.env["ANTHROPIC_API_KEY"]).toBeUndefined()
})

test("a synced Codex availability marker is never used as a public OpenAI API key", async () => {
  await seedSession()
  delete process.env["OPENAI_API_KEY"]
  stubSync({ openai: { OPENAI_API_KEY: "thk-codex-oauth-placeholder" } })
  await OpenScience.syncServices()
  expect(process.env["OPENAI_API_KEY"]).toBeUndefined()
})

test("a synced direct-provider BYOK key transfers when the slot is empty", async () => {
  await seedSession()
  delete process.env["ANTHROPIC_API_KEY"]
  stubSync({ anthropic: { ANTHROPIC_API_KEY: "sk-ant-user-owned" } })
  await OpenScience.syncServices()
  expect(process.env["ANTHROPIC_API_KEY"]).toBe("sk-ant-user-owned")
})

test("synced compute and integration credentials reach approved agent subprocesses", async () => {
  await seedSession()
  stubSync({
    aws: {
      AWS_ACCESS_KEY_ID: "AKIAUSER",
      AWS_SECRET_ACCESS_KEY: "aws-user-secret",
    },
    github: {
      GITHUB_TOKEN: "github-user-token",
      GH_TOKEN: "github-user-token",
    },
  })
  await OpenScience.syncServices()
  const env = OpenScience.filterEnvForSubprocess(process.env)
  expect(env.AWS_ACCESS_KEY_ID).toBe("AKIAUSER")
  expect(env.AWS_SECRET_ACCESS_KEY).toBe("aws-user-secret")
  expect(env.GITHUB_TOKEN).toBe("github-user-token")
  expect(env.GH_TOKEN).toBe("github-user-token")
})

test("synced GCP JSON is materialized owner-only and exposed by standard path", async () => {
  await seedSession()
  const value = JSON.stringify({ project_id: "atlas-test", private_key: "gcp-secret" })
  stubSync({ gcp: { GOOGLE_APPLICATION_CREDENTIALS_JSON: value, GOOGLE_CLOUD_PROJECT: "atlas-test" } })
  await OpenScience.syncServices()
  const file = process.env["GOOGLE_APPLICATION_CREDENTIALS"]
  expect(file).toBeTruthy()
  if (!file) throw new Error("GCP credentials path was not materialized")
  expect(await Bun.file(file).text()).toBe(value)
  if (process.platform !== "win32") expect((await fs.stat(file)).mode & 0o777).toBe(0o600)
  const env = OpenScience.filterEnvForSubprocess(process.env)
  expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBe(file)
  expect(env.GOOGLE_CLOUD_PROJECT).toBe("atlas-test")
  expect(env.GOOGLE_APPLICATION_CREDENTIALS_JSON).toBeUndefined()
})

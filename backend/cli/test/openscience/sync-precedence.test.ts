import { test, expect, afterEach } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { OpenScience } from "../../src/openscience"
import { Global } from "../../src/global"
import { managedApiBase } from "../../src/endpoints"
import { managedOpenRouterBaseURL, RETIRED_SYNCED_COMPUTE_ENV_KEYS } from "../../src/openscience/synced-env-policy"

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
  globalThis.fetch = realFetch
  delete process.env["OPENROUTER_API_KEY"]
  delete process.env["OPENROUTER_BASE_URL"]
  delete process.env["ANTHROPIC_API_KEY"]
  delete process.env["META_MODEL_API_KEY"]
  delete process.env["META_MODEL_BASE_URL"]
  delete process.env["GITHUB_TOKEN"]
  delete process.env["GH_TOKEN"]
  for (const key of RETIRED_SYNCED_COMPUTE_ENV_KEYS) delete process.env[key]
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

test("account sync drops retired compute credentials but keeps integrations", async () => {
  await seedSession()
  for (const key of RETIRED_SYNCED_COMPUTE_ENV_KEYS) delete process.env[key]
  const retired = Object.fromEntries(
    [...RETIRED_SYNCED_COMPUTE_ENV_KEYS].map((key) => [key, `${key.toLowerCase()}-account-value`]),
  )
  stubSync({
    compute: retired,
    unapproved: {
      PATH: "/account-controlled/bin",
      OPENSCIENCE_ARBITRARY_SYNC_VALUE: "account-arbitrary-value",
      MODAL_TOKEN_ID: "account-modal-id",
      MODAL_TOKEN_SECRET: "account-modal-secret",
    },
    github: {
      GITHUB_TOKEN: "github-user-token",
      GH_TOKEN: "github-user-token",
    },
  })
  await OpenScience.syncServices()
  const env = OpenScience.filterEnvForSubprocess(process.env)
  for (const key of RETIRED_SYNCED_COMPUTE_ENV_KEYS) {
    expect(process.env[key]).toBeUndefined()
    expect(env[key]).toBeUndefined()
  }
  expect(process.env.PATH).not.toBe("/account-controlled/bin")
  expect(process.env.OPENSCIENCE_ARBITRARY_SYNC_VALUE).toBeUndefined()
  expect(process.env.MODAL_TOKEN_ID).toBeUndefined()
  expect(process.env.MODAL_TOKEN_SECRET).toBeUndefined()
  expect(env.GITHUB_TOKEN).toBe("github-user-token")
  expect(env.GH_TOKEN).toBe("github-user-token")

  const snapshot = JSON.parse(
    await Bun.file(path.join(process.env.XDG_CONFIG_HOME!, "openscience", "synced-env.json")).text(),
  ) as Record<string, string>
  for (const key of RETIRED_SYNCED_COMPUTE_ENV_KEYS) expect(snapshot[key]).toBeUndefined()
  expect(snapshot.PATH).toBeUndefined()
  expect(snapshot.OPENSCIENCE_ARBITRARY_SYNC_VALUE).toBeUndefined()
  expect(snapshot.MODAL_TOKEN_ID).toBeUndefined()
  expect(snapshot.MODAL_TOKEN_SECRET).toBeUndefined()
  expect(snapshot.GITHUB_TOKEN).toBe("github-user-token")
})

test("sync rejects GCP JSON and removes the legacy materialized credential", async () => {
  await seedSession()
  const managedDir = path.join(process.env.XDG_CONFIG_HOME!, "openscience")
  const legacy = path.join(managedDir, "atlas-gcp-service-account.json")
  await fs.mkdir(managedDir, { recursive: true })
  await Bun.write(legacy, JSON.stringify({ project_id: "old", private_key: "old-secret" }))
  const value = JSON.stringify({ project_id: "atlas-test", private_key: "gcp-secret" })
  stubSync({
    gcp: { GOOGLE_APPLICATION_CREDENTIALS_JSON: value, GOOGLE_CLOUD_PROJECT: "atlas-test" },
    openalex: { OPENALEX_API_KEY: "openalex-user-key" },
  })
  await OpenScience.syncServices()
  expect(await Bun.file(legacy).exists()).toBe(false)
  expect(process.env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined()
  expect(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON).toBeUndefined()
  expect(process.env.GOOGLE_CLOUD_PROJECT).toBeUndefined()
  const env = OpenScience.filterEnvForSubprocess(process.env)
  expect(env.GOOGLE_APPLICATION_CREDENTIALS).toBeUndefined()
  expect(env.GOOGLE_CLOUD_PROJECT).toBeUndefined()
  expect(env.GOOGLE_APPLICATION_CREDENTIALS_JSON).toBeUndefined()
  expect(env.OPENALEX_API_KEY).toBe("openalex-user-key")
})

test("preload removes retired compute credentials from a legacy snapshot", async () => {
  const root = await fs.mkdtemp(path.join(process.env.XDG_CACHE_HOME!, "preload-compute-migration-"))
  const snapshot = path.join(root, "synced-env.json")
  const legacyGcp = path.join(root, "atlas-gcp-service-account.json")
  const preload = new URL("../../src/openscience/preload-env.ts", import.meta.url).href
  await Bun.write(
    snapshot,
    JSON.stringify({
      AWS_ACCESS_KEY_ID: "account-aws-key",
      TINKER_API_KEY: "account-tinker-key",
      RUNPOD_API_KEY: "account-runpod-key",
      PATH: "/account-controlled/bin",
      OPENSCIENCE_ARBITRARY_SYNC_VALUE: "account-arbitrary-value",
      MODAL_TOKEN_ID: "account-modal-id",
      MODAL_TOKEN_SECRET: "account-modal-secret",
      GITHUB_TOKEN: "account-github-key",
    }),
  )
  await Bun.write(legacyGcp, JSON.stringify({ private_key: "legacy-gcp-key" }))
  const childEnv: Record<string, string | undefined> = { ...process.env, OPENSCIENCE_CONFIG_DIR: root }
  delete childEnv.AWS_ACCESS_KEY_ID
  delete childEnv.TINKER_API_KEY
  delete childEnv.RUNPOD_API_KEY
  delete childEnv.GITHUB_TOKEN
  delete childEnv.OPENSCIENCE_ARBITRARY_SYNC_VALUE
  delete childEnv.MODAL_TOKEN_ID
  delete childEnv.MODAL_TOKEN_SECRET

  try {
    const script = [
      `await import(${JSON.stringify(preload)})`,
      `console.log(JSON.stringify({ aws: process.env.AWS_ACCESS_KEY_ID, tinker: process.env.TINKER_API_KEY, runpod: process.env.RUNPOD_API_KEY, path: process.env.PATH, arbitrary: process.env.OPENSCIENCE_ARBITRARY_SYNC_VALUE, modalID: process.env.MODAL_TOKEN_ID, modalSecret: process.env.MODAL_TOKEN_SECRET, github: process.env.GITHUB_TOKEN }))`,
    ].join(";")
    const child = Bun.spawn([process.execPath, "-e", script], { env: childEnv, stdout: "pipe", stderr: "pipe" })
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (exit !== 0) throw new Error(stderr)
    const loaded = JSON.parse(stdout.trim()) as Record<string, string>
    expect(loaded.github).toBe("account-github-key")
    expect(loaded.path).not.toBe("/account-controlled/bin")
    expect(loaded.arbitrary).toBeUndefined()
    expect(loaded.modalID).toBeUndefined()
    expect(loaded.modalSecret).toBeUndefined()
    expect(JSON.parse(await Bun.file(snapshot).text())).toEqual({ GITHUB_TOKEN: "account-github-key" })
    expect(await Bun.file(legacyGcp).exists()).toBe(false)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

import { test, expect, afterEach } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { OpenScience } from "../../src/openscience"
import { Global } from "../../src/global"

// syncServices must respect credential precedence: a user's own shell-exported
// (or BYOK) provider key must survive a background sync — never be overwritten
// with a managed thk_ value, which would silently turn a free BYOK call into a
// billed managed one (the "billing flip" bug).

const realFetch = globalThis.fetch
afterEach(async () => {
  globalThis.fetch = realFetch
  delete process.env["ANTHROPIC_API_KEY"]
  // seedSession() writes a real session file into the SHARED per-process test
  // data dir. Leaving it behind turned every later test in the suite into an
  // "authenticated" one - skill discovery, billing-mode and atlas-bridge then
  // reached for the live Atlas API mid-suite (and hung CI whenever prod
  // hiccuped). Always clear it.
  await fs.rm(path.join(Global.Path.data, "openscience-session.json"), { force: true }).catch(() => {})
})

async function seedSession() {
  await Bun.write(
    path.join(Global.Path.data, "openscience-session.json"),
    JSON.stringify({ api_key: "thk_test.secret", user_id: "u1", device_name: "test" }),
  )
}

function stubSync(env: Record<string, string>) {
  globalThis.fetch = (async (url: string | URL) => {
    if (String(url).includes("/api/cli/sync")) {
      return Response.json({ user: {}, services: { anthropic: { connected: true, env } }, config: null })
    }
    return new Response("{}", { status: 200 })
  }) as unknown as typeof fetch
}

test("a user's exported provider key is NOT clobbered by a synced managed key", async () => {
  await seedSession()
  process.env["ANTHROPIC_API_KEY"] = "sk-user-own-key"
  stubSync({
    ANTHROPIC_API_KEY: "thk_managed.value",
    ANTHROPIC_BASE_URL: "https://app.syntheticsciences.ai/api/llm/proxy/anthropic",
  })
  await OpenScience.syncServices()
  expect(process.env["ANTHROPIC_API_KEY"]).toBe("sk-user-own-key")
})

test("a synced managed key IS applied when the slot is empty", async () => {
  await seedSession()
  delete process.env["ANTHROPIC_API_KEY"]
  stubSync({ ANTHROPIC_API_KEY: "thk_managed.value" })
  await OpenScience.syncServices()
  expect(process.env["ANTHROPIC_API_KEY"]).toBe("thk_managed.value")
})

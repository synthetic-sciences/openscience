import { test, expect, afterEach } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Server } from "../../src/server/server"
import { Config } from "../../src/config/config"
import { Auth } from "../../src/auth"
import { Global } from "../../src/global"

// PUT /auth/:providerID lives inline in server.ts (not a separable sub-app),
// so it's exercised through the real app via Server.internalFetch() - the
// same in-process path `openscience auth login` (CLI) and the Settings UI
// both go through.
const fetch = Server.internalFetch()

async function setAuth(providerID: string, key: string) {
  const res = await fetch(`http://openscience.internal/auth/${providerID}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ type: "api", key }),
  })
  expect(res.status).toBe(200)
}

// Config.global memoizes for the lifetime of the process (shared across every
// test file in this `bun test` run, not just this one) - each test below
// establishes its own precondition via Config.updateGlobal (which resets that
// cache) rather than assuming a blank slate.
//
// Cleanup removes BOTH candidate global config filenames: Config.updateGlobal
// picks whichever of openscience.jsonc / openscience.json already exists, and
// falls back to creating the .jsonc one when neither does yet
// (config.ts globalConfigFile()). Leaving that file behind would make later
// files in the same `bun test` run (e.g. settings-billing.test.ts, which
// writes and reads openscience.json directly) silently write to a stale
// .jsonc instead. Config.global.reset() drops the in-memory cache the same
// way - a deleted file alone would not un-memoize it.
afterEach(async () => {
  await fs.rm(path.join(Global.Path.config, "openscience.json"), { force: true }).catch(() => {})
  await fs.rm(path.join(Global.Path.config, "openscience.jsonc"), { force: true }).catch(() => {})
  Config.global.reset()
  await Auth.remove("openrouter").catch(() => {})
  await Auth.remove("anthropic").catch(() => {})
})

test("a non-thk_ OpenRouter key added while billing.llm is managed flips the toggle to byok", async () => {
  await Config.updateGlobal({ billing: { llm: "managed" } })

  await setAuth("openrouter", "sk-or-user-owned-key")

  const cfg = await Config.getGlobal()
  expect(cfg.billing?.llm).toBe("byok")
  expect(await Auth.get("openrouter")).toEqual({ type: "api", key: "sk-or-user-owned-key" })
})

test("a thk_ OpenRouter key added while billing.llm is managed does not flip the mode", async () => {
  await Config.updateGlobal({ billing: { llm: "managed" } })

  await setAuth("openrouter", "thk_atlas-managed-token")

  const cfg = await Config.getGlobal()
  expect(cfg.billing?.llm).toBe("managed")
})

test("a key added for a different provider does not flip the mode", async () => {
  await Config.updateGlobal({ billing: { llm: "managed" } })

  await setAuth("anthropic", "sk-ant-user-owned-key")

  const cfg = await Config.getGlobal()
  expect(cfg.billing?.llm).toBe("managed")
})

test("an OpenRouter key added while billing.llm is null (auto) does not write the config", async () => {
  await Config.updateGlobal({ billing: { llm: null } })

  await setAuth("openrouter", "sk-or-user-owned-key")

  const cfg = await Config.getGlobal()
  expect(cfg.billing?.llm ?? null).toBeNull()
})

test("an OpenRouter key added while billing.llm is byok does not write the config again", async () => {
  await Config.updateGlobal({ billing: { llm: "byok" } })

  await setAuth("openrouter", "sk-or-user-owned-key")

  const cfg = await Config.getGlobal()
  expect(cfg.billing?.llm).toBe("byok")
})

import { test, expect, afterEach } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Auth } from "../../src/auth"
import { Config } from "../../src/config/config"
import { Global } from "../../src/global"

// Auth.set is the ONE choke point both `openscience auth login` (CLI - calls
// Auth.set directly, see cli/cmd/auth.ts) and the Settings UI
// (PUT /auth/:providerID -> Auth.set) go through, so the billing.llm flip
// lives there (auth/index.ts), not in the HTTP route. These tests call
// Auth.set directly rather than going through the server, since that's the
// actual behavior under test.

// Config.global memoizes for the lifetime of the process (shared across every
// test file in this `bun test` run) - each test establishes its own
// precondition via Config.updateGlobal (which resets that cache) rather than
// assuming a blank slate.
//
// Cleanup removes all three candidate global config filenames
// (config.ts globalConfigFile() picks from openscience.jsonc /
// openscience.json / config.json, defaulting to creating the first when none
// exist yet) and resets the in-memory Config.global cache, so a later test in
// this file - or a later file in the same `bun test` run - does not inherit
// a flipped mode or a stray file that shadows another candidate.
async function resetGlobalConfig() {
  for (const name of ["openscience.jsonc", "openscience.json", "config.json"]) {
    await fs.rm(path.join(Global.Path.config, name), { force: true }).catch(() => {})
  }
  Config.global.reset()
}

afterEach(async () => {
  await resetGlobalConfig()
  await Auth.remove("openrouter").catch(() => {})
  await Auth.remove("anthropic").catch(() => {})
})

test("a non-thk_ OpenRouter key added while billing.llm is managed flips the toggle to byok", async () => {
  await Config.updateGlobal({ billing: { llm: "managed" } })

  await Auth.set("openrouter", { type: "api", key: "sk-or-user-owned-key" })

  const cfg = await Config.getGlobal()
  expect(cfg.billing?.llm).toBe("byok")
  // Never delete or rewrite the user's stored key - just the mode.
  expect(await Auth.get("openrouter")).toEqual({ type: "api", key: "sk-or-user-owned-key" })
})

test("a thk_ OpenRouter key added while billing.llm is managed does not flip the mode", async () => {
  await Config.updateGlobal({ billing: { llm: "managed" } })

  await Auth.set("openrouter", { type: "api", key: "thk_atlas-managed-token" })

  const cfg = await Config.getGlobal()
  expect(cfg.billing?.llm).toBe("managed")
})

test("a reserved thk- integration marker is managed credential material", () => {
  expect(Auth.isAtlasApiKey("thk-codex-oauth-placeholder")).toBe(true)
})

test("an OAuth credential for openrouter while billing.llm is managed does not flip the mode", async () => {
  await Config.updateGlobal({ billing: { llm: "managed" } })

  await Auth.set("openrouter", { type: "oauth", refresh: "refresh-token", access: "access-token", expires: 123 })

  const cfg = await Config.getGlobal()
  expect(cfg.billing?.llm).toBe("managed")
})

test("a key added for a different provider does not flip the mode", async () => {
  await Config.updateGlobal({ billing: { llm: "managed" } })

  await Auth.set("anthropic", { type: "api", key: "sk-ant-user-owned-key" })

  const cfg = await Config.getGlobal()
  expect(cfg.billing?.llm).toBe("managed")
})

test("an OpenRouter key added while billing.llm is null (auto) does not write the config", async () => {
  await Config.updateGlobal({ billing: { llm: null } })

  await Auth.set("openrouter", { type: "api", key: "sk-or-user-owned-key" })

  const cfg = await Config.getGlobal()
  expect(cfg.billing?.llm ?? null).toBeNull()
})

test("an OpenRouter key added while billing.llm is byok does not write the config again", async () => {
  // Seed openscience.json directly (bypassing Config.updateGlobal) rather
  // than reading Config.getGlobal() afterwards - a plain re-read-and-compare
  // would pass even if the "=== managed" gate were deleted entirely (byok
  // written over byok is still byok). Byte comparison pins that Auth.set
  // does not touch the file at all in this case, but needs the seed shaped
  // to dodge two unrelated quirks in the write path:
  // (1) config.ts's load() adds a missing $schema field to the file as an
  //     incidental side effect of ANY read (Auth.set's gate check itself
  //     calls Config.getGlobal()) - include it up front so that add doesn't
  //     masquerade as "Auth.set wrote something" below.
  // (2) Config.updateGlobal's .jsonc branch patches the document
  //     surgically (jsonc-parser) and leaves an unchanged value's
  //     formatting untouched - "wrote byok over byok" and "wrote nothing"
  //     would be byte-identical there. .json's branch always re-serializes
  //     the whole object (JSON.stringify(merged, null, 2)), so a real write
  //     changes bytes even for an unchanged value - use that file.
  const file = path.join(Global.Path.config, "openscience.json")
  await fs.mkdir(Global.Path.config, { recursive: true })
  const seed = JSON.stringify({ $schema: "https://syntheticsciences.ai/config.json", billing: { llm: "byok" } })
  await fs.writeFile(file, seed)
  Config.global.reset()

  await Auth.set("openrouter", { type: "api", key: "sk-or-user-owned-key" })

  expect(await fs.readFile(file, "utf8")).toBe(seed)
})

test("an OpenRouter key added while the global config is malformed still persists the key and does not throw", async () => {
  // A doubled trailing comma - jsonc-parser tolerates a single trailing
  // comma (config.ts passes allowTrailingComma: true) but not two in a row -
  // stands in for a hand-edited openscience.jsonc gone wrong. That makes
  // Config.getGlobal() throw; the flip in Auth.set is wrapped in try/catch
  // specifically so this doesn't take the key write down with it.
  const file = path.join(Global.Path.config, "openscience.jsonc")
  await fs.mkdir(Global.Path.config, { recursive: true })
  await fs.writeFile(file, `{ "billing": { "llm": "managed" },, }`)
  Config.global.reset()

  await Auth.set("openrouter", { type: "api", key: "sk-or-user-owned-key" })

  expect(await Auth.get("openrouter")).toEqual({ type: "api", key: "sk-or-user-owned-key" })
})

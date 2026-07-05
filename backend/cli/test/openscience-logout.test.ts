import { test, expect, afterEach } from "bun:test"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { Global } from "../src/global"
import { OpenScience, API_BASE } from "../src/openscience"

// XDG dirs are isolated per test run by test/preload.ts, so these paths all
// live under the throwaway temp tree — never the developer's real config.
const session = path.join(Global.Path.data, "openscience-session.json")
const synced = path.join(process.env.XDG_CONFIG_HOME!, "openscience")
const snapshot = path.join(synced, "synced-env.json")
const managed = path.join(synced, "openscience-synced.json")
const queue = path.join(Global.Path.data, "usage-queue.jsonl")
const atlas = path.join(os.tmpdir(), `openscience-test-atlas-${process.pid}`, "config.json")

const INJECTED = "OPENSCIENCE_TEST_SYNCED_VAR"
const EXPORTED = "OPENSCIENCE_TEST_EXPORTED_VAR"

afterEach(async () => {
  delete process.env[INJECTED]
  delete process.env[EXPORTED]
  delete process.env.ATLAS_CLI_CONFIG_PATH
  for (const file of [session, snapshot, managed, queue, atlas]) {
    await fs.rm(file, { force: true }).catch(() => {})
  }
})

test("clearSession removes every synced credential artifact", async () => {
  await fs.mkdir(Global.Path.data, { recursive: true })
  await fs.mkdir(synced, { recursive: true })
  await fs.mkdir(path.dirname(atlas), { recursive: true })

  await Bun.write(session, JSON.stringify({ api_key: "thk_test.secret", user_id: "user-1" }))
  // The persisted snapshot preload-env.ts replays into process.env at boot.
  await Bun.write(snapshot, JSON.stringify({ [INJECTED]: "thk_injected_value", [EXPORTED]: "thk_synced_value" }))
  await Bun.write(managed, JSON.stringify({ model: "synsci/some-model" }))
  await Bun.write(queue, JSON.stringify({ service: "llm", event_type: "chat", tokens_used: 10 }) + "\n")

  process.env.ATLAS_CLI_CONFIG_PATH = atlas
  await Bun.write(
    atlas,
    JSON.stringify({
      active_profile: "default",
      profiles: {
        default: { api_key: "thk_test.secret", base_url: `${API_BASE}/api/v1` },
        personal: { api_key: "thk_other.key", base_url: "https://example.test/api/v1" },
      },
    }),
  )

  // Simulate preload-env.ts having injected the synced value at boot…
  process.env[INJECTED] = "thk_injected_value"
  // …and a key the user exported in their own shell with a different value.
  process.env[EXPORTED] = "user-exported-value"

  await OpenScience.clearSession()

  expect(await Bun.file(session).exists()).toBe(false)
  expect(await Bun.file(snapshot).exists()).toBe(false)
  expect(await Bun.file(managed).exists()).toBe(false)
  expect(await Bun.file(queue).exists()).toBe(false)

  // The injected var is gone; the shell export survives.
  expect(process.env[INJECTED]).toBeUndefined()
  expect(process.env[EXPORTED]).toBe("user-exported-value")

  // The seeded atlas-cli profile lost its api_key; everything else intact.
  const config = JSON.parse(await Bun.file(atlas).text())
  expect(config.profiles.default.api_key).toBeUndefined()
  expect(config.profiles.default.base_url).toBe(`${API_BASE}/api/v1`)
  expect(config.profiles.personal.api_key).toBe("thk_other.key")
})

test("clearSession without a session still clears the seeded atlas profile by base_url", async () => {
  await fs.mkdir(path.dirname(atlas), { recursive: true })
  process.env.ATLAS_CLI_CONFIG_PATH = atlas
  await Bun.write(
    atlas,
    JSON.stringify({
      active_profile: "default",
      profiles: { default: { api_key: "thk_stale.secret", base_url: `${API_BASE}/api/v1` } },
    }),
  )

  await OpenScience.clearSession()

  const config = JSON.parse(await Bun.file(atlas).text())
  expect(config.profiles.default.api_key).toBeUndefined()
})

test("clearSession leaves a hand-configured atlas profile alone", async () => {
  await fs.mkdir(path.dirname(atlas), { recursive: true })
  process.env.ATLAS_CLI_CONFIG_PATH = atlas
  await Bun.write(
    atlas,
    JSON.stringify({
      active_profile: "default",
      profiles: { default: { api_key: "thk_mine.secret", base_url: "https://selfhosted.example/api/v1" } },
    }),
  )

  await OpenScience.clearSession()

  const config = JSON.parse(await Bun.file(atlas).text())
  expect(config.profiles.default.api_key).toBe("thk_mine.secret")
})

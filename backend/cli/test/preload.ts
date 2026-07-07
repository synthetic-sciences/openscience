// IMPORTANT: Set env vars BEFORE any imports from src/ directory
// xdg-basedir reads env vars at import time, so we must set these first
import os from "os"
import path from "path"
import fs from "fs/promises"
import fsSync from "fs"
import { afterAll } from "bun:test"

const dir = path.join(os.tmpdir(), "openscience-test-data-" + process.pid)
await fs.mkdir(dir, { recursive: true })
afterAll(() => {
  fsSync.rmSync(dir, { recursive: true, force: true })
})
// Set test home directory to isolate tests from user's actual home directory
// This prevents tests from picking up real user configs/skills from ~/.claude/skills
const testHome = path.join(dir, "home")
await fs.mkdir(testHome, { recursive: true })
process.env["OPENSCIENCE_TEST_HOME"] = testHome

// Set test managed config directory to isolate tests from system managed settings
const testManagedConfigDir = path.join(dir, "managed")
process.env["OPENSCIENCE_TEST_MANAGED_CONFIG_DIR"] = testManagedConfigDir

process.env["XDG_DATA_HOME"] = path.join(dir, "share")
process.env["XDG_CACHE_HOME"] = path.join(dir, "cache")
process.env["XDG_CONFIG_HOME"] = path.join(dir, "config")
process.env["XDG_STATE_HOME"] = path.join(dir, "state")

// Write the cache version file to prevent global/index.ts from wiping the cache
// dir on import. MUST match CACHE_VERSION in src/global/index.ts — otherwise the
// seeded models.json below is deleted before ModelsDev.Data reads it and every
// provider test sees an empty catalog. (This was silently stale until the catalog
// fixture started depending on the cache surviving.)
const cacheDir = path.join(dir, "cache", "openscience")
await fs.mkdir(cacheDir, { recursive: true })
await fs.writeFile(path.join(cacheDir, "version"), "21")

// Seed a committed models.dev catalog so provider-touching tests are deterministic
// and never hit the network. With OPENSCIENCE_DISABLE_MODELS_FETCH set, ModelsDev.Data
// returns this cached catalog (provider/models.ts) and the startup + hourly refresh is
// skipped. Regenerate the fixture when the pinned test models change; a scheduled
// live-catalog job catches upstream delistings instead of reddening PR CI.
await Bun.write(
  path.join(cacheDir, "models.json"),
  Bun.gunzipSync(await Bun.file(path.join(import.meta.dir, "fixture", "models-catalog.json.gz")).arrayBuffer()),
)
process.env["OPENSCIENCE_DISABLE_MODELS_FETCH"] = "true"

// Disable builtin plugins that aren't published to npm (@synsci/anthropic-auth, etc.)
process.env["OPENSCIENCE_DISABLE_DEFAULT_PLUGINS"] = "true"

// Disable bundled skills to isolate skill discovery tests
process.env["OPENSCIENCE_DISABLE_BUNDLED_SKILLS"] = "true"

// Hermetic API base: several suite paths reach the Atlas backend whenever a
// session file exists, and session-file.test.ts writes one into the shared
// per-process test data dir - so later tests (skill discovery's
// fetchLearnedSkills, billing-mode, atlas-bridge) silently depended on the
// LIVE production API. When prod hiccuped, those tests hung to their timeout
// and CI went red on an unrelated commit. Point the base at an unroutable
// local port so any accidental call fails in milliseconds (ECONNREFUSED),
// which every fetcher already handles as "offline -> null". Tests that need
// a real server (fake-atlas fixtures) override this per-test.
process.env["OPENSCIENCE_API_BASE"] = "http://127.0.0.1:9"

// Clear provider env vars to ensure clean test state
delete process.env["ANTHROPIC_API_KEY"]
delete process.env["ANTHROPIC_BASE_URL"]
delete process.env["OPENAI_API_KEY"]
delete process.env["OPENAI_BASE_URL"]
delete process.env["GOOGLE_API_KEY"]
delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"]
delete process.env["GOOGLE_GENERATIVE_AI_BASE_URL"]
delete process.env["AZURE_OPENAI_API_KEY"]
delete process.env["AWS_ACCESS_KEY_ID"]
delete process.env["AWS_PROFILE"]
delete process.env["AWS_REGION"]
delete process.env["AWS_BEARER_TOKEN_BEDROCK"]
delete process.env["OPENROUTER_API_KEY"]
delete process.env["OPENROUTER_BASE_URL"]
delete process.env["GROQ_API_KEY"]
delete process.env["MISTRAL_API_KEY"]
delete process.env["PERPLEXITY_API_KEY"]
delete process.env["TOGETHER_API_KEY"]
delete process.env["XAI_API_KEY"]
delete process.env["DEEPSEEK_API_KEY"]
delete process.env["FIREWORKS_API_KEY"]
delete process.env["CEREBRAS_API_KEY"]
delete process.env["SAMBANOVA_API_KEY"]

// Now safe to import from src/
const { Log } = await import("../src/util/log")

Log.init({
  print: false,
  dev: true,
  level: "DEBUG",
})

/**
 * Loads synced env vars from disk synchronously at module init.
 *
 * Runs BEFORE any provider SDK construction (Anthropic, OpenAI,
 * @ai-sdk/google) so those SDKs see the correct ANTHROPIC_BASE_URL /
 * ANTHROPIC_API_KEY / etc. on their own startup, without waiting for
 * the asynchronous `openscience sync` call later in CLI boot.
 *
 * Without this, the first invocation after a fresh terminal session
 * would race: sync sets process.env in-process, but the SDK had
 * already cached an empty value at module load. Persisting last-known
 * sync output to disk and replaying it synchronously at boot closes
 * that race.
 *
 * Writer side: see syncServices() in ./index.ts — it writes the same
 * file after every successful /api/cli/sync call.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

function syncedEnvPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(xdg, "openscience", "synced-env.json")
}

// IIFE so the side effect runs the moment this module is imported.
;(function loadSyncedEnv() {
  let raw: string
  try {
    raw = fs.readFileSync(syncedEnvPath(), "utf-8")
  } catch {
    // No file yet (first run / fresh install) — nothing to apply.
    return
  }
  let env: unknown
  try {
    env = JSON.parse(raw)
  } catch {
    // Corrupted file — skip silently; next successful sync rewrites it.
    return
  }
  if (!env || typeof env !== "object" || Array.isArray(env)) return
  for (const [k, v] of Object.entries(env as Record<string, unknown>)) {
    // Don't clobber values already set in the parent environment —
    // explicit shell exports win over persisted sync state.
    if (typeof v === "string" && !process.env[k]) {
      process.env[k] = v
    }
  }
})()

export const SYNCED_ENV_PATH = syncedEnvPath

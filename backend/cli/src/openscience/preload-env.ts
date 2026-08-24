/**
 * Loads synced env vars from disk synchronously at module init.
 *
 * Runs BEFORE any provider SDK construction (Anthropic, OpenAI,
 * @ai-sdk/google) so those SDKs see synced user-owned BYOK keys and the
 * managed OpenRouter route on startup, without waiting for the asynchronous
 * `openscience sync` call later in CLI boot. Account-synced compute
 * credentials are rejected and removed from legacy snapshots.
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
import { scrubAmbientProjectDotenv } from "./dotenv"

function syncedEnvPath(): string {
  const config = process.env.OPENSCIENCE_CONFIG_DIR?.trim()
  if (config) return path.join(path.resolve(config), "synced-env.json")
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(xdg, "openscience", "synced-env.json")
}

// The shipped binary disables Bun's ambient .env auto-load
// (`autoloadDotenv:false`). Do not replay a repository .env here: this module
// runs before canonical project identity/trust exists, and even an apparently
// ordinary provider key or GIT_ASKPASS-style variable changes host authority.
// Trusted workloads may load their own dotenv inside the confined process;
// OpenScience credentials belong in the shell or the global Keys settings.
scrubAmbientProjectDotenv(process.cwd(), process.env)

// Dynamic on purpose: endpoints.ts snapshots the managed base URL at module
// evaluation. It must not evaluate until the ambient repository dotenv has
// been removed above.
const { isSyncedEnvAllowed } = await import("./synced-env-policy")

function removeLegacySyncedGcpFile(filepath: string): void {
  try {
    fs.unlinkSync(path.join(path.dirname(filepath), "atlas-gcp-service-account.json"))
  } catch {
    // Missing or already removed.
  }
}

function persistFilteredSnapshot(filepath: string, env: Record<string, unknown>): Record<string, string> {
  const filtered: Record<string, string> = {}
  let changed = false
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string" || !isSyncedEnvAllowed(key, value)) {
      changed = true
      continue
    }
    filtered[key] = value
  }
  if (!changed) return filtered

  const tmp = `${filepath}.${process.pid}.${Date.now()}.tmp`
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(filtered, null, 2)}\n`, { flag: "wx", mode: 0o600 })
    if (process.platform !== "win32") fs.chmodSync(tmp, 0o600)
    fs.renameSync(tmp, filepath)
  } catch {
    try {
      fs.unlinkSync(tmp)
    } catch {
      // Best-effort migration. A successful account sync rewrites the snapshot.
    }
  }
  return filtered
}

// IIFE so the side effect runs the moment this module is imported.
;(function loadSyncedEnv() {
  const filepath = syncedEnvPath()
  removeLegacySyncedGcpFile(filepath)
  let raw: string
  try {
    raw = fs.readFileSync(filepath, "utf-8")
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
  const filtered = persistFilteredSnapshot(filepath, env as Record<string, unknown>)
  for (const [k, v] of Object.entries(filtered)) {
    // Don't clobber values already set in the parent environment —
    // explicit shell exports win over persisted sync state.
    if (!process.env[k]) {
      process.env[k] = v
    }
  }
})()

export const SYNCED_ENV_PATH = syncedEnvPath

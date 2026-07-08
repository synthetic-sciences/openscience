/**
 * Controlled project `.env` loading.
 *
 * The shipped binary builds with `autoloadDotenv: false` (script/build.ts) so it
 * never silently ingests an ambient `.env` from whatever directory it is run in.
 * But a user's own project `.env` is a first-class BYOK source — the same as a
 * shell export or `keys add`. So we load it ourselves, explicitly and
 * predictably, from the launch directory.
 *
 * Precedence: a real shell export always wins (we only apply vars that are not
 * already set), and because preload-env.ts calls this BEFORE replaying the
 * synced-env snapshot, a `.env` key also wins over a managed synced value —
 * matching the "the user's own key beats the managed wallet" rule everywhere
 * else. A `.env` is the user's own credential, so it is NOT subject to the sync
 * blocklist (synced-env-policy.ts) — that only filters Atlas-provided values.
 *
 * Kept dependency-free (only node fs/path) so preload-env.ts can call it at
 * module init before the rest of the app loads.
 */
import * as fs from "node:fs"
import * as path from "node:path"

/** Parse `.env` file contents into [key, value] pairs. Supports `KEY=value`, an
 *  optional `export ` prefix, `#` comments, blank lines, and surrounding single
 *  or double quotes. No variable expansion — values are taken literally. */
export function parseDotenv(raw: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const body = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed
    const eq = body.indexOf("=")
    if (eq <= 0) continue
    const key = body.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = body.slice(eq + 1).trim()
    const quote = value[0]
    if (value.length >= 2 && (quote === '"' || quote === "'") && value.at(-1) === quote) {
      value = value.slice(1, -1)
    }
    out.push([key, value])
  }
  return out
}

/** Load `.env.local` then `.env` from `cwd`, applying a var only when it is not
 *  already set in `env` (so a shell export wins). `.env.local` is read first so
 *  it takes precedence over `.env` under the "first writer wins" rule. Returns
 *  the names actually applied (for an optional caller log). Never throws. */
export function loadProjectDotenv(cwd: string, env: NodeJS.ProcessEnv): string[] {
  const applied: string[] = []
  for (const name of [".env.local", ".env"]) {
    let raw: string
    try {
      raw = fs.readFileSync(path.join(cwd, name), "utf-8")
    } catch {
      continue
    }
    for (const [key, value] of parseDotenv(raw)) {
      if (env[key] === undefined) {
        env[key] = value
        applied.push(key)
      }
    }
  }
  return applied
}

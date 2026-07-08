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
    if (value[0] === '"' || value[0] === "'") {
      // Quoted: take up to the matching closing quote; anything after it (e.g. a
      // trailing comment) is ignored, and a `#` inside the quotes stays literal.
      const quote = value[0]
      const end = value.indexOf(quote, 1)
      value = end > 0 ? value.slice(1, end) : value.slice(1)
    } else {
      // Unquoted: an inline comment starts at the first whitespace-then-`#`.
      const comment = value.search(/\s#/)
      if (comment >= 0) value = value.slice(0, comment).trimEnd()
    }
    out.push([key, value])
  }
  return out
}

/** Vars that alter how this process or its subprocesses execute. Never honoured
 *  from a project `.env` (which may be an untrusted cloned repo) even though
 *  ordinary vars are — setting one from the launch dir would let the repo inject
 *  code into the tool subprocesses openscience spawns. A shell export of these
 *  still works; only the `.env` path is refused. */
const DANGEROUS_ENV = new Set([
  "NODE_OPTIONS",
  "BUN_OPTIONS",
  "NODE_REPL_EXTERNAL_MODULE",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
])

/** Load `.env.local` then `.env` from `cwd`, applying a var only when it is not
 *  already set in `env` (so a shell export wins). `.env.local` is read first so
 *  it takes precedence over `.env` under the "first writer wins" rule. Skips
 *  execution-affecting vars (DANGEROUS_ENV) and empty values. Returns the names
 *  actually applied (for an optional caller log). Never throws. */
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
      if (DANGEROUS_ENV.has(key)) continue
      // Skip empty values: they aren't a real credential, and applying "" here
      // only to have the synced replay (which treats "" as unset) overwrite it
      // would violate the shell > .env > synced precedence.
      if (value === "" || env[key] !== undefined) continue
      env[key] = value
      applied.push(key)
    }
  }
  return applied
}

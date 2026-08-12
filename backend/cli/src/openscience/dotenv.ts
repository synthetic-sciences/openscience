/**
 * Controlled project `.env` loading.
 *
 * The shipped binary builds with `autoloadDotenv: false` (script/build.ts) so it
 * never silently ingests an ambient `.env` from whatever directory it is run in.
 * Repository `.env` files are never loaded during OpenScience boot: canonical
 * project trust does not exist at that import boundary. This parser/loader is
 * retained for explicit post-trust workload use and tests; callers must not use
 * it as a host credential/control-plane source.
 *
 * Precedence for an explicit caller: a real shell export always wins. Even
 * after trust, OpenScience control-plane, loader, proxy, and provider-routing
 * variables remain explicit shell/global settings.
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
  // OpenScience/host process discovery and import behavior.
  "PATH",
  "HOME",
  "SHELL",
  "ENV",
  "BASH_ENV",
  "ZDOTDIR",
  "CDPATH",
  "IFS",
  "TMPDIR",
  "TMP",
  "TEMP",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "NODE_OPTIONS",
  "BUN_OPTIONS",
  "NODE_REPL_EXTERNAL_MODULE",
  "PYTHONPATH",
  "PYTHONHOME",
  "RUBYOPT",
  "RUBYLIB",
  "PERL5OPT",
  "PERL5LIB",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "CLASSPATH",
  "BUNDLE_GEMFILE",
  "GIT_ASKPASS",
  "GIT_SSH_COMMAND",
  "SSH_ASKPASS",
  "LD_PRELOAD",
  "LD_LIBRARY_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  // Transport indirection can redirect a shell-exported credential to an
  // attacker-controlled proxy/CA even when the credential itself is not in
  // the repository.
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
  "ATLAS_BASE_URL",
  "ANTHROPIC_BASE_URL",
  "OPENAI_BASE_URL",
  "GOOGLE_GENERATIVE_AI_BASE_URL",
  "GOOGLE_BASE_URL",
  "GEMINI_BASE_URL",
  "OPENROUTER_BASE_URL",
  "META_MODEL_BASE_URL",
  "TOGETHER_BASE_URL",
  "GROQ_BASE_URL",
  "FIREWORKS_BASE_URL",
  "XAI_BASE_URL",
  "MISTRAL_BASE_URL",
  "DEEPSEEK_BASE_URL",
  "CEREBRAS_BASE_URL",
  "PERPLEXITY_BASE_URL",
  "AZURE_OPENAI_ENDPOINT",
  "TINKER_BASE_URL",
])

/** Repository dotenv is data/workload configuration, never an authority to
 * reconfigure the OpenScience host. This predicate runs before Flag, Config,
 * Global, provider SDK, and plugin modules are imported. */
export function isProjectDotenvAllowed(key: string): boolean {
  if (DANGEROUS_ENV.has(key)) return false
  if (key.startsWith("OPENSCIENCE_") || key.startsWith("SYNSC_")) return false
  if (key.startsWith("GIT_CONFIG_") || key.startsWith("NPM_CONFIG_")) return false
  return true
}

/** Remove variables Bun may have auto-loaded from the launch directory before
 * JavaScript got control. The standalone binary disables autoload at build
 * time, and dev scripts pass --no-env-file, but this closes direct
 * `bun src/index.ts` launches too. A parent-shell value that differs from the
 * repository value is preserved; an indistinguishable equal value is dropped
 * fail-closed and can be supplied through global Keys settings instead. */
export function scrubAmbientProjectDotenv(cwd: string, env: NodeJS.ProcessEnv): string[] {
  const removed: string[] = []
  for (const name of [".env.local", ".env"]) {
    let raw: string
    try {
      raw = fs.readFileSync(path.join(cwd, name), "utf-8")
    } catch {
      continue
    }
    for (const [key, value] of parseDotenv(raw)) {
      if (value === "" || env[key] !== value) continue
      delete env[key]
      removed.push(key)
    }
  }
  return [...new Set(removed)]
}

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
      if (!isProjectDotenvAllowed(key)) continue
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

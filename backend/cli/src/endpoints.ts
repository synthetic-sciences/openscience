/**
 * Central resolver for the managed (Atlas) backend base URL.
 *
 * The public client ships with a NEUTRAL default host — no internal
 * deployment codename is ever baked into a public default string. Self-hosters
 * and dev stacks override it via env. Every hardcoded backend URL in the CLI
 * routes through here so there is a single seam between the open client and the
 * closed backend.
 *
 * Resolution order (first non-empty wins):
 *   OPENSCIENCE_API_BASE — the current CLI override
 *   SYNSC_API_BASE       — the historical CLI override (kept for back-compat)
 *   MANAGED_API_BASE     — managed-backend override
 *   ATLAS_BASE_URL       — alias for MANAGED_API_BASE
 *   THESIS_BASE_URL      — legacy alias (kept so existing exports keep working)
 *   <neutral default>    — the public managed host
 */

/** Neutral public default. Contains no internal codename. */
export const DEFAULT_MANAGED_API_BASE = "https://app.syntheticsciences.ai"

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "")
}

/** Env var names that override the managed base URL, highest precedence first. */
export const MANAGED_API_BASE_ENV_KEYS = [
  "OPENSCIENCE_API_BASE",
  "SYNSC_API_BASE",
  "MANAGED_API_BASE",
  "ATLAS_BASE_URL",
  "THESIS_BASE_URL",
] as const

/**
 * Resolve the managed backend base URL from the given environment, falling back
 * to the neutral default. Pure + parameterized so it stays unit-testable.
 */
export function managedApiBase(env: NodeJS.ProcessEnv = process.env): string {
  const override = MANAGED_API_BASE_ENV_KEYS.map((key) => env[key]).find((value) => !!value)
  return stripTrailingSlashes(override || DEFAULT_MANAGED_API_BASE)
}

/** The resolved managed base URL for this process. */
export const MANAGED_API_BASE = managedApiBase()

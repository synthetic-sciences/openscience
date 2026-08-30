/** Public managed-backend endpoint resolver. */
export const DEFAULT_MANAGED_API_BASE = "https://app.syntheticsciences.ai"

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "")
}

export const MANAGED_API_BASE_ENV_KEYS = [
  "OPENSCIENCE_API_BASE",
  "SYNSC_API_BASE",
  "MANAGED_API_BASE",
  "ATLAS_BASE_URL",
  "THESIS_BASE_URL",
] as const

export function managedApiBase(env: NodeJS.ProcessEnv = process.env): string {
  const override = MANAGED_API_BASE_ENV_KEYS.map((key) => env[key]).find((value) => !!value)
  return stripTrailingSlashes(override || DEFAULT_MANAGED_API_BASE)
}

export function dashboardUrl(pathname: string, env: NodeJS.ProcessEnv = process.env): string {
  const frontend = env.SYNSC_AUTH_URL?.trim() || managedApiBase(env)
  const fallback = new URL(pathname, `${DEFAULT_MANAGED_API_BASE}/`).toString()
  try {
    return new URL(pathname, `${stripTrailingSlashes(frontend)}/`).toString()
  } catch {
    return fallback
  }
}

export const MANAGED_API_BASE = managedApiBase()
export const BILLING_URL = dashboardUrl("/billing")

export const E2E_MODE_ENV = "OPENSCIENCE_E2E_MODE"

export type E2EMode = "isolated" | "external"

type Environment = Record<string, string | undefined>

export interface PlaywrightTarget {
  mode: E2EMode
  baseURL: string
  startWebServer: boolean
  reuseExistingServer: false
  port?: number
}

function externalBaseURL(env: Environment) {
  const value = env.PLAYWRIGHT_BASE_URL?.trim()
  if (!value) {
    throw new Error(
      "External E2E mode requires PLAYWRIGHT_BASE_URL. Use `bun run test:e2e` for an isolated run or set the URL and run `bun run test:e2e:external`.",
    )
  }
  const url = new URL(value)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`PLAYWRIGHT_BASE_URL must use http or https, received ${url.protocol}`)
  }
  return url
}

/** Resolve the browser target without allowing an ambient port-3000 server to
 * silently change what the default suite tests. The isolated harness owns its
 * Vite port and never reuses a listener; external/package runs must opt in. */
export function resolvePlaywrightTarget(env: Environment): PlaywrightTarget {
  const mode = env[E2E_MODE_ENV]
  if (mode !== "isolated" && mode !== "external") {
    throw new Error(
      `Set ${E2E_MODE_ENV}=isolated via \`bun run test:e2e\`, or use \`bun run test:e2e:external\` for an existing server.`,
    )
  }

  if (mode === "external") {
    return {
      mode,
      baseURL: externalBaseURL(env).toString(),
      startWebServer: false,
      reuseExistingServer: false,
    }
  }

  const port = Number(env.PLAYWRIGHT_PORT ?? 3000)
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PLAYWRIGHT_PORT must be an integer from 1 to 65535, received ${env.PLAYWRIGHT_PORT}`)
  }
  return {
    mode,
    baseURL: `http://127.0.0.1:${port}`,
    startWebServer: true,
    reuseExistingServer: false,
    port,
  }
}

export function externalRunnerEnvironment(env: Environment, packaged = false): Record<string, string> {
  const url = externalBaseURL(env)
  const port = url.port || (url.protocol === "https:" ? "443" : "80")
  const result = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
  return {
    ...result,
    [E2E_MODE_ENV]: "external",
    PLAYWRIGHT_BASE_URL: url.toString(),
    PLAYWRIGHT_SERVER_HOST: env.PLAYWRIGHT_SERVER_HOST || url.hostname,
    PLAYWRIGHT_SERVER_PORT: env.PLAYWRIGHT_SERVER_PORT || port,
    ...(packaged ? { OPENSCIENCE_E2E_PACKAGED: "1" } : {}),
  }
}

export function forwardedPlaywrightArgs(args: string[]) {
  return args[0] === "--" ? args.slice(1) : args
}

export function playwrightCommand(args: string[]) {
  return [process.execPath, "x", "playwright", "test", ...args]
}

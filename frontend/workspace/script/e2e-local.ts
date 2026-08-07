import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"
import { fakeModelConfig, fakeModelID, startFakeModelServer } from "./e2e-fake-model"
import { E2E_MODE_ENV, forwardedPlaywrightArgs, playwrightCommand } from "./e2e-mode"

async function freePort() {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, () => {
      const address = server.address()
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to acquire a free port")))
        return
      }
      server.close((err) => {
        if (err) {
          reject(err)
          return
        }
        resolve(address.port)
      })
    })
  })
}

async function waitForHealth(url: string, authHeader: string) {
  const timeout = Date.now() + 120_000
  const errors: string[] = []
  while (Date.now() < timeout) {
    const result = await fetch(url, { headers: { Authorization: authHeader } })
      .then((r) => ({ ok: r.ok, error: undefined }))
      .catch((error) => ({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }))
    if (result.ok) return
    if (result.error) errors.push(result.error)
    await new Promise((r) => setTimeout(r, 250))
  }
  const last = errors.length ? ` (last error: ${errors[errors.length - 1]})` : ""
  throw new Error(`Timed out waiting for server health: ${url}${last}`)
}

async function boundedCleanup(label: string, cleanup: () => void | Promise<void>, timeoutMs = 10_000, fatal = false) {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.resolve().then(cleanup),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} cleanup timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } catch (error) {
    if (fatal) throw error
    console.warn(`[e2e cleanup] ${label}:`, error)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

const appDir = process.cwd()
const repoDir = path.resolve(appDir, "../..")
const openscienceDir = path.join(repoDir, "backend", "cli")

const extraArgs = forwardedPlaywrightArgs(process.argv.slice(2))

const ports = async (values: number[] = []): Promise<[number, number, number]> => {
  if (values.length === 3) return values as [number, number, number]
  const port = await freePort()
  return ports(values.includes(port) ? values : [...values, port])
}
const [serverPort, webPort, modelPort] = await ports()
const fakeModelServer = startFakeModelServer(modelPort)

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-e2e-"))
const browsers = (() => {
  if (process.env.PLAYWRIGHT_BROWSERS_PATH) return process.env.PLAYWRIGHT_BROWSERS_PATH
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Caches", "ms-playwright")
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "ms-playwright")
  }
  return path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "ms-playwright")
})()

// Pin Basic-Auth creds so the in-process server + the Playwright-hosted
// frontend (via VITE_OPENSCIENCE_SERVER_PASSWORD) agree. Without this, flag.ts
// auto-generates a random UUID password the frontend can't know, every
// request 401s, and the server's Hono onError handler floods stdout with
// `service=server error= failed` until the job times out.
const e2eServerUsername = "openscience"
const e2eServerPassword = "openscience-e2e-local-password"

const serverEnv = {
  ...process.env,
  OPENSCIENCE_DISABLE_SHARE: "true",
  OPENSCIENCE_DISABLE_LSP_DOWNLOAD: "true",
  OPENSCIENCE_DISABLE_DEFAULT_PLUGINS: "true",
  OPENSCIENCE_DISABLE_PROJECT_CONFIG: "true",
  OPENSCIENCE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
  OPENSCIENCE_TEST_HOME: path.join(sandbox, "home"),
  XDG_DATA_HOME: path.join(sandbox, "share"),
  XDG_CACHE_HOME: path.join(sandbox, "cache"),
  XDG_CONFIG_HOME: path.join(sandbox, "config"),
  XDG_STATE_HOME: path.join(sandbox, "state"),
  OPENSCIENCE_E2E_PROJECT_DIR: repoDir,
  OPENSCIENCE_E2E_SESSION_TITLE: "E2E Session",
  OPENSCIENCE_E2E_MESSAGE: "Seeded for UI e2e",
  OPENSCIENCE_E2E_MODEL: fakeModelID,
  OPENSCIENCE_E2E_FAKE_MODEL: "1",
  OPENSCIENCE_CONFIG_CONTENT: JSON.stringify({
    ...fakeModelConfig(`http://127.0.0.1:${modelPort}/v1`),
    // The isolated browser suite does not exercise repository snapshots. The
    // eager scheduler otherwise launches `git gc` against the developer's
    // checkout, races parallel tests, and can recreate the temporary XDG tree
    // after teardown has removed it.
    snapshot: false,
  }),
  OPENSCIENCE_CLIENT: "app",
  OPENSCIENCE_SERVER_USERNAME: e2eServerUsername,
  OPENSCIENCE_SERVER_PASSWORD: e2eServerPassword,
} satisfies Record<string, string>

// The isolated browser harness must never inherit real provider credentials
// from the developer or CI host. Besides leaking state into model lists, an
// inherited key can turn a deterministic UI action into a billable request.
const providerCredentialEnvKeys = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "GOOGLE_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "GOOGLE_GENERATIVE_AI_BASE_URL",
  "GEMINI_API_KEY",
  "GEMINI_BASE_URL",
  "AZURE_OPENAI_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_BEARER_TOKEN_BEDROCK",
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "PERPLEXITY_API_KEY",
  "TOGETHER_API_KEY",
  "XAI_API_KEY",
  "META_MODEL_API_KEY",
  "META_MODEL_BASE_URL",
  "DEEPSEEK_API_KEY",
  "FIREWORKS_API_KEY",
  "CEREBRAS_API_KEY",
  "SAMBANOVA_API_KEY",
] as const

for (const key of providerCredentialEnvKeys) {
  delete serverEnv[key]
}

const runnerEnv = {
  ...serverEnv,
  [E2E_MODE_ENV]: "isolated",
  // App state belongs in the disposable XDG sandbox, but Playwright browsers
  // are host tooling. Keep their persistent cache or every isolated run looks
  // for a browser in a new empty directory.
  PLAYWRIGHT_BROWSERS_PATH: browsers,
  PLAYWRIGHT_SERVER_HOST: "127.0.0.1",
  PLAYWRIGHT_SERVER_PORT: String(serverPort),
  VITE_OPENSCIENCE_SERVER_HOST: "127.0.0.1",
  VITE_OPENSCIENCE_SERVER_PORT: String(serverPort),
  VITE_OPENSCIENCE_SERVER_USERNAME: e2eServerUsername,
  VITE_OPENSCIENCE_SERVER_PASSWORD: e2eServerPassword,
  PLAYWRIGHT_PORT: String(webPort),
} satisfies Record<string, string>

const seed = Bun.spawn(["bun", "script/seed-e2e.ts"], {
  cwd: openscienceDir,
  env: serverEnv,
  stdout: "inherit",
  stderr: "inherit",
})

const seedExit = await seed.exited
if (seedExit !== 0) {
  fakeModelServer.stop(true)
  await fs.rm(sandbox, { recursive: true, force: true })
  process.exit(seedExit)
}

Object.assign(process.env, serverEnv)
// The backend runs in this process, so sanitizing only `serverEnv` is not
// enough: Object.assign does not remove credentials already present in the
// parent shell. Clear them before importing any backend/provider modules.
for (const key of providerCredentialEnvKeys) delete process.env[key]
process.env.AGENT = "1"
process.env.OPENSCIENCE = "1"

const log = await import("../../../backend/cli/src/util/log")
const install = await import("../../../backend/cli/src/installation")
await log.Log.init({
  print: true,
  dev: install.Installation.isLocal(),
  level: "WARN",
})

const servermod = await import("../../../backend/cli/src/server/server")
const inst = await import("../../../backend/cli/src/project/instance")
const server = servermod.Server.listen({ port: serverPort, hostname: "127.0.0.1" })
console.log(`openscience server listening on http://127.0.0.1:${serverPort}`)

// Vite reads VITE_* env vars from .env.local at startup. Writing them
// here (rather than relying on env-var propagation through Playwright's
// webServer config) guarantees the Vite-served frontend bundle picks up
// the matching Basic-Auth credentials. Cleaned up in the finally block.
const envLocalPath = path.join(appDir, ".env.local")
const envLocalBefore = await fs.readFile(envLocalPath).catch((error) => {
  if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
  throw error
})
const envLocalBody = [
  `VITE_OPENSCIENCE_SERVER_HOST=127.0.0.1`,
  `VITE_OPENSCIENCE_SERVER_PORT=${serverPort}`,
  `VITE_OPENSCIENCE_SERVER_USERNAME=${e2eServerUsername}`,
  `VITE_OPENSCIENCE_SERVER_PASSWORD=${e2eServerPassword}`,
  "",
].join("\n")
await fs.writeFile(envLocalPath, envLocalBody)

const result = await (async () => {
  try {
    const healthAuth = `Basic ${Buffer.from(`${e2eServerUsername}:${e2eServerPassword}`).toString("base64")}`
    await waitForHealth(`http://127.0.0.1:${serverPort}/global/health`, healthAuth)

    const runner = Bun.spawn(playwrightCommand(extraArgs), {
      cwd: appDir,
      env: runnerEnv,
      stdout: "inherit",
      stderr: "inherit",
    })

    return { code: await runner.exited }
  } catch (error) {
    return { error }
  } finally {
    fakeModelServer.stop(true)
    await boundedCleanup("backend server", () => server.stop(true), 5_000)
    await boundedCleanup("project instances", () => inst.Instance.disposeAll())
    await Promise.all([
      boundedCleanup(
        ".env.local",
        () =>
          envLocalBefore === undefined
            ? fs.rm(envLocalPath, { force: true })
            : fs.writeFile(envLocalPath, envLocalBefore),
        10_000,
        true,
      ),
      boundedCleanup("sandbox", () => fs.rm(sandbox, { recursive: true, force: true })),
    ])
  }
})()

if ("error" in result) {
  console.error(result.error)
  process.exit(1)
}

process.exit(result.code)

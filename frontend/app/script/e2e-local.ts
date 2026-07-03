import fs from "node:fs/promises"
import net from "node:net"
import os from "node:os"
import path from "node:path"

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

const appDir = process.cwd()
const repoDir = path.resolve(appDir, "../..")
const openscienceDir = path.join(repoDir, "backend", "cli")

const extraArgs = (() => {
  const args = process.argv.slice(2)
  if (args[0] === "--") return args.slice(1)
  return args
})()

const [serverPort, webPort] = await Promise.all([freePort(), freePort()])

const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-e2e-"))

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
  OPENSCIENCE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
  OPENSCIENCE_TEST_HOME: path.join(sandbox, "home"),
  XDG_DATA_HOME: path.join(sandbox, "share"),
  XDG_CACHE_HOME: path.join(sandbox, "cache"),
  XDG_CONFIG_HOME: path.join(sandbox, "config"),
  XDG_STATE_HOME: path.join(sandbox, "state"),
  OPENSCIENCE_E2E_PROJECT_DIR: repoDir,
  OPENSCIENCE_E2E_SESSION_TITLE: "E2E Session",
  OPENSCIENCE_E2E_MESSAGE: "Seeded for UI e2e",
  OPENSCIENCE_E2E_MODEL: "synsci/gpt-5-nano",
  OPENSCIENCE_CLIENT: "app",
  OPENSCIENCE_SERVER_USERNAME: e2eServerUsername,
  OPENSCIENCE_SERVER_PASSWORD: e2eServerPassword,
} satisfies Record<string, string>

const runnerEnv = {
  ...serverEnv,
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
  process.exit(seedExit)
}

Object.assign(process.env, serverEnv)
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

    const runner = Bun.spawn(["bun", "test:e2e", ...extraArgs], {
      cwd: appDir,
      env: runnerEnv,
      stdout: "inherit",
      stderr: "inherit",
    })

    return { code: await runner.exited }
  } catch (error) {
    return { error }
  } finally {
    await inst.Instance.disposeAll()
    await server.stop()
    await fs.rm(envLocalPath, { force: true })
  }
})()

if ("error" in result) {
  console.error(result.error)
  process.exit(1)
}

process.exit(result.code)

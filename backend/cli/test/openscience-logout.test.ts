import { test, expect, afterEach } from "bun:test"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { Global } from "../src/global"
import { OpenScience } from "../src/openscience"

// XDG dirs are isolated per test run by test/preload.ts, so these paths all
// live under the throwaway temp tree — never the developer's real config.
const session = path.join(Global.Path.data, "openscience-session.json")
const synced = path.join(process.env.XDG_CONFIG_HOME!, "openscience")
const snapshot = path.join(synced, "synced-env.json")
const managed = path.join(synced, "openscience-synced.json")
const gcp = path.join(synced, "atlas-gcp-service-account.json")
const queue = path.join(Global.Path.data, "usage-queue.jsonl")
const traceQueue = path.join(Global.Path.data, "telemetry-queue-v2.jsonl")
const traceConsent = path.join(Global.Path.data, "telemetry-consent-v2.json")
const INJECTED = "OPENSCIENCE_TEST_SYNCED_VAR"
const EXPORTED = "OPENSCIENCE_TEST_EXPORTED_VAR"

afterEach(async () => {
  delete process.env[INJECTED]
  delete process.env[EXPORTED]
  for (const file of [session, snapshot, managed, gcp, queue, traceQueue, traceConsent]) {
    await fs.rm(file, { force: true }).catch(() => {})
  }
})

test("clearSession removes every synced credential artifact", async () => {
  await fs.mkdir(Global.Path.data, { recursive: true })
  await fs.mkdir(synced, { recursive: true })

  await Bun.write(session, JSON.stringify({ api_key: "thk_test.secret", user_id: "user-1" }))
  // The persisted snapshot preload-env.ts replays into process.env at boot.
  await Bun.write(snapshot, JSON.stringify({ [INJECTED]: "thk_injected_value", [EXPORTED]: "thk_synced_value" }))
  await Bun.write(managed, JSON.stringify({ model: "synsci/some-model" }))
  await Bun.write(gcp, JSON.stringify({ private_key: "gcp-secret" }))
  await Bun.write(queue, JSON.stringify({ service: "llm", event_type: "chat", tokens_used: 10 }) + "\n")
  await Bun.write(traceQueue, '{"queued":"account-trace"}\n')

  // Simulate preload-env.ts having injected the synced value at boot…
  process.env[INJECTED] = "thk_injected_value"
  // …and a key the user exported in their own shell with a different value.
  process.env[EXPORTED] = "user-exported-value"

  await OpenScience.clearSession()

  expect(await Bun.file(session).exists()).toBe(false)
  expect(await Bun.file(snapshot).exists()).toBe(false)
  expect(await Bun.file(managed).exists()).toBe(false)
  expect(await Bun.file(gcp).exists()).toBe(false)
  expect(await Bun.file(queue).exists()).toBe(false)
  expect(await Bun.file(traceQueue).exists()).toBe(false)

  // The injected var is gone; the shell export survives.
  expect(process.env[INJECTED]).toBeUndefined()
  expect(process.env[EXPORTED]).toBe("user-exported-value")
})

test("logout in one server removes synced env and revokes inherited children in another", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-logout-revision-"))
  const config = path.join(root, "config")
  const managedDir = path.join(config, "openscience")
  const worker = path.join(root, "worker.ts")
  const clear = path.join(root, "clear.ts")
  const ready = path.join(root, "ready")
  const openscience = new URL("../src/openscience/index.ts", import.meta.url).href
  const lifecycle = new URL("../src/credentials/lifecycle.ts", import.meta.url).href
  await fs.mkdir(managedDir, { recursive: true })
  await Bun.write(path.join(managedDir, "synced-env.json"), JSON.stringify({ GITHUB_TOKEN: "cross-synced-secret" }))
  await Bun.write(
    path.join(root, "openscience-session.json"),
    JSON.stringify({ api_key: "thk_test.secret", user_id: "u" }),
  )
  await Bun.write(
    clear,
    [`import { OpenScience } from ${JSON.stringify(openscience)}`, `await OpenScience.clearSession()`].join("\n"),
  )
  await Bun.write(
    worker,
    [
      `import fs from "node:fs/promises"`,
      `import { spawn } from "node:child_process"`,
      `import { OpenScience } from ${JSON.stringify(openscience)}`,
      `import { CredentialLifecycle } from ${JSON.stringify(lifecycle)}`,
      `await CredentialLifecycle.ensureFresh()`,
      `const initial = await OpenScience.subprocessEnv(process.env)`,
      `if (initial.GITHUB_TOKEN !== "cross-synced-secret") throw new Error("worker did not load synced secret")`,
      `const child = spawn(process.execPath, ["-e", "console.log(process.env.GITHUB_TOKEN || 'absent'); setInterval(() => {}, 1000)"], { env: initial, stdio: ["ignore", "pipe", "pipe"] })`,
      `const inherited = await new Promise((resolve, reject) => { child.stdout.once("data", (data) => resolve(String(data).trim())); child.once("error", reject) })`,
      `if (inherited !== "cross-synced-secret") throw new Error("child did not inherit synced secret")`,
      `let revoked = false`,
      `CredentialLifecycle.onRevoke(async () => { revoked = true; child.kill("SIGTERM"); await new Promise((resolve) => child.once("exit", resolve)) })`,
      `CredentialLifecycle.watch(25)`,
      `await fs.writeFile(${JSON.stringify(ready)}, "ready")`,
      `for (let i = 0; i < 400 && !revoked; i++) await Bun.sleep(10)`,
      `await CredentialLifecycle.ensureFresh()`,
      `if (!revoked || (child.exitCode === null && child.signalCode === null)) throw new Error("synced child was not revoked")`,
      `if (process.env.GITHUB_TOKEN !== undefined) throw new Error("logout left synced secret in process.env")`,
      `const next = await OpenScience.subprocessEnv(process.env)`,
      `if (next.GITHUB_TOKEN !== undefined) throw new Error("new child env retained logged-out secret")`,
      `CredentialLifecycle.stopWatching()`,
    ].join("\n"),
  )
  const env = {
    ...process.env,
    GITHUB_TOKEN: "cross-synced-secret",
    OPENSCIENCE_DATA_DIR: root,
    OPENSCIENCE_CONFIG_DIR: managedDir,
    OPENSCIENCE_TEST_HOME: path.join(root, "home"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
  }

  try {
    const live = Bun.spawn([process.execPath, worker], { env, stdout: "pipe", stderr: "pipe" })
    for (let i = 0; i < 400 && !(await Bun.file(ready).exists()); i++) await Bun.sleep(10)
    expect(await Bun.file(ready).exists()).toBe(true)
    const deleter = Bun.spawn([process.execPath, clear], { env, stdout: "pipe", stderr: "pipe" })
    const [clearExit, clearError] = await Promise.all([deleter.exited, new Response(deleter.stderr).text()])
    if (clearExit !== 0) throw new Error(clearError)
    const [exit, error] = await Promise.all([live.exited, new Response(live.stderr).text()])
    if (exit !== 0) throw new Error(error)
    expect(exit).toBe(0)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

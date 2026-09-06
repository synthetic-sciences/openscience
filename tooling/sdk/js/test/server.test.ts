import assert from "node:assert/strict"
import { afterEach, describe, test } from "node:test"
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { createOpenScienceServer } from "../src/v2/server.js"
import { createOpenScienceServer as createLegacyServer } from "../src/server.js"
import { createOpenScienceClient } from "../src/v2/client.js"
import { createOpenScience } from "../src/v2/index.js"
import { createOpenScience as createLegacyOpenScience } from "../src/index.js"

const fixture = fileURLToPath(new URL("./fixtures/server.mjs", import.meta.url))
const directories: string[] = []
const children: Awaited<ReturnType<typeof createOpenScienceServer>>[] = []

async function directory() {
  const value = await mkdtemp(path.join(tmpdir(), "openscience-sdk-server-"))
  directories.push(value)
  return value
}

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function options(cwd: string, mode?: string) {
  return {
    executablePath: process.execPath,
    executableArgs: [fixture],
    cwd,
    port: 0,
    timeout: 3000,
    shutdownTimeout: 1000,
    env: {
      SDK_FIXTURE_MODE: mode,
      SDK_FIXTURE_PID: path.join(cwd, "pid"),
      SDK_FIXTURE_STOP: path.join(cwd, "stopped"),
      OPENSCIENCE_AUTH_TOKEN: undefined,
    },
  }
}

afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => child.close()))
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("owned OpenScience server processes", () => {
  test("launches an explicit executable, passes config/cwd/env, checks health and awaits shutdown", async () => {
    const cwd = await directory()
    const input = options(cwd)
    const child = await createOpenScienceServer({
      ...input,
      env: { ...input.env, SDK_FIXTURE_MARKER: "integration", OPENSCIENCE_AUTH_TOKEN: "fixture-secret" },
      config: { logLevel: "ERROR" },
    })
    children.push(child)
    const response = await fetch(`${child.url}/global/health`, { headers: { authorization: "Bearer fixture-secret" } })
    const health = await response.json()
    assert.equal(health.cwd, await realpath(cwd))
    assert.equal(health.marker, "integration")
    assert.deepEqual(health.config, { logLevel: "ERROR" })
    assert.deepEqual(health.arguments, ["serve", "--port", "0", "--log-level", "ERROR"])
    assert.equal(alive(child.pid), true)
    const closing = child.close()
    assert.equal(child.close(), closing)
    await closing
    assert.equal(await readFile(path.join(cwd, "stopped"), "utf8"), "closed")
    assert.equal(alive(child.pid), false)
  })

  for (const [version, create] of [
    ["v2", createOpenScience],
    ["legacy", createLegacyOpenScience],
  ] as const) {
    test(`${version} convenience factory forwards the child credential and working directory`, async () => {
      const cwd = await directory()
      const input = options(cwd)
      const { client, server } = await create({
        ...input,
        env: { ...input.env, OPENSCIENCE_AUTH_TOKEN: "factory-secret" },
      })
      children.push(server)
      const result = await client.session.list()
      assert.equal(result.response?.status, 200)
      assert.equal((result.data as unknown as { healthy: boolean }).healthy, true)
      assert.equal((result.data as unknown as { directory: string }).directory, cwd)
      assert.equal((await fetch(`${server.url}/global/health`)).status, 401)
      await server.close()
      assert.equal(alive(server.pid), false)
    })
  }

  test("keeps the legacy launcher and human readiness announcement compatible", async () => {
    const child = await createLegacyServer(options(await directory(), "legacy"))
    children.push(child)
    assert.equal((await fetch(`${child.url}/global/health`)).status, 200)
  })

  for (const [mode, message] of [
    ["timeout", /Timeout waiting/],
    ["hang-health", /Timeout waiting/],
    ["unhealthy", /health check/],
    ["exit", /fixture refused startup/],
    ["wrong-pid", /process mismatch/],
    ["remote-url", /invalid local server URL/],
  ] as const) {
    test(`cleans up the owned child after ${mode}`, async () => {
      const cwd = await directory()
      await assert.rejects(createOpenScienceServer({ ...options(cwd, mode), timeout: 500 }), message)
      const pid = Number(await readFile(path.join(cwd, "pid"), "utf8"))
      assert.equal(alive(pid), false)
    })
  }

  test("forces only its owned child after the shutdown grace period", async () => {
    const child = await createOpenScienceServer({ ...options(await directory(), "ignore-term"), shutdownTimeout: 50 })
    children.push(child)
    await child.close()
    assert.equal(alive(child.pid), false)
  })

  test("rejects a missing executable without leaving a startup timer", async () => {
    await assert.rejects(
      createOpenScienceServer({ executablePath: path.join(await directory(), "missing"), timeout: 1000 }),
      /ENOENT/,
    )
  })

  test("aborting before launch creates no child", async () => {
    const cwd = await directory()
    await assert.rejects(createOpenScienceServer({ ...options(cwd), signal: AbortSignal.abort() }), /abort/i)
    await assert.rejects(readFile(path.join(cwd, "pid")), /ENOENT/)
  })

  test("aborting startup cleans up a child whose health request has not returned", async () => {
    const cwd = await directory()
    const controller = new AbortController()
    const pending = createOpenScienceServer({ ...options(cwd, "hang-health"), signal: controller.signal })
    const rejected = assert.rejects(pending, /abort/i)
    try {
      const wait = async (attempt = 0): Promise<number> => {
        const value = await readFile(path.join(cwd, "pid"), "utf8").catch(() => undefined)
        if (value) return Number(value)
        if (attempt >= 200) throw new Error("Fixture did not start")
        await delay(10)
        return wait(attempt + 1)
      }
      const pid = await wait()
      controller.abort()
      await rejected
      assert.equal(alive(pid), false)
    } finally {
      controller.abort()
      await rejected
    }
  })

  test("aborting after readiness closes the owned child", async () => {
    const controller = new AbortController()
    const child = await createOpenScienceServer({ ...options(await directory()), signal: controller.signal })
    children.push(child)
    controller.abort()
    await child.close()
    assert.equal(alive(child.pid), false)
  })

  test("an attached client cannot take ownership of the server it observes", async () => {
    const child = await createOpenScienceServer(options(await directory()))
    children.push(child)
    const controller = new AbortController()
    const client = createOpenScienceClient({ baseUrl: child.url, signal: controller.signal })
    assert.equal((await client.global.health()).data?.healthy, true)
    controller.abort()
    assert.equal(alive(child.pid), true)
    assert.equal((await fetch(`${child.url}/global/health`)).status, 200)
  })
})

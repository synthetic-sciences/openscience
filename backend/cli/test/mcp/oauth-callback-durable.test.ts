import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import os from "node:os"
import fs from "node:fs/promises"
import { pathToFileURL } from "node:url"
import { Global } from "../../src/global"
import { McpAuth } from "../../src/mcp/auth"
import {
  McpOAuthCallback,
  OAUTH_AUTHORIZATION_FAILED_MESSAGE,
  OAuthAuthorizationFailedError,
} from "../../src/mcp/oauth-callback"
import { OAUTH_CALLBACK_PATH, OAUTH_CALLBACK_PORT } from "../../src/mcp/oauth-provider"
import { Log } from "../../src/util/log"

const created = new Set<string>()

afterEach(async () => {
  await McpOAuthCallback.stop()
  await Promise.all([...created].map((name) => McpAuth.remove(name).catch(() => undefined)))
  created.clear()
})

async function flow(label: string) {
  const name = `${label}-${crypto.randomUUID()}`
  const state = crypto.randomUUID().replaceAll("-", "")
  created.add(name)
  await McpAuth.updateOAuthState(name, state)
  return { name, state }
}

async function callback(state: string, code: string) {
  return fetch(
    `http://127.0.0.1:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}?state=${encodeURIComponent(state)}&code=${encodeURIComponent(code)}`,
  )
}

test("a callback received before a waiter survives a process restart boundary", async () => {
  const auth = await flow("restart")
  await McpOAuthCallback.ensureRunning()

  expect((await callback(auth.state, "restart-code")).status).toBe(200)
  await McpOAuthCallback.stop()

  await expect(McpOAuthCallback.waitForCallback(auth.name, auth.state)).resolves.toBe("restart-code")
  const disk = await Bun.file(path.join(Global.Path.data, "mcp-auth.json")).text()
  expect(disk).not.toContain("restart-code")
})

test("provider-controlled callback errors are represented by booleans in logs", async () => {
  const auth = await flow("callback-log-redaction")
  const errorMarker = `provider-error-${crypto.randomUUID()}`
  const descriptionMarker = `provider-description-${crypto.randomUUID()}`
  await McpOAuthCallback.ensureRunning()
  const waiting = McpOAuthCallback.waitForCallback(auth.name, auth.state).then(
    () => undefined,
    (error) => error as Error,
  )
  await Log.flush()
  const before = await Bun.file(Log.file()).text()

  const response = await fetch(
    `http://127.0.0.1:${OAUTH_CALLBACK_PORT}${OAUTH_CALLBACK_PATH}` +
      `?state=${encodeURIComponent(auth.state)}` +
      `&error=${encodeURIComponent(errorMarker)}` +
      `&error_description=${encodeURIComponent(descriptionMarker)}`,
  )
  expect(response.status).toBe(400)
  const failure = await waiting
  expect(failure).toBeInstanceOf(OAuthAuthorizationFailedError)
  expect(failure?.message).toBe(OAUTH_AUTHORIZATION_FAILED_MESSAGE)
  await Log.flush()
  const appended = (await Bun.file(Log.file()).text()).slice(before.length)

  expect(appended).toContain("hasError=true")
  expect(appended).not.toContain(errorMarker)
  expect(appended).not.toContain(descriptionMarker)
})

test("the callback-server process can hand a code to a different OpenScience process", async () => {
  const auth = await flow("two-process")
  await McpOAuthCallback.ensureRunning()
  const module = pathToFileURL(path.join(import.meta.dir, "../../src/mcp/oauth-callback.ts")).href
  const script = [
    `const { McpOAuthCallback } = await import(${JSON.stringify(module)})`,
    `const code = await McpOAuthCallback.waitForCallback(${JSON.stringify(auth.name)}, ${JSON.stringify(auth.state)})`,
    `process.stdout.write(code)`,
  ].join(";")
  const child = Bun.spawn([process.execPath, "-e", script], {
    env: {
      ...process.env,
      OPENSCIENCE_DATA_DIR: Global.Path.data,
      OPENSCIENCE_CONFIG_DIR: Global.Path.config,
      OPENSCIENCE_TEST_HOME: Global.Path.home,
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  await Bun.sleep(100)
  expect((await callback(auth.state, "cross-process-code")).status).toBe(200)
  const [exit, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ])
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" })
  expect(stdout).toBe("cross-process-code")
})

test("cancellation rejects the exact named flow without touching another flow", async () => {
  const first = await flow("cancel-first")
  const second = await flow("cancel-second")
  const firstWait = McpOAuthCallback.waitForCallback(first.name, first.state)
  const secondWait = McpOAuthCallback.waitForCallback(second.name, second.state)
  const firstResult = firstWait.then(
    () => undefined,
    (error) => error as Error,
  )
  const secondResult = secondWait.then(
    (code) => ({ code }),
    (error) => ({ error: error as Error }),
  )

  await McpOAuthCallback.cancelPending(first.name, first.state)
  expect((await firstResult)?.message).toBe("Authorization cancelled")
  await McpAuth.recordOAuthCallback(second.state, { type: "code", value: "second-code" })
  expect(await secondResult).toEqual({ code: "second-code" })
})

test("a stale exact-state cancellation cannot cancel a replacement flow", async () => {
  const name = `replacement-${crypto.randomUUID()}`
  const first = `first-${crypto.randomUUID()}`
  const second = `second-${crypto.randomUUID()}`
  await McpAuth.updateOAuthState(name, first)
  await McpAuth.clearOAuthFlow(name, first)
  await McpAuth.updateOAuthState(name, second)

  expect(await McpOAuthCallback.cancelPending(name, first)).toBeFalse()
  expect((await McpAuth.pendingOAuthFlow(name))?.state).toBe(second)

  await McpOAuthCallback.cancelPending(name, second)
  await McpAuth.clearOAuthFlow(name, second)
})

test("simultaneous same-profile processes share the callback owner bind race", async () => {
  await McpOAuthCallback.stop()
  const module = pathToFileURL(path.join(import.meta.dir, "../../src/mcp/oauth-callback.ts")).href
  const files = [0, 1].map((index) => path.join(os.tmpdir(), `openscience-oauth-ready-${crypto.randomUUID()}-${index}`))
  const children = files.map((ready) =>
    Bun.spawn(
      [
        process.execPath,
        "-e",
        [
          `const { McpOAuthCallback } = await import(${JSON.stringify(module)})`,
          `await McpOAuthCallback.ensureRunning()`,
          `await Bun.write(${JSON.stringify(ready)}, "ready")`,
          `await Bun.sleep(30000)`,
        ].join(";"),
      ],
      {
        env: {
          ...process.env,
          OPENSCIENCE_DATA_DIR: Global.Path.data,
          OPENSCIENCE_CONFIG_DIR: Global.Path.config,
          OPENSCIENCE_TEST_HOME: Global.Path.home,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    ),
  )

  try {
    for (let attempt = 0; attempt < 300; attempt++) {
      if ((await Promise.all(files.map((file) => Bun.file(file).exists()))).every(Boolean)) break
      await Bun.sleep(10)
    }
    const ready = await Promise.all(files.map((file) => Bun.file(file).exists()))
    const errors = await Promise.all(
      children.map((child) => (child.exitCode === null ? Promise.resolve("") : new Response(child.stderr).text())),
    )
    expect({ ready, errors, exits: children.map((child) => child.exitCode) }).toEqual({
      ready: [true, true],
      errors: ["", ""],
      exits: [null, null],
    })
    expect(children.every((child) => child.exitCode === null)).toBe(true)
  } finally {
    children.forEach((child) => child.kill("SIGTERM"))
    await Promise.all(children.map((child) => child.exited))
    await Promise.all(files.map((file) => fs.rm(file, { force: true })))
  }
})

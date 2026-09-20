import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createOpenScienceServer } from "../../../../tooling/sdk/js/src/v2/server"
import { DESKTOP_SERVER_FILE, localServerBase, probeLocalServer, readDesktopServer } from "../../src/cli/local-server"

test("source serve announces readiness, serves health and shuts down after SIGTERM with an open event stream", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-serve-lifecycle-"))
  const child = await createOpenScienceServer({
    executablePath: process.execPath,
    executableArgs: [
      "--no-env-file",
      "run",
      "--conditions=browser",
      path.resolve(import.meta.dir, "../../src/bootstrap.ts"),
    ],
    cwd: root,
    port: 0,
    timeout: 15_000,
    env: {
      OPENSCIENCE_DATA_DIR: path.join(root, "data"),
      OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
      OPENSCIENCE_TEST_HOME: path.join(root, "home"),
      OPENSCIENCE_AUTH_TOKEN: undefined,
      OPENSCIENCE_DESKTOP_PARENT_PID: undefined,
      OPENSCIENCE_DESKTOP_PARENT_TOKEN: undefined,
      OPENSCIENCE_DISABLE_MODELS_FETCH: "true",
      OPENSCIENCE_DISABLE_DEFAULT_PLUGINS: "true",
      OPENSCIENCE_DISABLE_BUNDLED_SKILLS: "true",
      OPENSCIENCE_DISABLE_AUTOUPDATE: "true",
      OPENSCIENCE_SKIP_ENVIRONMENT_BOOTSTRAP: "true",
      OPENSCIENCE_API_BASE: "http://127.0.0.1:9",
      XDG_DATA_HOME: path.join(root, "xdg-data"),
      XDG_CONFIG_HOME: path.join(root, "xdg-config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
    },
  }).catch(async (error) => {
    await fs.rm(root, { recursive: true, force: true })
    throw error
  })
  const controller = new AbortController()
  try {
    const health = await fetch(`${child.url}/global/health`).then((response) => response.json())
    expect(health.healthy).toBe(true)
    const response = await fetch(`${child.url}/global/event`, { signal: controller.signal })
    const reader = response.body!.getReader()
    expect((await reader.read()).done).toBe(false)
    await child.close()
    expect(() => process.kill(child.pid, 0)).toThrow()
    await reader.cancel().catch(() => undefined)
  } finally {
    controller.abort()
    await child.close()
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)

test("a desktop-spawned sidecar advertises its port in the data root and withdraws it on shutdown", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-desktop-advert-"))
  const data = path.join(root, "data")
  const child = await createOpenScienceServer({
    executablePath: process.execPath,
    executableArgs: [
      "--no-env-file",
      "run",
      "--conditions=browser",
      path.resolve(import.meta.dir, "../../src/bootstrap.ts"),
    ],
    cwd: root,
    port: 0,
    timeout: 15_000,
    env: {
      OPENSCIENCE_DATA_DIR: data,
      OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
      OPENSCIENCE_TEST_HOME: path.join(root, "home"),
      OPENSCIENCE_AUTH_TOKEN: undefined,
      // What the Electron shell binds its sidecar with. The parent must be
      // this test process, which is what spawned the child.
      OPENSCIENCE_DESKTOP_PARENT_PID: String(process.pid),
      OPENSCIENCE_DESKTOP_PARENT_TOKEN: "d".repeat(48),
      OPENSCIENCE_DISABLE_MODELS_FETCH: "true",
      OPENSCIENCE_DISABLE_DEFAULT_PLUGINS: "true",
      OPENSCIENCE_DISABLE_BUNDLED_SKILLS: "true",
      OPENSCIENCE_DISABLE_AUTOUPDATE: "true",
      OPENSCIENCE_SKIP_ENVIRONMENT_BOOTSTRAP: "true",
      OPENSCIENCE_API_BASE: "http://127.0.0.1:9",
      XDG_DATA_HOME: path.join(root, "xdg-data"),
      XDG_CONFIG_HOME: path.join(root, "xdg-config"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
    },
  }).catch(async (error) => {
    await fs.rm(root, { recursive: true, force: true })
    throw error
  })
  const advertised = path.join(await fs.realpath(data), DESKTOP_SERVER_FILE)
  try {
    const record = await readDesktopServer(path.dirname(advertised))
    expect(record).toMatchObject({ schema: 1, port: Number(new URL(child.url).port), pid: child.pid })
    // The advertised port is the live server, not a guess. A source build has
    // no embedded workspace, so the stricter version.json probe a terminal
    // launch runs on top of this has its own coverage in local-server.test.ts.
    expect(await probeLocalServer(localServerBase(record!.port))).toBe(true)
    // The recorded run id is the one this server answers health with, so the
    // record can only ever be redeemed against the process that wrote it.
    const health = await fetch(`${localServerBase(record!.port)}/global/health`, {
      headers: { accept: "application/json" },
    }).then((response) => response.json())
    expect(record!.run_id).toBe(health.runId)
    expect(await probeLocalServer(localServerBase(record!.port), record!.run_id)).toBe(true)
    expect(await probeLocalServer(localServerBase(record!.port), "another-run")).toBe(false)

    await child.close()
    expect(await Bun.file(advertised).exists()).toBe(false)
  } finally {
    await child.close()
    await fs.rm(root, { recursive: true, force: true })
  }
}, 30_000)

import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CliSettingsRoutes, cliSettingsApp } from "../../src/server/routes/settings/cli"
import { CliShim } from "../../src/installation/cli-shim"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function desktop() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-cli-routes-"))
  roots.push(root)
  const home = path.join(root, "home")
  await fs.mkdir(home, { recursive: true })
  await fs.writeFile(path.join(home, ".zshrc"), "")
  const execPath = path.join(root, "Applications", "OpenScience.app", "Contents", "Resources", "sidecar", "openscience")
  await fs.mkdir(path.dirname(execPath), { recursive: true })
  await fs.writeFile(execPath, "#!/bin/sh\n", { mode: 0o755 })
  const options: CliShim.Options = {
    home,
    execPath,
    env: { SHELL: "/bin/zsh", PATH: "/usr/bin:/bin" },
    platform: "darwin",
  }
  return { home, execPath, options, app: cliSettingsApp(options) }
}

describe("/settings/cli routes", () => {
  test("GET / reports the status of this copy", async () => {
    const response = await CliSettingsRoutes().request("/")
    expect(response.status).toBe(200)
    const body = CliShim.Status.parse(await response.json())
    expect(body.path).toBe(path.join(body.directory, "openscience"))
    expect(body.line).toContain(body.directory)
    // The test runner is neither a bundle nor a desktop sidecar.
    expect(body.installable).toBe(false)
    expect(body.reason).toBe("Only the OpenScience desktop app can install its command-line tool.")
  })

  test("POST /install refuses outside the desktop app and creates nothing", async () => {
    const before = CliShim.Status.parse(await (await CliSettingsRoutes().request("/")).json())
    const response = await CliSettingsRoutes().request("/install", { method: "POST" })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: before.reason })
    expect(await fs.lstat(before.path).catch(() => undefined)).toBeUndefined()
  })

  test("POST /install links the bundle and adds the PATH line for a desktop sidecar", async () => {
    const f = await desktop()
    const idle = CliShim.Status.parse(await (await f.app.request("/")).json())
    expect(idle).toMatchObject({ exists: false, installable: true, onPath: false })

    const response = await f.app.request("/install", { method: "POST" })
    expect(response.status).toBe(200)
    const installed = CliShim.Status.parse(await response.json())
    expect(installed).toMatchObject({ exists: true, current: true, ours: true, onPath: true, target: f.execPath })
    expect(await fs.readlink(installed.path)).toBe(f.execPath)
    expect(await Bun.file(path.join(f.home, ".zshrc")).text()).toBe(`\n# openscience\n${installed.line}\n`)

    const again = CliShim.Status.parse(await (await f.app.request("/")).json())
    expect(again).toEqual(installed)
  })

  test("POST /install keeps a command-line install the app did not create", async () => {
    const f = await desktop()
    const link = path.join(f.home, ".openscience", "bin", "openscience")
    await fs.mkdir(path.dirname(link), { recursive: true })
    await fs.writeFile(link, "standalone")
    const response = await f.app.request("/install", { method: "POST" })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({ error: expect.stringContaining("did not create") })
    expect(await Bun.file(link).text()).toBe("standalone")
    expect(await Bun.file(path.join(f.home, ".zshrc")).text()).toBe("")
  })
})

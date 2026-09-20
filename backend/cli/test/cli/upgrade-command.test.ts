import { afterAll, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { upgradeAction } from "../../src/cli/cmd/upgrade"

const cli = path.join(import.meta.dir, "../../src/index.ts")
const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-upgrade-command-"))

afterAll(() => fs.rm(root, { recursive: true, force: true }))

// The install method is read from the executable's own path, so the only way
// to run the CLI as a desktop copy is to put a runnable binary where the app
// keeps its sidecar. A hard link costs nothing; a copy is the fallback when
// the temp directory lives on another filesystem.
async function desktopCopy() {
  const bundle = path.join(root, "OpenScience.app", "Contents", "Resources", "sidecar")
  await fs.mkdir(bundle, { recursive: true })
  const binary = path.join(bundle, "openscience")
  // A hard link shares the real Bun binary's inode, so chmod on the link would
  // change the mode of the actual executable running this test. Only the copy
  // fallback is a file of its own and needs its own chmod.
  await fs.link(process.execPath, binary).catch(async () => {
    await fs.copyFile(process.execPath, binary)
    await fs.chmod(binary, 0o755)
  })
  return binary
}

async function upgrade(executable: string, target: string) {
  const proc = Bun.spawn([executable, "run", cli, "upgrade", target], {
    cwd: root,
    env: {
      ...process.env,
      HOME: path.join(root, "home"),
      OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
      OPENSCIENCE_DATA_DIR: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
      OPENSCIENCE_DISABLE_PROJECT_CONFIG: "1",
      OPENSCIENCE_DISABLE_DEFAULT_PLUGINS: "1",
      OPENSCIENCE_DISABLE_BUNDLED_SKILLS: "1",
      OPENSCIENCE_DISABLE_MODELS_FETCH: "1",
      OPENSCIENCE_DISABLE_AUTOUPDATE: "1",
      OPENSCIENCE_DESKTOP_UPDATE_URL: undefined,
      OPENSCIENCE_DESKTOP_UPDATE_TOKEN: undefined,
      CI: "1",
      NO_COLOR: "1",
      TERM: "dumb",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  await proc.exited
  return `${stdout}${stderr}`
}

describe("openscience upgrade on a desktop install", () => {
  test("sends a terminal to the app instead of reporting a dev install", async () => {
    const output = await upgrade(await desktopCopy(), "9.9.9")

    expect(output).not.toContain("Manual or dev install detected")
    expect(output).toContain("command-line sidecar")
    expect(output).toContain("Check for updates")
    expect(output).toContain("https://openscience.sh/download")
  }, 30_000)

  test("still reports a manual or dev install elsewhere", async () => {
    const output = await upgrade(process.execPath, "9.9.9")

    expect(output).toContain("Manual or dev install detected")
    expect(output).not.toContain("command-line sidecar")
  }, 30_000)

  test("drives the app's own updater while the app is what started it", () => {
    expect(upgradeAction({ method: "desktop", desktopUpdates: true })).toBe("upgrade")
    expect(upgradeAction({ method: "desktop", desktopUpdates: false })).toBe("desktop-app")
    expect(upgradeAction({ method: "curl", desktopUpdates: false })).toBe("upgrade")
    expect(upgradeAction({ method: "unknown", desktopUpdates: false })).toBe("manual")
  })
})

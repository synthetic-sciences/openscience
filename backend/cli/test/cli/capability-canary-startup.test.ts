import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

const entry = path.resolve(import.meta.dir, "../../src/index.ts")

for (const argv of [
  ["--print-logs", "debug", "capability-canary", "missing-startup-canary"],
  ["--log-level", "INFO", "debug", "--print-logs", "capability-canary", "missing-startup-canary"],
  ["debug", "capability-canary", "missing-startup-canary", "--print-logs"],
]) {
  test(`canary flags do not start unrelated environments: ${argv.join(" ")}`, async () => {
    await using tmp = await tmpdir()
    const data = path.join(tmp.path, "data")
    const blocker = path.join(data, "conda")
    // A mistaken background bootstrap fails immediately instead of downloading
    // packages. The unknown canary itself never requests environment setup.
    await Bun.write(blocker, "no unrelated environment setup")
    const env = Object.fromEntries(
      Object.entries(process.env).filter(([name, value]) =>
        value === undefined ? false : ["PATH", "HOME", "USER", "LOGNAME", "SHELL", "TMPDIR", "LANG"].includes(name),
      ),
    )
    const proc = Bun.spawn([process.execPath, "--no-env-file", entry, ...argv], {
      cwd: tmp.path,
      env: {
        ...env,
        OPENSCIENCE_TEST_HOME: tmp.path,
        OPENSCIENCE_TEST_MANAGED_ENVIRONMENTS: "1",
        OPENSCIENCE_CONFIG_DIR: path.join(tmp.path, "config"),
        OPENSCIENCE_DATA_DIR: data,
        XDG_CACHE_HOME: path.join(tmp.path, "cache"),
        XDG_CONFIG_HOME: path.join(tmp.path, "xdg-config"),
        XDG_DATA_HOME: path.join(tmp.path, "share"),
        XDG_STATE_HOME: path.join(tmp.path, "state"),
        OPENSCIENCE_DISABLE_DEFAULT_PLUGINS: "true",
        OPENSCIENCE_DISABLE_PROJECT_CONFIG: "true",
        OPENSCIENCE_DISABLE_LSP_DOWNLOAD: "true",
        OPENSCIENCE_DISABLE_SHARE: "true",
        OPENSCIENCE_EXPERIMENTAL_DISABLE_FILEWATCHER: "true",
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const timer = setTimeout(() => proc.kill(), 10_000)
    const [exit, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]).finally(() => clearTimeout(timer))
    expect(exit).toBe(1)
    expect(stdout + stderr).toContain("Unknown scientific capability: missing-startup-canary")
    expect(stderr).not.toContain("starter environment setup failed")
    expect(await Bun.file(blocker).text()).toBe("no unrelated environment setup")
  })
}

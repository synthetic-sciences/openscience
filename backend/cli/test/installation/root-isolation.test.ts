import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const cli = path.join(import.meta.dir, "../../src/index.ts")

async function tree(root: string) {
  const rows: string[] = []
  const walk = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(dir, entry.name)
      const rel = path.relative(root, file)
      if (entry.isDirectory()) {
        rows.push(`${rel}/`)
        await walk(file)
        continue
      }
      rows.push(`${rel}:${await Bun.file(file).text()}`)
    }
  }
  await walk(root)
  return rows
}

describe("isolated config and data roots", () => {
  test("doctor stays inside explicit roots and config discovery is dependency-passive", async () => {
    const scope = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-isolated-roots-"))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-normal-roots-"))
    const config = path.join(scope, "config")
    const data = path.join(scope, "data")
    const project = path.join(scope, "project")
    const xdg = path.join(outside, "config", "openscience")
    const target = path.join(outside, "pointed-data")

    await Promise.all([
      fs.mkdir(config, { recursive: true }),
      fs.mkdir(project, { recursive: true }),
      fs.mkdir(xdg, { recursive: true }),
      fs.mkdir(target, { recursive: true }),
    ])
    await Promise.all([
      Bun.write(path.join(config, "openscience.json"), "{}\n"),
      Bun.write(path.join(xdg, "data-location"), target),
      Bun.write(path.join(outside, "sentinel"), "unchanged\n"),
    ])
    const before = await tree(outside)

    try {
      const proc = Bun.spawn([process.execPath, cli, "doctor"], {
        cwd: project,
        env: {
          ...process.env,
          HOME: path.join(outside, "home"),
          XDG_CONFIG_HOME: path.join(outside, "config"),
          XDG_DATA_HOME: path.join(outside, "share"),
          XDG_CACHE_HOME: path.join(scope, "cache"),
          XDG_STATE_HOME: path.join(scope, "state"),
          OPENSCIENCE_CONFIG_DIR: config,
          OPENSCIENCE_DATA_DIR: data,
          OPENSCIENCE_DISABLE_PROJECT_CONFIG: "1",
          OPENSCIENCE_DISABLE_DEFAULT_PLUGINS: "1",
          OPENSCIENCE_DISABLE_BUNDLED_SKILLS: "1",
          OPENSCIENCE_DISABLE_MODELS_FETCH: "1",
          OPENSCIENCE_DISABLE_AUTOUPDATE: "1",
          OPENSCIENCE_API_BASE: "http://127.0.0.1:9",
          BUN_CONFIG_REGISTRY: "http://127.0.0.1:9",
          CI: "1",
          NO_COLOR: "1",
          TERM: "dumb",
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])

      expect(code, stderr).toBe(0)
      expect(stdout).toContain(
        `Platform package: @synsci/openscience-${process.platform === "win32" ? "windows" : process.platform}-${process.arch}`,
      )
      expect(stdout).toContain(`Config root: ${config}`)
      expect(stdout).toContain(`Data root: ${await fs.realpath(data)}`)
      expect(stdout).toContain(`Cache root: ${path.join(scope, "cache", "openscience")}`)
      expect(stdout).toContain(`State root: ${path.join(scope, "state", "openscience")}`)
      expect(await tree(outside)).toEqual(before)
      expect((await fs.readdir(config)).toSorted()).toEqual(["data-root-operations", "openscience.json"])
      expect(await fs.stat(data).then((stat) => stat.isDirectory())).toBe(true)
    } finally {
      await Promise.all([
        fs.rm(scope, { recursive: true, force: true }),
        fs.rm(outside, { recursive: true, force: true }),
      ])
    }
  })
})

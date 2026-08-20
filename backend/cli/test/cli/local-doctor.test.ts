import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const cli = path.join(import.meta.dir, "../../src/index.ts")

describe("local model diagnostics", () => {
  test("doctor sees a local default immediately after non-interactive local add", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-local-doctor-"))
    const project = path.join(root, "project")
    const config = path.join(root, "config")
    const data = path.join(root, "data")
    await Promise.all([fs.mkdir(project, { recursive: true }), fs.mkdir(config, { recursive: true })])

    const env = {
      ...process.env,
      HOME: path.join(root, "home"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      XDG_STATE_HOME: path.join(root, "state"),
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
    }

    try {
      const added = Bun.spawn(
        [
          process.execPath,
          cli,
          "local",
          "add",
          "--url",
          "http://127.0.0.1:11434/v1",
          "--model",
          "fixture-model",
          "--id",
          "local-fixture",
          "--default",
        ],
        { cwd: project, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
      )
      const [addOut, addErr, addCode] = await Promise.all([
        new Response(added.stdout).text(),
        new Response(added.stderr).text(),
        added.exited,
      ])
      expect(addCode, addErr).toBe(0)
      expect(addOut).toContain("Default model set to local-fixture/fixture-model")

      const doctor = Bun.spawn([process.execPath, cli, "doctor"], {
        cwd: project,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(doctor.stdout).text(),
        new Response(doctor.stderr).text(),
        doctor.exited,
      ])

      expect(code, stderr).toBe(0)
      expect(stdout).toContain("Local models: local-fixture")
      expect(stdout).toContain("Default model: local-fixture/fixture-model")
      expect(stdout).not.toContain("No model source configured")
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})

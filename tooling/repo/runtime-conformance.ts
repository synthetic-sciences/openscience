#!/usr/bin/env bun

import path from "node:path"
import os from "node:os"
import fs from "node:fs/promises"
import { createOpenScienceServer } from "@synsci/sdk/v2/server"

const binary = process.argv[2]
if (!binary) throw new Error("Usage: bun tooling/repo/runtime-conformance.ts /absolute/path/to/openscience [python]")
if (!path.isAbsolute(binary)) throw new Error("Use an absolute executable path")
const python = process.argv[3] ?? "python3"
const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-public-conformance-"))
const project = path.join(root, "project")
await fs.mkdir(project)
const token = crypto.randomUUID()
const environment = {
  HOME: path.join(root, "home"),
  OPENSCIENCE_TEST_HOME: path.join(root, "home"),
  OPENSCIENCE_DATA_DIR: path.join(root, "data"),
  OPENSCIENCE_CONFIG_DIR: path.join(root, "config"),
  XDG_DATA_HOME: path.join(root, "xdg-data"),
  XDG_CONFIG_HOME: path.join(root, "xdg-config"),
  XDG_CACHE_HOME: path.join(root, "xdg-cache"),
  XDG_STATE_HOME: path.join(root, "xdg-state"),
  OPENSCIENCE_AUTH_TOKEN: token,
  OPENSCIENCE_API_BASE: "http://127.0.0.1:9",
  OPENSCIENCE_DISABLE_MODELS_FETCH: "true",
  OPENSCIENCE_DISABLE_DEFAULT_PLUGINS: "true",
  OPENSCIENCE_DISABLE_AUTOUPDATE: "true",
  OPENSCIENCE_CONFIG_CONTENT: "{}",
  ATLAS_CLI_CONFIG_PATH: path.join(root, "atlas-cli.json"),
}

try {
  const server = await createOpenScienceServer({
    executablePath: binary,
    cwd: project,
    port: 0,
    timeout: 20_000,
    env: environment,
  })
  try {
    const script = path.resolve(import.meta.dir, "../sdk/python/tests/server_conformance.py")
    const child = Bun.spawn([python, script, server.url], {
      env: {
        ...process.env,
        ...environment,
        OPENSCIENCE_CLIENT_DIRECTORY: project,
        PYTHONPATH: path.resolve(import.meta.dir, "../sdk/python"),
      },
      stdout: "inherit",
      stderr: "inherit",
    })
    if (await child.exited) throw new Error("Public server conformance failed")
  } finally {
    await server.close()
  }
} finally {
  await fs.rm(root, { recursive: true, force: true })
}

import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"

test("a failed startup catalog cache write is handled without an unhandled rejection", async () => {
  await using tmp = await tmpdir()
  const requests = { count: 0 }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests.count++
      return Response.json({})
    },
  })
  try {
    const script = `
      import fs from "node:fs/promises"
      import path from "node:path"
      import { Global } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/global"))}
      import { Log } from ${JSON.stringify(path.resolve(import.meta.dir, "../../src/util/log"))}
      await Log.init({ print: true })
      const target = path.join(Global.Path.cache, "models.json")
      await fs.mkdir(target, { recursive: true })
      await fs.utimes(target, new Date(0), new Date(0))
      await import(${JSON.stringify(path.resolve(import.meta.dir, "../../src/provider/models"))})
    `
    const child = Bun.spawn([process.execPath, "--eval", script], {
      cwd: path.resolve(import.meta.dir, "../.."),
      env: {
        ...process.env,
        OPENSCIENCE_DISABLE_MODELS_FETCH: "",
        OPENSCIENCE_MODELS_URL: server.url.origin,
        OPENSCIENCE_TEST_HOME: tmp.path,
        OPENSCIENCE_CONFIG_DIR: path.join(tmp.path, "config"),
        OPENSCIENCE_DATA_DIR: path.join(tmp.path, "data"),
        XDG_CACHE_HOME: path.join(tmp.path, "cache"),
        XDG_DATA_HOME: path.join(tmp.path, "xdg-data"),
        XDG_STATE_HOME: path.join(tmp.path, "state"),
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: 10_000,
    })
    const stderr = await new Response(child.stderr).text()
    expect(await child.exited).toBe(0)
    expect(requests.count).toBe(1)
    expect(stderr).toContain("Failed to refresh the models.dev catalog")
  } finally {
    server.stop(true)
  }
})

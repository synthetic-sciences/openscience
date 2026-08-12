import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

test("production web assets embed the explicit release version", async () => {
  const version = "9.8.7-test.version-metadata"
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-web-version-"))
  const proc = Bun.spawn(["bun", "x", "vite", "build", "--outDir", output], {
    cwd: path.resolve(import.meta.dir, ".."),
    env: {
      ...process.env,
      VITE_OPENSCIENCE_VERSION: version,
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  })

  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    expect(code, stderr || stdout).toBe(0)

    const assets = path.join(output, "assets")
    const files = await fs.readdir(assets)
    const scripts = files.filter((file) => file.endsWith(".js"))
    const found = await Promise.all(scripts.map((file) => Bun.file(path.join(assets, file)).text())).then((items) =>
      items.some((text) => text.includes(version)),
    )

    expect(found).toBe(true)
  } finally {
    await fs.rm(output, { recursive: true, force: true })
  }
}, 30_000)

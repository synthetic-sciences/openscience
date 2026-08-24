import path from "node:path"
import { describe, expect, test } from "bun:test"
import launcher from "../../../../tooling/launcher/package.json"

const script = path.join(import.meta.dir, "../../../../tooling/launcher/bin/synsci.mjs")

describe("synsci launcher version", () => {
  test("prints its version without starting the interactive installer", async () => {
    const proc = Bun.spawn(["node", script, "--version"], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    expect(code).toBe(0)
    expect(stdout.trim()).toBe(launcher.version)
    expect(stderr).toBe("")
  })

  test("offers only OpenScience on its public package surface", async () => {
    const source = await Bun.file(script).text()
    const metadata = JSON.stringify(launcher)

    expect(source).not.toContain("@synsci/atlas")
    expect(source).not.toContain("Atlas CLI")
    expect(source).not.toContain("OpenScience + Atlas")
    expect(metadata.toLowerCase()).not.toContain("atlas")
  })
})

import { afterEach, describe, expect, test } from "bun:test"
import { Installation } from "../../src/installation"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

describe("Installation update safety", () => {
  const fetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = fetch
  })

  test("detects the install method from immutable executable paths without running project package configuration", () => {
    expect(
      Installation.methodFromPaths({
        execPath: "/opt/homebrew/bin/node",
        scriptPath: "/opt/homebrew/lib/node_modules/@synsci/openscience/bin/openscience",
      }),
    ).toBe("npm")
    expect(
      Installation.methodFromPaths({
        execPath: "/Users/researcher/.bun/bin/bun",
        scriptPath: "/Users/researcher/.bun/install/global/node_modules/@synsci/openscience/bin/openscience",
      }),
    ).toBe("bun")
    expect(
      Installation.methodFromPaths({
        execPath:
          "/opt/homebrew/lib/node_modules/@synsci/openscience/node_modules/@synsci/openscience-darwin-arm64/bin/openscience",
      }),
    ).toBe("npm")
    expect(
      Installation.methodFromPaths({
        execPath: "/Users/researcher/project/malicious-bin/node",
        scriptPath: "/Users/researcher/project/openscience.ts",
      }),
    ).toBe("unknown")
  })

  test("always checks npm releases through the fixed public registry", async () => {
    const urls: string[] = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input))
      expect(init?.signal).toBeDefined()
      return Response.json({ version: "9.9.9" })
    }) as typeof globalThis.fetch

    expect(await Installation.latest("npm")).toBe("9.9.9")
    expect(urls).toEqual([`https://registry.npmjs.org/@synsci/openscience/${Installation.npmReleaseChannel()}`])
  })

  test("runs an explicit package-manager upgrade outside the project with a narrow environment", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-upgrade-safety-"))
    const bin = path.join(root, "bin")
    const output = path.join(root, "probe.txt")
    const runner = path.join(root, "upgrade.ts")
    const installation = new URL("../../src/installation/index.ts", import.meta.url).href
    await fs.mkdir(bin)
    await fs.writeFile(path.join(bin, "npm"), `#!/bin/sh\npwd > '${output}'\nenv >> '${output}'\n`, { mode: 0o755 })
    await fs.writeFile(
      runner,
      `import { Installation } from ${JSON.stringify(installation)}\nawait Installation.upgrade("npm", "9.9.9")\n`,
    )

    try {
      const proc = Bun.spawn([process.execPath, runner], {
        env: {
          ...process.env,
          PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
          OPENSCIENCE_UNTRUSTED_SENTINEL: "must-not-leak",
        },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [code, error] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
      expect(code, error).toBe(0)
      const lines = (await fs.readFile(output, "utf8")).split("\n")
      expect(lines[0]).toStartWith(path.join(os.tmpdir(), "openscience-upgrade-"))
      expect(lines[0]).not.toBe(process.cwd())
      expect(lines.some((line) => line.includes("OPENSCIENCE_UNTRUSTED_SENTINEL"))).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

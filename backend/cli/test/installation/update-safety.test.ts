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

  test("resolves Homebrew releases from GitHub because the formula is not in homebrew-core", async () => {
    const urls: string[] = []
    globalThis.fetch = (async (input: string | URL | Request) => {
      urls.push(String(input))
      return Response.json({ tag_name: "v9.9.9" })
    }) as typeof globalThis.fetch

    expect(await Installation.latest("brew")).toBe("9.9.9")
    expect(urls).toEqual(["https://api.github.com/repos/synthetic-sciences/OpenScience/releases/latest"])
  })

  // The post-upgrade probe runs `process.execPath --version`; under the test
  // runner that is Bun itself, so an upgrade only verifies when it targets
  // Bun's own version.
  const installed = Bun.version

  async function upgradeWith(bin: string, method: string, target: string, env: Record<string, string> = {}) {
    const runner = path.join(path.dirname(bin), `upgrade-${method}.ts`)
    const installation = new URL("../../src/installation/index.ts", import.meta.url).href
    await fs.writeFile(
      runner,
      [
        `import { Installation } from ${JSON.stringify(installation)}`,
        `await Installation.upgrade(${JSON.stringify(method)}, ${JSON.stringify(target)}).catch((error) => {`,
        `  console.error(error instanceof Installation.UpgradeFailedError ? error.data.stderr : String(error))`,
        `  process.exit(3)`,
        `})`,
      ].join("\n"),
    )
    const proc = Bun.spawn([process.execPath, runner], {
      env: {
        ...process.env,
        ...env,
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()])
    return { code, stderr }
  }

  test("runs an explicit package-manager upgrade outside the project with a narrow environment", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-upgrade-safety-"))
    const bin = path.join(root, "bin")
    const output = path.join(root, "probe.txt")
    await fs.mkdir(bin)
    await fs.writeFile(path.join(bin, "npm"), `#!/bin/sh\npwd > '${output}'\nenv >> '${output}'\n`, { mode: 0o755 })

    try {
      const result = await upgradeWith(bin, "npm", installed, { OPENSCIENCE_UNTRUSTED_SENTINEL: "must-not-leak" })
      expect(result.code, result.stderr).toBe(0)
      const lines = (await fs.readFile(output, "utf8")).split("\n")
      expect(lines[0]).toStartWith(path.join(os.tmpdir(), "openscience-upgrade-"))
      expect(lines[0]).not.toBe(process.cwd())
      expect(lines.some((line) => line.includes("OPENSCIENCE_UNTRUSTED_SENTINEL"))).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("verifies the updated PATH command when the old versioned executable still exists", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-upgrade-retained-"))
    const bin = path.join(root, "bin")
    await fs.mkdir(bin)
    await fs.writeFile(path.join(bin, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })
    await fs.writeFile(path.join(bin, "openscience"), "#!/bin/sh\necho 9.9.9\n", { mode: 0o755 })
    try {
      const result = await upgradeWith(bin, "npm", "9.9.9")
      expect(result.code, result.stderr).toBe(0)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("fails the upgrade when the installed version does not reach the target", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-upgrade-verify-"))
    const bin = path.join(root, "bin")
    await fs.mkdir(bin)
    await fs.writeFile(path.join(bin, "npm"), "#!/bin/sh\nexit 0\n", { mode: 0o755 })

    try {
      const result = await upgradeWith(bin, "npm", "9.9.9")
      expect(result.code).toBe(3)
      expect(result.stderr).toContain(`now reports ${installed} instead of 9.9.9`)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("upgrades the Homebrew formula from the synthetic-sciences tap", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-upgrade-brew-"))
    const bin = path.join(root, "bin")
    const calls = path.join(root, "brew.txt")
    await fs.mkdir(bin)
    await fs.writeFile(
      path.join(bin, "brew"),
      `#!/bin/sh\necho "$@" >> '${calls}'\ncase "$1" in list) echo openscience ;; esac\n`,
      { mode: 0o755 },
    )

    try {
      const result = await upgradeWith(bin, "brew", installed)
      expect(result.code, result.stderr).toBe(0)
      expect((await fs.readFile(calls, "utf8")).trim().split("\n")).toEqual([
        "list --formula synthetic-sciences/tap/openscience",
        "upgrade synthetic-sciences/tap/openscience",
      ])
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === "win32")("does not run the curl installer when its download fails", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-upgrade-curl-"))
    const bin = path.join(root, "bin")
    const ran = path.join(root, "bash-ran.txt")
    await fs.mkdir(bin)
    // `curl -f` on a 404 exits 22 without writing the output file.
    await fs.writeFile(
      path.join(bin, "curl"),
      "#!/bin/sh\necho 'curl: (22) The requested URL returned error: 404' >&2\nexit 22\n",
      {
        mode: 0o755,
      },
    )
    await fs.writeFile(path.join(bin, "bash"), `#!/bin/sh\necho ran > '${ran}'\n`, { mode: 0o755 })

    try {
      const result = await upgradeWith(bin, "curl", installed)
      expect(result.code).toBe(3)
      expect(result.stderr).toContain("Could not download the installer")
      expect(result.stderr).toContain("404")
      expect(await Bun.file(ran).exists()).toBe(false)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test.skipIf(process.platform === "win32")("runs the downloaded curl installer with the target version", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-upgrade-curl-ok-"))
    const bin = path.join(root, "bin")
    const ran = path.join(root, "installer-ran.txt")
    await fs.mkdir(bin)
    await fs.writeFile(
      path.join(bin, "curl"),
      [
        "#!/bin/sh",
        'while [ $# -gt 0 ]; do if [ "$1" = "-o" ]; then out="$2"; shift; fi; shift; done',
        `printf 'echo "$VERSION" > %s\\n' '${ran}' > "$out"`,
      ].join("\n"),
      { mode: 0o755 },
    )

    try {
      const result = await upgradeWith(bin, "curl", installed)
      expect(result.code, result.stderr).toBe(0)
      expect((await fs.readFile(ran, "utf8")).trim()).toBe(installed)
    } finally {
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

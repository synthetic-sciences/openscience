import { describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"

// The launcher (backend/cli/bin/openscience) is a plain CJS Node script. When
// the resolved binary is killed by a signal (SIGSEGV/SIGILL on some ARM64
// hosts, per #190), spawnSync returns status: null, signal: "SIG...", and the
// launcher must not silently exit 0 — see the task brief for the confirmed
// root cause.
const launcherSource = path.join(__dirname, "../../bin/openscience")

describe("launcher signal handling (#190)", () => {
  test("exits non-zero with an actionable diagnostic when the binary is killed by a signal", async () => {
    const tmpHome = await mkdtemp(path.join(os.tmpdir(), "openscience-signal-home-"))
    const tmpBin = await mkdtemp(path.join(os.tmpdir(), "openscience-signal-bin-"))
    const crashScript = path.join(tmpBin, "crash.sh")
    // Run the launcher from a copy outside this repo's tree: this repo's own
    // package.json declares "type": "module", which would make a bare `node
    // <path>` load the extension-less script as ESM and blow up on `require`
    // before any launcher logic runs. The published wrapper package (see
    // script/publish.ts) ships a package.json with no "type" field, so real
    // installs default to CommonJS — copying to a bare temp dir (no ambient
    // package.json) reproduces that real-world resolution instead.
    const launcherCopy = path.join(tmpBin, "openscience")
    const config = path.join(tmpHome, ".openscience")
    const manifest = path.join(config, "package.json")
    const sentinel = path.join(config, "node_modules", "sentinel")

    try {
      // A shell script that signals itself SEGV. isBinary() in the launcher
      // accepts any existing non-.js file that isn't the wrapper itself, so
      // this stands in for a Bun binary crashing on an incompatible host.
      await writeFile(crashScript, "#!/bin/sh\nkill -s SEGV $$\n")
      await chmod(crashScript, 0o755)
      await copyFile(launcherSource, launcherCopy)
      await mkdir(path.dirname(sentinel), { recursive: true })
      await writeFile(manifest, "preserve manifest\n")
      await writeFile(sentinel, "preserve modules\n")

      const proc = Bun.spawn(["node", launcherCopy, "some-arg"], {
        env: { ...process.env, HOME: tmpHome, OPENSCIENCE_BIN_PATH: crashScript },
        stdout: "pipe",
        stderr: "pipe",
      })

      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])

      expect(exitCode).not.toBe(0)
      expect(stderr).toContain("SIGSEGV")
      expect(stderr).toContain("incompatible")
      expect(stderr).toContain("Detected runtime:")
      await expect(readFile(manifest, "utf8")).resolves.toBe("preserve manifest\n")
      await expect(readFile(sentinel, "utf8")).resolves.toBe("preserve modules\n")
    } finally {
      await rm(tmpHome, { recursive: true, force: true })
      await rm(tmpBin, { recursive: true, force: true })
    }
  })

  test("selects the baseline when the read-only startup probe dies with SIGILL", async () => {
    const tmpHome = await mkdtemp(path.join(os.tmpdir(), "openscience-sigill-home-"))
    const tmpPkg = await mkdtemp(path.join(os.tmpdir(), "openscience-sigill-pkg-"))
    const launcherCopy = path.join(tmpPkg, "bin", "openscience")
    // Mirror the wrapper's own platform naming so the host resolves these
    // packages; the baseline sibling only exists for x64 in real releases, but
    // the fallback logic is name-based and the same on every host.
    const platforms: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" }
    const platform = platforms[process.platform] ?? process.platform
    const base = `openscience-${platform}-${process.arch}`
    const scoped = path.join(tmpPkg, "node_modules", "@synsci")
    const optimized = path.join(scoped, base, "bin", "openscience")
    const baseline = path.join(scoped, `${base}-baseline`, "bin", "openscience")

    try {
      await mkdir(path.dirname(launcherCopy), { recursive: true })
      await copyFile(launcherSource, launcherCopy)
      await mkdir(path.dirname(optimized), { recursive: true })
      await mkdir(path.dirname(baseline), { recursive: true })
      await writeFile(optimized, "#!/bin/sh\nkill -s ILL $$\n")
      await chmod(optimized, 0o755)
      await writeFile(baseline, '#!/bin/sh\necho "baseline ran $*"\n')
      await chmod(baseline, 0o755)

      const env: Record<string, string | undefined> = { ...process.env, HOME: tmpHome }
      delete env.OPENSCIENCE_BIN_PATH
      const proc = Bun.spawn(["node", launcherCopy, "--version"], { env, stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])

      expect(exitCode, stderr).toBe(0)
      expect(stdout).toContain("baseline ran --version")
      expect(stderr).toContain("using the baseline build")
      expect(stderr).not.toContain("incompatible")
    } finally {
      await rm(tmpHome, { recursive: true, force: true })
      await rm(tmpPkg, { recursive: true, force: true })
    }
  })

  test("never replays a command that writes before crashing", async () => {
    const tmpHome = await mkdtemp(path.join(os.tmpdir(), "openscience-sigill-home-"))
    const tmpPkg = await mkdtemp(path.join(os.tmpdir(), "openscience-sigill-pkg-"))
    const launcherCopy = path.join(tmpPkg, "bin", "openscience")
    // Mirror the wrapper's own platform naming so the host resolves these
    // packages; the baseline sibling only exists for x64 in real releases, but
    // the fallback logic is name-based and the same on every host.
    const platforms: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" }
    const platform = platforms[process.platform] ?? process.platform
    const base = `openscience-${platform}-${process.arch}`
    const scoped = path.join(tmpPkg, "node_modules", "@synsci")
    const optimized = path.join(scoped, base, "bin", "openscience")
    const baseline = path.join(scoped, `${base}-baseline`, "bin", "openscience")

    try {
      await mkdir(path.dirname(launcherCopy), { recursive: true })
      await copyFile(launcherSource, launcherCopy)
      await mkdir(path.dirname(optimized), { recursive: true })
      await mkdir(path.dirname(baseline), { recursive: true })
      await writeFile(
        optimized,
        '#!/bin/sh\nif [ "$1" = "--version" ]; then exit 0; fi\necho written >> "$HOME/writes"\nkill -s ILL $$\n',
      )
      await chmod(optimized, 0o755)
      await writeFile(baseline, '#!/bin/sh\necho "baseline ran $*"\n')
      await chmod(baseline, 0o755)

      const env: Record<string, string | undefined> = { ...process.env, HOME: tmpHome }
      delete env.OPENSCIENCE_BIN_PATH
      const proc = Bun.spawn(["node", launcherCopy, "run"], { env, stdout: "pipe", stderr: "pipe" })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])

      expect(exitCode).not.toBe(0)
      expect(stdout).not.toContain("baseline ran")
      expect(await readFile(path.join(tmpHome, "writes"), "utf8")).toBe("written\n")
      expect(stderr).toContain("SIGILL")
    } finally {
      await rm(tmpHome, { recursive: true, force: true })
      await rm(tmpPkg, { recursive: true, force: true })
    }
  })

  test("prints the illegal-instruction diagnostic when no baseline sibling exists", async () => {
    const tmpHome = await mkdtemp(path.join(os.tmpdir(), "openscience-sigill-only-home-"))
    const tmpBin = await mkdtemp(path.join(os.tmpdir(), "openscience-sigill-only-bin-"))
    const crashScript = path.join(tmpBin, "crash.sh")
    const launcherCopy = path.join(tmpBin, "openscience")

    try {
      await writeFile(crashScript, "#!/bin/sh\nkill -s ILL $$\n")
      await chmod(crashScript, 0o755)
      await copyFile(launcherSource, launcherCopy)
      const proc = Bun.spawn(["node", launcherCopy], {
        env: { ...process.env, HOME: tmpHome, OPENSCIENCE_BIN_PATH: crashScript },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])

      expect(exitCode).not.toBe(0)
      expect(stderr).toContain("SIGILL")
      expect(stderr).toContain("without AVX2")
      expect(stderr).toContain("Detected runtime:")
      expect(stderr).not.toContain("retrying")
    } finally {
      await rm(tmpHome, { recursive: true, force: true })
      await rm(tmpBin, { recursive: true, force: true })
    }
  })

  test("does not launch an unrelated system installation when its native package is missing", async () => {
    const tmpHome = await mkdtemp(path.join(os.tmpdir(), "openscience-missing-home-"))
    const tmpBin = await mkdtemp(path.join(os.tmpdir(), "openscience-missing-bin-"))
    const launcherCopy = path.join(tmpBin, "openscience")

    try {
      await copyFile(launcherSource, launcherCopy)
      const proc = Bun.spawn(["node", launcherCopy, "--version"], {
        env: { ...process.env, HOME: tmpHome },
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])

      expect(exitCode, stdout).not.toBe(0)
      expect(stderr).toContain("Expected npm package: @synsci/openscience-")
    } finally {
      await rm(tmpHome, { recursive: true, force: true })
      await rm(tmpBin, { recursive: true, force: true })
    }
  })
})

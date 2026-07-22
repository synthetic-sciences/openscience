import { describe, expect, test } from "bun:test"
import os from "node:os"
import path from "node:path"
import { chmod, copyFile, mkdtemp, rm, writeFile } from "node:fs/promises"

// The launcher (backend/cli/bin/openscience) is a plain CJS Node script. When
// the resolved binary is killed by a signal (SIGSEGV/SIGILL on some ARM64
// hosts, per #190), spawnSync returns status: null, signal: "SIG...", and the
// launcher must not silently exit 0 — see the task brief for the confirmed
// root cause.
const launcherSource = path.join(__dirname, "../../bin/openscience")

describe("launcher signal handling (#190)", () => {
  test("exits non-zero with an actionable diagnostic when the binary is killed by a signal", async () => {
    // CRITICAL SAFETY: run() destructively cleans ~/.openscience (unlinks
    // files, rmSync's node_modules). HOME must point at a throwaway temp dir
    // so this test never touches the real home directory.
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

    try {
      // A shell script that signals itself SEGV. isBinary() in the launcher
      // accepts any existing non-.js file that isn't the wrapper itself, so
      // this stands in for a Bun binary crashing on an incompatible host.
      await writeFile(crashScript, "#!/bin/sh\nkill -s SEGV $$\n")
      await chmod(crashScript, 0o755)
      await copyFile(launcherSource, launcherCopy)

      const proc = Bun.spawn(["node", launcherCopy, "some-arg"], {
        env: { ...process.env, HOME: tmpHome, OPENSCIENCE_BIN_PATH: crashScript },
        stdout: "pipe",
        stderr: "pipe",
      })

      const [stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])

      expect(exitCode).not.toBe(0)
      expect(stderr).toContain("SIGSEGV")
      expect(stderr).toContain("incompatible")
    } finally {
      await rm(tmpHome, { recursive: true, force: true })
      await rm(tmpBin, { recursive: true, force: true })
    }
  })
})

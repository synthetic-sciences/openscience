import { describe, expect, test } from "bun:test"
import { createRequire } from "module"
import path from "path"

// Tripwire for the bundled `atlas` CLI the agent shells out to (atlas doctor,
// nodes:create, evidence:add). If node_modules drifts from the declared pin, the
// agent runs a different CLI surface than we ship — which silently degrades graph
// population even when `openscience project init` succeeds. Mirrors the model-pin
// delisting tripwire.
describe("@synsci/atlas dependency", () => {
  const root = path.join(import.meta.dir, "..", "..")
  const req = createRequire(import.meta.url)

  async function pkgJson() {
    return (await Bun.file(path.join(root, "package.json")).json()) as {
      optionalDependencies?: Record<string, string>
    }
  }

  async function installedAtlas(): Promise<{ version: string; bin?: unknown } | null> {
    try {
      const p = req.resolve("@synsci/atlas/package.json")
      const j = (await Bun.file(p).json()) as { version: string; bin?: Record<string, string> }
      return { version: j.version, bin: j.bin?.atlas }
    } catch {
      // Optional dependency: absent in a standalone-compiled build with no
      // node_modules. Callers treat that as "skip", not "fail".
      return null
    }
  }

  test("declares @synsci/atlas with a concrete version range", async () => {
    const range = (await pkgJson()).optionalDependencies?.["@synsci/atlas"]
    expect(range).toBeTruthy()
    expect(range).toMatch(/\d+\.\d+\.\d+/)
  })

  test("the installed @synsci/atlas satisfies the declared range (no drift)", async () => {
    const range = (await pkgJson()).optionalDependencies!["@synsci/atlas"]
    const atlas = await installedAtlas()
    if (!atlas) return // not installed in this build — nothing to check
    expect(Bun.semver.satisfies(atlas.version, range)).toBe(true)
  })

  test("the bundled atlas exposes a bin entry named `atlas`", async () => {
    const atlas = await installedAtlas()
    if (!atlas) return
    expect(typeof atlas.bin).toBe("string")
  })
})

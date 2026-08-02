import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "node:os"
import path from "node:path"
import { resolveDataDirectory } from "@/global/data-dir"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function root() {
  const value = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-data-dir-"))
  roots.push(value)
  return value
}

describe("OpenScience data directory", () => {
  test("prefers explicit and pointer locations without migrating", async () => {
    const home = await root()
    const legacy = path.join(home, "share", "openscience")

    expect((await resolveDataDirectory({ home, legacy, explicit: "./custom" })).path).toBe(path.resolve("./custom"))
    expect((await resolveDataDirectory({ home, legacy, pointer: "./pointed" })).path).toBe(path.resolve("./pointed"))
  })

  test("copies, checksums, and retains legacy data before selecting ~/.openscience", async () => {
    const home = await root()
    const legacy = path.join(home, "share", "openscience")
    await fs.mkdir(path.join(legacy, "storage"), { recursive: true })
    await fs.writeFile(path.join(legacy, "storage", "session.json"), '{"title":"kept"}\n')
    await fs.mkdir(path.join(home, ".openscience", "bin"), { recursive: true })
    await fs.writeFile(path.join(home, ".openscience", "bin", "openscience"), "launcher")

    const result = await resolveDataDirectory({ home, legacy })

    expect(result.path).toBe(path.join(home, ".openscience"))
    expect(result.migrated?.files).toBe(1)
    expect(await fs.readFile(path.join(result.path, "storage", "session.json"), "utf8")).toContain("kept")
    expect(await fs.readFile(path.join(legacy, "storage", "session.json"), "utf8")).toContain("kept")
    expect(await fs.readFile(path.join(result.path, "bin", "openscience"), "utf8")).toBe("launcher")
    expect(JSON.parse(await fs.readFile(path.join(result.path, ".xdg-data-migration-v1.json"), "utf8")).source).toBe(
      legacy,
    )

    const repeated = await resolveDataDirectory({ home, legacy })
    expect(repeated.path).toBe(result.path)
    expect(repeated.migrated).toBeUndefined()
    expect(repeated.conflict).toBeUndefined()
  })

  test("reports a conflict instead of merging two populated roots", async () => {
    const home = await root()
    const legacy = path.join(home, "share", "openscience")
    const target = path.join(home, ".openscience")
    await fs.mkdir(legacy, { recursive: true })
    await fs.mkdir(target, { recursive: true })
    await fs.writeFile(path.join(legacy, "old.json"), "old")
    await fs.writeFile(path.join(target, "new.json"), "new")

    const result = await resolveDataDirectory({ home, legacy })

    expect(result.path).toBe(target)
    expect(result.conflict).toEqual({ legacy, current: target })
    expect(await fs.readFile(path.join(target, "new.json"), "utf8")).toBe("new")
    expect(await fs.readFile(path.join(legacy, "old.json"), "utf8")).toBe("old")
  })
})

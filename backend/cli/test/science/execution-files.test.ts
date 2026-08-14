import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { changed, snapshot } from "../../src/science/execution/files"

describe("execution workspace file observation", () => {
  test("records created and changed regular files with hashes but not unchanged files or cache trees", async () => {
    await using tmp = await tmpdir()
    await Bun.write(path.join(tmp.path, "unchanged.txt"), "same")
    await Bun.write(path.join(tmp.path, "changed.csv"), "a\n1\n")
    const before = await snapshot(tmp.path)

    const changedPath = path.join(tmp.path, "changed.csv")
    await Bun.write(changedPath, "a\n2\n")
    // The observer deliberately fingerprints metadata before hashing bounded
    // candidates. Pin a later mtime so this same-size rewrite is deterministic
    // even on filesystems whose timestamp granularity collapses rapid writes.
    const priorMtime = before.get("changed.csv")?.mtimeMs ?? Date.now()
    const changedAt = new Date(Math.ceil(priorMtime) + 1_000)
    await fs.utimes(changedPath, changedAt, changedAt)
    await Bun.write(path.join(tmp.path, "figure.txt"), "result")
    await Bun.write(path.join(tmp.path, ".venv", "ignored.txt"), "dependency")

    const outputs = await changed(tmp.path, before, Date.now())
    expect(
      outputs
        .map((item) => item.path.status === "available" && item.path.value)
        .filter(Boolean)
        .sort(),
    ).toEqual(["changed.csv", "figure.txt"])
    expect(outputs.every((item) => item.kind === "checkpoint" && item.sha256.length === 64)).toBe(true)
  })
})

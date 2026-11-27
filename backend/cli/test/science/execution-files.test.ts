import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { changed, select, snapshot, type Fingerprint } from "../../src/science/execution/files"

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

  test("an ineligible file does not use up a checkpoint slot", () => {
    const fingerprint = (size: number): Fingerprint => ({ size, mtimeMs: 1, dev: 1, ino: 1 })
    const small = Array.from({ length: 64 }, (_, index) => `small-${String(index).padStart(3, "0")}.txt`)
    // The oversized file sorts first and is skipped; it must not spend one of
    // the 64 slots, leaving only 63 of the eligible outputs to be captured.
    const after = new Map<string, Fingerprint>([
      ["000-oversized.bin", fingerprint(33 * 1024 * 1024)],
      ...small.map((name) => [name, fingerprint(1)] as const),
    ])

    const selected = select(new Map(), after).map(([name]) => name)
    expect(selected).toEqual(small)
    expect(selected).not.toContain("000-oversized.bin")
  })
})

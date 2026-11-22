import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { GitStatus } from "../../src/file/git-status"

test("NUL-delimited change lists retain tabs, newlines and whitespace in filenames", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-git-paths-"))
  const run = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" })
  try {
    run("init", "-q")
    const tracked = "tab\tmodified.txt"
    const deleted = "line\ndeleted.txt"
    const untracked = " new\tline.txt "
    await fs.writeFile(path.join(dir, tracked), "before\n")
    await fs.writeFile(path.join(dir, deleted), "removed\n")
    run("add", "-A")
    run("-c", "user.name=OpenScience", "-c", "user.email=test@openscience.local", "commit", "-qm", "seed")
    await fs.writeFile(path.join(dir, tracked), "after\n")
    await fs.rm(path.join(dir, deleted))
    await fs.writeFile(path.join(dir, untracked), "untracked\n")

    const stats = GitStatus.numstat(run("-c", "core.quotepath=false", "diff", "--numstat", "-z", "--relative", "HEAD"))
    expect(stats).toEqual(expect.arrayContaining([
      { path: tracked, added: 1, removed: 1 },
      { path: deleted, added: 0, removed: 1 },
    ]))
    const unknown = GitStatus.paths(run("-c", "core.quotepath=false", "ls-files", "--others", "--exclude-standard", "-z"))
    expect(unknown).toContain(untracked)
    const deletedList = GitStatus.paths(run("diff", "--name-only", "--diff-filter=D", "--relative", "HEAD", "-z"))
    expect(deletedList).toEqual([deleted])
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})

test("a renamed path uses the destination name from Git's -z triple", () => {
  expect(GitStatus.numstat("1\t0\t\0old\nfile.txt\0new\tfile.txt\0")).toEqual([
    { path: "new\tfile.txt", added: 1, removed: 0 },
  ])
})

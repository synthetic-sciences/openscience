import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import fs from "node:fs/promises"
import path from "node:path"
import { File } from "../../src/file"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

describe("file.status paths", () => {
  test("are relative to the project directory when it is a subdirectory of the repository", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "pkg", "tracked.txt"), "one\n")
        await Bun.write(path.join(dir, "pkg", "removed.txt"), "two\n")
        await Bun.write(path.join(dir, "outside.txt"), "three\n")
        await $`git add -A`.cwd(dir).quiet()
        await $`git commit -m seed`.cwd(dir).quiet()
      },
    })
    const project = path.join(tmp.path, "pkg")
    await Instance.provide({
      directory: project,
      fn: async () => {
        await Bun.write(path.join(project, "tracked.txt"), "one changed\n")
        await Bun.write(path.join(project, "added.txt"), "new\n")
        await fs.rm(path.join(project, "removed.txt"))
        await Bun.write(path.join(tmp.path, "outside.txt"), "three changed\n")

        const status = await File.status()
        // The agent opens these paths, so every one has to resolve from the
        // project it is working in, not from wherever the server was started.
        for (const item of status) {
          expect(path.isAbsolute(item.path)).toBe(false)
          expect(item.path.split(/[/\\]/)).not.toContain("..")
        }
        // A deleted file is also counted as modified by `diff --numstat`, which
        // is pre-existing; what matters is that each path is the project's.
        const statuses = (target: string) => status.filter((item) => item.path === target).map((item) => item.status)
        expect(statuses("tracked.txt")).toContain("modified")
        expect(statuses("added.txt")).toEqual(["added"])
        expect(statuses("removed.txt")).toContain("deleted")
        // A change outside the project directory is not one of its changes.
        expect(status.some((item) => item.path.includes("outside.txt"))).toBe(false)
      },
    })
  }, 30_000)
})


test("Git status keeps exact filenames containing tabs, newlines and surrounding whitespace", async () => {
  await using tmp = await tmpdir({
    git: true,
    init: async (directory) => {
      await Bun.write(path.join(directory, "tab\tmodified.txt"), "before\n")
      await Bun.write(path.join(directory, "line\ndeleted.txt"), "before\n")
      await $`git add -A`.cwd(directory).quiet()
      await $`git commit -m seed`.cwd(directory).quiet()
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await Bun.write(path.join(tmp.path, "tab\tmodified.txt"), "after\n")
      await fs.rm(path.join(tmp.path, "line\ndeleted.txt"))
      await Bun.write(path.join(tmp.path, " new\tline.txt "), "new\n")
      const status = await File.status()
      expect(status).toEqual(expect.arrayContaining([
        expect.objectContaining({ path: "tab\tmodified.txt", status: "modified" }),
        expect.objectContaining({ path: "line\ndeleted.txt", status: "deleted" }),
        expect.objectContaining({ path: " new\tline.txt ", status: "added" }),
      ]))
      expect(status.every((entry) => typeof entry.path === "string" && entry.path.length > 0)).toBe(true)
    },
  })
})

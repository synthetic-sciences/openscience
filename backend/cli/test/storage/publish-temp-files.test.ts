import { describe, expect, test } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Global } from "../../src/global"
import { Project } from "../../src/project/project"
import { Storage } from "../../src/storage/storage"
import { Log } from "../../src/util/log"

Log.init({ print: false })

// Storage.publish stages every write as `<target>.<pid>.<uuid>.tmp` inside the
// record directory and renames it into place. Storage.list used to glob `**/*`
// there and strip a fixed 5 characters off each hit assuming ".json", so a
// staging file — visible during the write→rename window, and forever if the
// writer crashed in between, since nothing sweeps them — became a phantom key
// whose Storage.read throws NotFoundError. The file is written directly here
// rather than raced against a real publish() so the regression is deterministic
// and also covers the crashed-writer case, which no timing trick can reach.
const stray = (dir: string, record: string) =>
  path.join(dir, `${record}.json.4242.9d1c0f2a-1111-4222-8333-444455556666.tmp`)

describe("Storage.list ignores publish staging files", () => {
  test("a stray temp file in the record directory is never enumerated as a key", async () => {
    const id = "prj_storage_temp_probe"
    await Storage.write(["project", id], {
      id,
      vcs: "git",
      worktree: path.join(Global.Path.data, "storage-temp-probe-worktree"),
      time: { created: Date.now(), initialized: Date.now() },
    })
    const dir = path.join(Global.Path.data, "storage", "project")
    const temp = stray(dir, id)
    await Bun.write(temp, "{}")

    try {
      const keys = await Storage.list(["project"])
      expect(keys).toContainEqual(["project", id])
      expect(keys.filter((key) => key.some((part) => part.includes(".tmp")))).toEqual([])

      // Project.list() reads every key Storage.list hands back with no .catch,
      // so a phantom key surfaces to callers as a thrown NotFoundError.
      const projects = await Project.list()
      expect(projects.some((project) => project.id === id)).toBe(true)
    } finally {
      await fs.rm(temp, { force: true })
      await Storage.remove(["project", id])
    }
  })
})

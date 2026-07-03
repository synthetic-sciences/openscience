import { describe, expect, test } from "bun:test"
import { Project } from "../../src/project/project"
import { Log } from "../../src/util/log"
import { Storage } from "../../src/storage/storage"
import { $ } from "bun"
import path from "path"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

describe("Project.fromDirectory", () => {
  test("git repository with no commits gets a stable path id", async () => {
    await using tmp = await tmpdir()
    await $`git init`.cwd(tmp.path).quiet()

    const { project } = await Project.fromDirectory(tmp.path)

    expect(project).toBeDefined()
    expect(project.id).not.toBe("global")
    expect(project.vcs).toBe("git")
    expect(project.worktree).toBe(tmp.path)

    // The `.git/openscience` cache file is no longer written — identity is path-derived.
    const openscienceFile = path.join(tmp.path, ".git", "openscience")
    expect(await Bun.file(openscienceFile).exists()).toBe(false)
  })

  test("git repository with commits gets a stable path id, no cache file", async () => {
    await using tmp = await tmpdir({ git: true })

    const { project } = await Project.fromDirectory(tmp.path)

    expect(project).toBeDefined()
    expect(project.id).not.toBe("global")
    expect(project.vcs).toBe("git")
    expect(project.worktree).toBe(tmp.path)

    const openscienceFile = path.join(tmp.path, ".git", "openscience")
    expect(await Bun.file(openscienceFile).exists()).toBe(false)
  })
})

describe("Project identity is stable", () => {
  test("same folder, different spelling -> same id", async () => {
    await using tmp = await tmpdir()

    const a = await Project.fromDirectory(tmp.path)
    const b = await Project.fromDirectory(tmp.path + path.sep)
    const c = await Project.fromDirectory(path.join(tmp.path, "."))

    expect(b.project.id).toBe(a.project.id)
    expect(c.project.id).toBe(a.project.id)
  })

  test("id is stable across git init (no flip, no orphan)", async () => {
    await using tmp = await tmpdir()

    const before = await Project.fromDirectory(tmp.path)
    const sid = "ses_flip"
    await Storage.write(["session", before.project.id, sid], {
      id: sid,
      projectID: before.project.id,
      directory: tmp.path,
      time: { created: 1, updated: 1 },
    })

    await $`git init`.cwd(tmp.path).quiet()
    await $`git commit --allow-empty -m flip`.cwd(tmp.path).quiet()

    const after = await Project.fromDirectory(tmp.path)

    expect(after.project.id).toBe(before.project.id)
    expect(after.project.vcs).toBe("git")
    const session = await Storage.read(["session", after.project.id, sid]).catch(() => null)
    expect(session).not.toBeNull()
  })
})

describe("Project.fromDirectory migration", () => {
  test("adopts a legacy per-directory record for the same folder", async () => {
    await using tmp = await tmpdir()
    const legacyID = "ng-deadbeefdeadbeef"
    await Storage.write(["project", legacyID], {
      id: legacyID,
      worktree: tmp.path,
      sandboxes: [],
      time: { created: 1, updated: 1 },
    })
    const sid = "ses_legacy"
    await Storage.write(["session", legacyID, sid], {
      id: sid,
      projectID: legacyID,
      directory: tmp.path,
      time: { created: 1, updated: 1 },
    })

    const { project } = await Project.fromDirectory(tmp.path)

    expect(project.id).not.toBe(legacyID)
    const moved = await Storage.read(["session", project.id, sid]).catch(() => null)
    expect(moved).not.toBeNull()
    expect(await Storage.read(["project", legacyID]).catch(() => null)).toBeNull()
    expect(await Storage.read(["session", legacyID, sid]).catch(() => null)).toBeNull()
  })

  test("rescues matching sessions from the legacy global bucket", async () => {
    await using tmp = await tmpdir()
    const sid = "ses_global"
    await Storage.write(["session", "global", sid], {
      id: sid,
      projectID: "global",
      directory: tmp.path,
      time: { created: 1, updated: 1 },
    })

    const { project } = await Project.fromDirectory(tmp.path)

    const moved = await Storage.read(["session", project.id, sid]).catch(() => null)
    expect(moved).not.toBeNull()
    expect(await Storage.read(["session", "global", sid]).catch(() => null)).toBeNull()
  })
})

describe("Project.fromDirectory with worktrees", () => {
  test("should set worktree to root when called from root", async () => {
    await using tmp = await tmpdir({ git: true })

    const { project, sandbox } = await Project.fromDirectory(tmp.path)

    expect(project.worktree).toBe(tmp.path)
    expect(sandbox).toBe(tmp.path)
    expect(project.sandboxes).not.toContain(tmp.path)
  })

  test("should set worktree to root when called from a worktree", async () => {
    await using tmp = await tmpdir({ git: true })

    const worktreePath = path.join(tmp.path, "..", "worktree-test")
    await $`git worktree add ${worktreePath} -b test-branch`.cwd(tmp.path).quiet()

    const { project, sandbox } = await Project.fromDirectory(worktreePath)

    expect(project.worktree).toBe(tmp.path)
    expect(sandbox).toBe(await Bun.$`realpath ${worktreePath}`.text().then((x) => x.trim()))
    expect(project.sandboxes).toContain(sandbox)
    expect(project.sandboxes).not.toContain(tmp.path)

    await $`git worktree remove ${worktreePath}`.cwd(tmp.path).quiet()
  })

  test("linked worktree collapses to the same project as root", async () => {
    await using tmp = await tmpdir({ git: true })

    const worktreePath = path.join(tmp.path, "..", "worktree-collapse")
    await $`git worktree add ${worktreePath} -b collapse-branch`.cwd(tmp.path).quiet()

    const root = await Project.fromDirectory(tmp.path)
    const linked = await Project.fromDirectory(worktreePath)

    expect(linked.project.id).toBe(root.project.id)

    await $`git worktree remove ${worktreePath}`.cwd(tmp.path).quiet()
  })
})

describe("Project.discover", () => {
  test("should discover favicon.png in root", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)

    const pngData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await Bun.write(path.join(tmp.path, "favicon.png"), pngData)

    await Project.discover(project)

    const updated = await Storage.read<Project.Info>(["project", project.id])
    expect(updated.icon).toBeDefined()
    expect(updated.icon?.url).toStartWith("data:")
    expect(updated.icon?.url).toContain("base64")
    expect(updated.icon?.color).toBeUndefined()
  })

  test("should not discover non-image files", async () => {
    await using tmp = await tmpdir({ git: true })
    const { project } = await Project.fromDirectory(tmp.path)

    await Bun.write(path.join(tmp.path, "favicon.txt"), "not an image")

    await Project.discover(project)

    const updated = await Storage.read<Project.Info>(["project", project.id])
    expect(updated.icon).toBeUndefined()
  })
})

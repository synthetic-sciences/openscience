import { describe, expect, test } from "bun:test"
import { Project } from "../../src/project/project"
import { Log } from "../../src/util/log"
import { Storage } from "../../src/storage/storage"
import { $ } from "bun"
import path from "path"
import crypto from "crypto"
import fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { SessionWorkspace } from "../../src/session/workspace"
import { File } from "../../src/file"

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

  test("honors Git's discovery ceiling for an isolated folder below another checkout", async () => {
    await using tmp = await tmpdir({ git: true })
    const isolated = path.join(tmp.path, "isolated")
    await fs.mkdir(isolated)
    const previous = process.env.GIT_CEILING_DIRECTORIES
    process.env.GIT_CEILING_DIRECTORIES = isolated
    try {
      const { project, sandbox } = await Project.fromDirectory(isolated)
      expect(project.vcs).toBeUndefined()
      expect(project.worktree).toBe(isolated)
      expect(sandbox).toBe(isolated)
    } finally {
      if (previous === undefined) delete process.env.GIT_CEILING_DIRECTORIES
      if (previous !== undefined) process.env.GIT_CEILING_DIRECTORIES = previous
    }
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
  test("replaces a path-hash record with an opaque project and preserves its state", async () => {
    await using tmp = await tmpdir()
    const hash = crypto.createHash("sha256").update(tmp.path).digest("hex").slice(0, 40)
    const sandbox = path.join(tmp.path, "hash-sandbox")
    await fs.mkdir(sandbox)
    await Storage.write(["project", hash], {
      id: hash,
      worktree: tmp.path,
      name: "legacy hash",
      icon: {
        url: "hash-icon",
      },
      commands: {
        start: "bun dev",
      },
      sandboxes: [sandbox],
      time: { created: 11, updated: 12, initialized: 13 },
    })
    const sid = "ses_hash_migration"
    await Storage.write(["session", hash, sid], {
      id: sid,
      projectID: hash,
      directory: tmp.path,
      time: { created: 1, updated: 1 },
    })

    const first = await Project.fromDirectory(tmp.path)
    const second = await Project.fromDirectory(tmp.path)

    expect(first.project.id).toStartWith("prj_")
    expect(first.project).toMatchObject({
      name: "legacy hash",
      icon: {
        url: "hash-icon",
      },
      commands: {
        start: "bun dev",
      },
      time: {
        created: 11,
        initialized: 13,
      },
    })
    expect(first.project.sandboxes).toContain(sandbox)
    expect(second.project.id).toBe(first.project.id)
    expect(await Storage.read(["project", hash]).catch(() => null)).toBeNull()
    expect(await Storage.read(["session", hash, sid]).catch(() => null)).toBeNull()
    expect(await Storage.read(["session", first.project.id, sid])).toMatchObject({
      id: sid,
      projectID: first.project.id,
    })
    expect(await Project.resolve(hash)).toMatchObject({
      project: {
        id: first.project.id,
      },
      alias: hash,
    })
  })

  test("merges hash state into an existing opaque project without downgrading it", async () => {
    await using tmp = await tmpdir()
    const hash = crypto.createHash("sha256").update(tmp.path).digest("hex").slice(0, 40)
    const opaque = "prj_existing_hash_merge"
    const prior = "ng-prior-hash-alias"
    const ancestor = "ng-ancestor-hash-alias"
    const opaqueSandbox = path.join(tmp.path, "opaque-sandbox")
    const legacySandbox = path.join(tmp.path, "legacy-sandbox")
    await Promise.all([fs.mkdir(opaqueSandbox), fs.mkdir(legacySandbox)])
    await Storage.write(["project", hash], {
      id: hash,
      worktree: tmp.path,
      name: "legacy name",
      icon: {
        url: "legacy-url",
        color: "legacy-color",
      },
      commands: {
        start: "legacy start",
      },
      sandboxes: [legacySandbox],
      time: { created: 1, updated: 2, initialized: 3 },
    })
    await Storage.write(["project", opaque], {
      id: opaque,
      worktree: tmp.path,
      name: "opaque name",
      icon: {
        override: "opaque-override",
        color: "opaque-color",
      },
      commands: {
        start: "opaque start",
      },
      sandboxes: [opaqueSandbox],
      time: { created: 10, updated: 20 },
    })
    await Storage.write(["project_alias", prior], {
      id: prior,
      projectID: hash,
      time: {
        created: 4,
      },
    })
    await Storage.write(["project_alias", ancestor], {
      id: ancestor,
      projectID: prior,
      time: {
        created: 5,
      },
    })

    const collision = "ses_hash_collision"
    const moved = "ses_hash_unique"
    const aliased = "ses_hash_aliased"
    await Storage.write(["session", opaque, collision], {
      id: collision,
      projectID: opaque,
      directory: tmp.path,
      title: "opaque session",
      time: { created: 10, updated: 20 },
    })
    await Storage.write(["session", hash, collision], {
      id: collision,
      projectID: hash,
      directory: tmp.path,
      title: "legacy session",
      time: { created: 1, updated: 2 },
    })
    await Storage.write(["session", hash, moved], {
      id: moved,
      projectID: hash,
      directory: tmp.path,
      title: "moved session",
      time: { created: 1, updated: 2 },
    })
    await Storage.write(["session", ancestor, aliased], {
      id: aliased,
      projectID: ancestor,
      directory: tmp.path,
      title: "aliased session",
      time: { created: 1, updated: 2 },
    })

    const opened = await Promise.all(Array.from({ length: 8 }, () => Project.fromDirectory(tmp.path)))
    const project = opened[0].project

    expect(new Set(opened.map((result) => result.project.id))).toEqual(new Set([opaque]))
    expect(project).toMatchObject({
      id: opaque,
      name: "opaque name",
      icon: {
        url: "legacy-url",
        override: "opaque-override",
        color: "opaque-color",
      },
      commands: {
        start: "opaque start",
      },
      time: {
        created: 10,
        initialized: 3,
      },
    })
    expect(project.sandboxes).toEqual([opaqueSandbox, legacySandbox])
    expect(await Storage.read(["project", hash]).catch(() => null)).toBeNull()
    expect(await Storage.read(["session", hash, collision]).catch(() => null)).toBeNull()
    expect(await Storage.read(["session", opaque, collision])).toMatchObject({
      projectID: opaque,
      title: "opaque session",
    })
    expect(await Storage.read(["session", opaque, moved])).toMatchObject({
      projectID: opaque,
      title: "moved session",
    })
    expect(await Storage.read(["session", opaque, aliased])).toMatchObject({
      projectID: opaque,
      title: "aliased session",
    })
    expect(await Project.resolve(hash)).toMatchObject({
      project: {
        id: opaque,
      },
      alias: hash,
    })
    expect(await Project.resolve(prior)).toMatchObject({
      project: {
        id: opaque,
      },
      alias: prior,
    })
    expect(await Project.resolve(ancestor)).toMatchObject({
      project: {
        id: opaque,
      },
      alias: ancestor,
    })
    expect((await Project.list()).filter((record) => record.worktree === tmp.path).map((record) => record.id)).toEqual([
      opaque,
    ])
  })

  test("consolidates duplicate opaque projects only after their sessions and grants move", async () => {
    await using tmp = await tmpdir()
    const canonical = "prj_a_duplicate_worktree"
    const duplicate = "prj_z_duplicate_worktree"
    const canonicalSession = "ses_duplicate_canonical"
    const duplicateSession = "ses_duplicate_loser"
    const canonicalGrant = `fsg_${crypto.randomUUID()}`
    const duplicateGrant = `fsg_${crypto.randomUUID()}`
    await Storage.write(["project", canonical], {
      id: canonical,
      worktree: tmp.path,
      name: "canonical project",
      sandboxes: [],
      time: { created: 1, updated: 2 },
    })
    await Storage.write(["project", duplicate], {
      id: duplicate,
      worktree: tmp.path,
      name: "duplicate project",
      sandboxes: [],
      time: { created: 3, updated: 4 },
    })
    await Storage.write(["session", canonical, canonicalSession], {
      id: canonicalSession,
      projectID: canonical,
      directory: tmp.path,
      title: "canonical session",
      time: { created: 5, updated: 6 },
    })
    await Storage.write(["session", duplicate, duplicateSession], {
      id: duplicateSession,
      projectID: duplicate,
      directory: tmp.path,
      title: "duplicate session",
      time: { created: 7, updated: 8 },
    })
    await Storage.write(["session_filesystem", canonical, canonicalSession], {
      version: 1,
      revision: 2,
      sessionID: canonicalSession,
      projectID: canonical,
      directory: tmp.path,
      grants: [
        {
          id: canonicalGrant,
          path: tmp.path,
          access: "write",
          scope: "session",
          source: "workspace",
          time: { created: 9 },
        },
      ],
    })
    await Storage.write(["session_filesystem", duplicate, duplicateSession], {
      version: 1,
      revision: 5,
      sessionID: duplicateSession,
      projectID: duplicate,
      directory: tmp.path,
      grants: [
        {
          id: duplicateGrant,
          path: tmp.path,
          access: "write",
          scope: "session",
          source: "workspace",
          time: { created: 10 },
        },
      ],
    })

    const opened = await Project.fromDirectory(tmp.path)

    expect(opened.project.id).toBe(canonical)
    expect(await Storage.read(["session", canonical, canonicalSession])).toMatchObject({
      id: canonicalSession,
      projectID: canonical,
      title: "canonical session",
    })
    expect(await Storage.read(["session", canonical, duplicateSession])).toMatchObject({
      id: duplicateSession,
      projectID: canonical,
      title: "duplicate session",
    })
    expect(await Storage.read(["session_filesystem", canonical, canonicalSession])).toMatchObject({
      revision: 2,
      projectID: canonical,
      grants: [expect.objectContaining({ id: canonicalGrant })],
    })
    expect(await Storage.read(["session_filesystem", canonical, duplicateSession])).toMatchObject({
      revision: 5,
      projectID: canonical,
      grants: [expect.objectContaining({ id: duplicateGrant })],
    })
    expect(await Storage.read(["project", duplicate]).catch(() => undefined)).toBeUndefined()
    expect(await Storage.read(["session", duplicate, duplicateSession]).catch(() => undefined)).toBeUndefined()
    expect(
      await Storage.read(["session_filesystem", duplicate, duplicateSession]).catch(() => undefined),
    ).toBeUndefined()
    expect(await Project.resolve(duplicate)).toMatchObject({
      project: { id: canonical },
      alias: duplicate,
    })
  })

  test("a direct opaque record beats a colliding alias while a direct legacy record follows migration", async () => {
    await using canonicalRoot = await tmpdir()
    await using targetRoot = await tmpdir()
    const opaque = "prj_direct_alias_collision"
    const target = "prj_stale_alias_target"
    const legacy = "ng_partial_direct_alias"
    await Storage.write(["project", opaque], {
      id: opaque,
      worktree: canonicalRoot.path,
      name: "canonical",
      sandboxes: [],
      time: { created: 1, updated: 1 },
    })
    await Storage.write(["project", target], {
      id: target,
      worktree: targetRoot.path,
      name: "stale target",
      sandboxes: [],
      time: { created: 1, updated: 1 },
    })
    await Storage.write(["project", legacy], {
      id: legacy,
      worktree: canonicalRoot.path,
      name: "legacy",
      sandboxes: [],
      time: { created: 1, updated: 1 },
    })
    await Storage.write(["project_alias", opaque], {
      id: opaque,
      projectID: target,
      time: { created: 1 },
    })
    await Storage.write(["project_alias", legacy], {
      id: legacy,
      projectID: opaque,
      time: { created: 1 },
    })

    const canonical = await Project.resolve(opaque)
    const migrated = await Project.resolve(legacy)

    expect(canonical).toMatchObject({
      project: {
        id: opaque,
        name: "canonical",
      },
      directory: canonicalRoot.path,
      alias: undefined,
    })
    expect(migrated).toMatchObject({
      project: {
        id: opaque,
        name: "canonical",
      },
      directory: canonicalRoot.path,
      alias: legacy,
    })
  })

  test("adopts an ng record and keeps its id as a resolving alias", async () => {
    await using tmp = await tmpdir()
    const legacyID = "ng-deterministic-migration"
    await Storage.write(["project", legacyID], {
      id: legacyID,
      worktree: tmp.path,
      name: "ng metadata",
      sandboxes: [],
      time: { created: 21, updated: 22 },
    })

    const first = await Project.fromDirectory(tmp.path)
    const second = await Project.fromDirectory(tmp.path)
    const selected = await Project.resolve(legacyID)

    expect(first.project.id).toStartWith("prj_")
    expect(first.project).toMatchObject({
      name: "ng metadata",
      time: {
        created: 21,
      },
    })
    expect(second.project.id).toBe(first.project.id)
    expect(selected.project.id).toBe(first.project.id)
    expect(selected.alias).toBe(legacyID)
    expect(await Storage.read(["project", legacyID]).catch(() => null)).toBeNull()
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

  test("preserves connected folders and file access when a folder project becomes opaque", async () => {
    await using root = await tmpdir()
    await using context = await tmpdir({
      init: (directory) => Bun.write(path.join(directory, "research.txt"), "preserved context"),
    })
    const legacy = crypto.createHash("sha256").update(root.path).digest("hex").slice(0, 40)
    const sessionID = `ses_${crypto.randomUUID().replaceAll("-", "")}`
    await Storage.write(["project", legacy], {
      id: legacy,
      worktree: root.path,
      name: "Legacy research",
      sandboxes: [context.path],
      time: { created: 1, updated: 2 },
    })
    await Storage.write(["session", legacy, sessionID], {
      id: sessionID,
      slug: "legacy-research",
      projectID: legacy,
      directory: root.path,
      title: "Existing research session",
      version: "1.0.0",
      permission: [{ permission: "read", pattern: "*", action: "allow" }],
      time: { created: 3, updated: 4 },
    })
    await Storage.write(["session_filesystem", legacy, sessionID], {
      version: 1,
      revision: 7,
      sessionID,
      projectID: legacy,
      directory: root.path,
      grants: [
        {
          id: `fsg_${crypto.randomUUID()}`,
          path: root.path,
          access: "write",
          scope: "session",
          source: "workspace",
          time: { created: 5 },
        },
        {
          id: `fsg_${crypto.randomUUID()}`,
          path: context.path,
          access: "read",
          scope: "session",
          source: "permission",
          time: { created: 6 },
        },
      ],
    })
    await Storage.write(["session_workspace", legacy, sessionID], {
      schemaVersion: 1,
      workspaceID: `wsp_${crypto.randomUUID()}`,
      projectID: legacy,
      sessionID,
      scratchRoot: root.path,
      mode: "legacy",
      state: "active",
      grantRevision: 7,
      createdAt: 3,
      lastUsedAt: 4,
      size: 0,
    })

    const result = await Instance.provide({
      directory: root.path,
      fn: async () => {
        const session = await Session.get(sessionID)
        const state = await SessionFilesystem.state(sessionID)
        const workspace = await SessionWorkspace.get(sessionID)
        const file = await File.read(path.join(context.path, "research.txt"), { sessionID })
        return {
          project: Instance.project,
          session,
          state,
          workspace,
          file,
        }
      },
    })

    expect(result.project.id).toStartWith("prj_")
    expect(result.project.sandboxes).toContain(context.path)
    expect(result.session).toMatchObject({
      id: sessionID,
      projectID: result.project.id,
      title: "Existing research session",
      permission: [{ permission: "read", pattern: "*", action: "allow" }],
    })
    expect(result.state).toMatchObject({
      sessionID,
      projectID: result.project.id,
      directory: root.path,
    })
    expect(result.state.revision).toBeGreaterThanOrEqual(7)
    expect(result.state.grants).toContainEqual(
      expect.objectContaining({
        path: context.path,
        access: "read",
        scope: "session",
        source: "permission",
      }),
    )
    expect(result.workspace).toMatchObject({
      projectID: result.project.id,
      sessionID,
      scratchRoot: root.path,
      mode: "legacy",
    })
    expect(result.file.content).toBe("preserved context")
    expect(await Storage.read(["session", legacy, sessionID]).catch(() => null)).toBeNull()
    expect(await Storage.read(["session_filesystem", legacy, sessionID]).catch(() => null)).toBeNull()
    expect(await Storage.read(["session_workspace", legacy, sessionID]).catch(() => null)).toBeNull()
  })

  test("recovers grants stranded by a prior partial opaque migration", async () => {
    await using root = await tmpdir()
    await using context = await tmpdir({
      init: (directory) => Bun.write(path.join(directory, "notes.md"), "# Durable notes"),
    })
    const created = await Project.fromDirectory(root.path)
    const legacy = `ng-partial-${crypto.randomUUID()}`
    const sessionID = `ses_${crypto.randomUUID().replaceAll("-", "")}`
    await Storage.write(["project_alias", legacy], {
      id: legacy,
      projectID: created.project.id,
      time: { created: 1 },
    })
    await Storage.write(["session", created.project.id, sessionID], {
      id: sessionID,
      slug: "partially-migrated",
      projectID: created.project.id,
      directory: root.path,
      title: "Partially migrated research",
      version: "1.0.0",
      time: { created: 2, updated: 3 },
    })
    await Storage.write(["session_filesystem", created.project.id, sessionID], {
      version: 1,
      revision: 2,
      sessionID,
      projectID: created.project.id,
      directory: root.path,
      grants: [
        {
          id: `fsg_${crypto.randomUUID()}`,
          path: root.path,
          access: "write",
          scope: "session",
          source: "workspace",
          time: { created: 4 },
        },
      ],
    })
    await Storage.write(["session_filesystem", legacy, sessionID], {
      version: 1,
      revision: 8,
      sessionID,
      projectID: legacy,
      directory: root.path,
      grants: [
        {
          id: `fsg_${crypto.randomUUID()}`,
          path: context.path,
          access: "read",
          scope: "session",
          source: "permission",
          time: { created: 5 },
        },
      ],
    })

    await Project.fromDirectory(root.path)

    const result = await Instance.provide({
      directory: root.path,
      fn: async () => ({
        state: await SessionFilesystem.state(sessionID),
        file: await File.read(path.join(context.path, "notes.md"), { sessionID }),
      }),
    })
    expect(result.state.revision).toBeGreaterThanOrEqual(9)
    expect(result.state.grants.map((grant) => grant.path)).toEqual(expect.arrayContaining([root.path, context.path]))
    expect(result.file.content).toBe("# Durable notes")
    expect(await Storage.read(["session_filesystem", legacy, sessionID]).catch(() => null)).toBeNull()
  })

  test("deduplicates concurrent first opens", async () => {
    await using tmp = await tmpdir()

    const opened = await Promise.all(Array.from({ length: 16 }, () => Project.fromDirectory(tmp.path)))
    const ids = new Set(opened.map((result) => result.project.id))
    const stored = (await Project.list()).filter((record) => record.worktree === tmp.path)

    expect(ids.size).toBe(1)
    expect(opened[0].project.id).toStartWith("prj_")
    expect(stored.map((record) => record.id)).toEqual([opened[0].project.id])
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

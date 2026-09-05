import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { File } from "../../src/file"
import { ProjectPreview } from "../../src/file/project-preview"
import { SafeFileIO } from "../../src/file/safe-io"
import { Instance } from "../../src/project/instance"
import { ManagedProject } from "../../src/project/managed"
import { FileRoutes } from "../../src/server/routes/file"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../fixture/fixture"

async function managed(fn: (session: Session.Info, directory: string) => Promise<void>) {
  const project = await ManagedProject.create("Project preview fixture")
  await Instance.provide({
    directory: project.worktree,
    projectID: project.id,
    fn: async () => {
      const session = await Session.create({})
      try {
        await fn(session, project.worktree)
      } finally {
        await Session.remove(session.id)
        await Instance.dispose()
      }
    },
  })
}

describe("managed project preview authority", () => {
  for (const absolute of [false, true]) {
    test(`opens a ${absolute ? "absolute" : "relative"} durable link without granting agent access`, async () => {
      await managed(async (session, directory) => {
        const target = path.join(directory, "COST_MODEL.md")
        await Bun.write(target, "# Fixture document\n")
        const grants = await SessionFilesystem.list(session.id)
        const requested = absolute ? target : "COST_MODEL.md"
        await expect(File.read(target, { sessionID: session.id })).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
        const response = await FileRoutes().request(
          `/file/resolve?${new URLSearchParams({
            path: requested,
            sessionID: session.id,
            projectPreview: "true",
          })}`,
        )
        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({ path: target, writable: false, scope: "project" })
        const content = await FileRoutes().request(
          `/file/content?${new URLSearchParams({
            path: target,
            sessionID: session.id,
            projectPreview: "true",
          })}`,
        )
        expect(content.status).toBe(200)
        expect(await content.json()).toMatchObject({ content: "# Fixture document\n" })
        const raw = await FileRoutes().request(
          `/file/raw?${new URLSearchParams({
            path: target,
            sessionID: session.id,
            projectPreview: "true",
            inline: "true",
          })}`,
        )
        expect(raw.status).toBe(200)
        expect(await raw.text()).toBe("# Fixture document\n")
        expect(await SessionFilesystem.list(session.id)).toEqual(grants)
        expect(await SessionFilesystem.processReadRoots(session.id)).not.toContain(directory)
        await expect(File.write(target, "changed", { sessionID: session.id })).rejects.toBeInstanceOf(
          SessionFilesystem.DeniedError,
        )
      })
    })
  }

  test("does not resolve a sibling project, sibling scratch, external path, or symlink escape", async () => {
    const sibling = await ManagedProject.create("Sibling fixture")
    await using external = await tmpdir({ init: (dir) => Bun.write(path.join(dir, "secret.md"), "private fixture") })
    await managed(async (session, directory) => {
      const other = await Session.create({})
      const scratch = await SessionFilesystem.workspace(other.id)
      const targets = [
        path.join(sibling.worktree, "secret.md"),
        path.join(scratch, "secret.md"),
        path.join(external.path, "secret.md"),
      ]
      await Promise.all(targets.map((target) => Bun.write(target, "private fixture")))
      await fs.symlink(external.path, path.join(directory, "linked"), process.platform === "win32" ? "junction" : "dir")
      targets.push(path.join(directory, "linked/secret.md"))
      for (const target of targets) {
        expect(await ProjectPreview.resolve(target, session.id)).toBeUndefined()
        await expect(File.read(target, { sessionID: session.id, projectPreview: true })).rejects.toBeInstanceOf(
          SessionFilesystem.DeniedError,
        )
      }
      await expect(File.read(path.join(directory, "missing.md"), { projectPreview: true })).rejects.toBeInstanceOf(
        SessionFilesystem.DeniedError,
      )
      await Session.remove(other.id)
    })
  })

  test("rejects mismatched session identity and a removed managed-project marker", async () => {
    await managed(async (session, directory) => {
      const target = path.join(directory, "note.md")
      await Bun.write(target, "fixture")
      const key = ["session", session.projectID, session.id]
      const saved = await Storage.read<Session.Info>(key)
      await Storage.write(key, { ...saved, directory: path.dirname(directory) })
      await expect(ProjectPreview.authorize(target, session.id)).rejects.toThrow()
      await Storage.write(key, saved)
      await Storage.remove(["managed_project", session.projectID])
      await expect(ProjectPreview.authorize(target, session.id)).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
    })
  })

  test("does not retarget project authority when its root becomes a sibling-project symlink", async () => {
    const sibling = await ManagedProject.create("Sibling root fixture")
    await Bun.write(path.join(sibling.worktree, "note.md"), "sibling fixture")
    await managed(async (session, directory) => {
      const target = path.join(directory, "note.md")
      await Bun.write(target, "original fixture")
      expect(await ProjectPreview.resolve(target, session.id)).toBe(target)
      const moved = `${directory}-original`
      await fs.rename(directory, moved)
      await fs.symlink(sibling.worktree, directory, process.platform === "win32" ? "junction" : "dir")
      try {
        expect(await ProjectPreview.resolve(target, session.id)).toBeUndefined()
        await expect(File.read(target, { sessionID: session.id, projectPreview: true })).rejects.toBeInstanceOf(
          SessionFilesystem.DeniedError,
        )
        await expect(File.rawSource(target, { sessionID: session.id, projectPreview: true })).rejects.toBeInstanceOf(
          SessionFilesystem.DeniedError,
        )
      } finally {
        await fs.unlink(directory)
        await fs.rename(moved, directory)
      }
    })
  })

  test("does not bypass external grant revocation or reinterpret a connected file as project-owned", async () => {
    await using external = await tmpdir({ init: (dir) => Bun.write(path.join(dir, "connected.md"), "fixture") })
    await managed(async (session) => {
      const target = path.join(external.path, "connected.md")
      const grant = await SessionFilesystem.grant({
        sessionID: session.id,
        path: external.path,
        access: "read",
        scope: "session",
      })
      expect((await File.read(target, { sessionID: session.id })).content).toBe("fixture")
      expect(await ProjectPreview.resolve(target, session.id)).toBeUndefined()
      await SessionFilesystem.revoke(session.id, grant.id)
      await expect(File.read(target, { sessionID: session.id })).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
      await expect(File.read(target, { sessionID: session.id, projectPreview: true })).rejects.toBeInstanceOf(
        SessionFilesystem.DeniedError,
      )
    })
  })

  test("session retirement waits for a current preview read and rejects future reads", async () => {
    await managed(async (_session, directory) => {
      const session = await Session.create({})
      const target = path.join(directory, "note.md")
      await Bun.write(target, "fixture")
      const started = Promise.withResolvers<void>()
      const resume = Promise.withResolvers<void>()
      using hook = SafeFileIO.testing({
        afterReadStat: async (file) => {
          if (file !== target) return
          started.resolve()
          await resume.promise
        },
      })
      const read = File.read(target, { sessionID: session.id, projectPreview: true })
      await started.promise
      let retired = false
      const removal = Session.remove(session.id).then(() => {
        retired = true
      })
      try {
        let exists = true
        for (let i = 0; i < 100 && exists; i++) {
          exists = await Storage.read(["session", session.projectID, session.id]).then(
            () => true,
            () => false,
          )
          if (exists) await Bun.sleep(2)
        }
        expect(exists).toBe(false)
        expect(retired).toBe(false)
      } finally {
        resume.resolve()
        await Promise.all([read, removal])
      }
      expect(retired).toBe(true)
      await expect(File.read(target, { sessionID: session.id, projectPreview: true })).rejects.toThrow()
    })
  })

  test("an open raw preview rechecks session identity before its next chunk", async () => {
    await managed(async (_session, directory) => {
      const session = await Session.create({})
      const target = path.join(directory, "note.md")
      await Bun.write(target, "fixture")
      const source = await File.rawSource(target, { sessionID: session.id, projectPreview: true })
      await Session.remove(session.id)
      try {
        await expect(new Response(source.stream()).text()).rejects.toThrow()
      } finally {
        await source.close()
      }
    })
  })

  for (const raw of [false, true]) {
    test(`rechecks symlink replacement before ${raw ? "raw" : "content"} I/O`, async () => {
      await using external = await tmpdir({ init: (dir) => Bun.write(path.join(dir, "secret.md"), "private fixture") })
      await managed(async (session, directory) => {
        const target = path.join(directory, "note.md")
        await Bun.write(target, "original")
        using hook = File.testing({
          afterReadAuthorization: async () => {
            await fs.unlink(target)
            await fs.symlink(path.join(external.path, "secret.md"), target)
          },
        })
        const options = { sessionID: session.id, projectPreview: true }
        await expect(raw ? File.rawSource(target, options) : File.read(target, options)).rejects.toBeInstanceOf(
          SessionFilesystem.DeniedError,
        )
      })
    })
  }
})

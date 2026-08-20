import { describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { FileTrash } from "../../src/file/trash"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { FileRoutes } from "../../src/server/routes/file"
import { executionSession, tmpdir } from "../fixture/fixture"

describe("recoverable source file trash", () => {
  test("retains approved bytes for 30 days and restores through the file route", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const target = path.join(tmp.path, "results", "finding.txt")
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, "approved finding\n", { mode: 0o640 })

        const trashed = await FileTrash.trash({
          projectID: Instance.project.id,
          sessionID: session.id,
          path: target,
          expectedContent: "approved finding\n",
        })

        expect(trashed).toMatchObject({
          originalPath: target,
          filename: "finding.txt",
          state: "trash",
          size: 17,
          mode: 0o640,
        })
        expect(trashed.expiresAt - trashed.trashedAt).toBe(FileTrash.RETENTION_MS)
        await expect(fs.readFile(target)).rejects.toThrow()

        const listed = await FileRoutes().request("/file/trash")
        expect(listed.status).toBe(200)
        expect(await listed.json()).toMatchObject([{ id: trashed.id, originalPath: target, state: "trash" }])

        const restored = await FileRoutes().request(`/file/trash/${trashed.id}/restore`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: session.id }),
        })
        expect(restored.status).toBe(200)
        expect(await restored.json()).toMatchObject({ id: trashed.id, state: "restored" })
        expect(await fs.readFile(target, "utf8")).toBe("approved finding\n")
        if (process.platform !== "win32") expect((await fs.stat(target)).mode & 0o777).toBe(0o640)
        expect(await FileTrash.list(Instance.project.id)).toEqual([])

        const duplicate = await FileRoutes().request(`/file/trash/${trashed.id}/restore`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: session.id }),
        })
        expect(duplicate.status).toBe(404)
      },
    })
  })

  test("fails closed on changed bytes, symbolic links, and restore conflicts", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const target = path.join(tmp.path, "source.txt")
        await fs.writeFile(target, "new bytes\n")
        await expect(
          FileTrash.trash({
            projectID: Instance.project.id,
            sessionID: session.id,
            path: target,
            expectedContent: "approved bytes\n",
          }),
        ).rejects.toThrow("changed after approval")
        expect(await fs.readFile(target, "utf8")).toBe("new bytes\n")
        expect(await FileTrash.list(Instance.project.id)).toEqual([])

        if (process.platform !== "win32") {
          const linked = path.join(tmp.path, "linked.txt")
          await fs.symlink(target, linked)
          await expect(
            FileTrash.trash({ projectID: Instance.project.id, sessionID: session.id, path: linked }),
          ).rejects.toThrow("symbolic link")
          expect(await fs.readlink(linked)).toBe(target)
          expect(await fs.readFile(target, "utf8")).toBe("new bytes\n")

          const redirected = path.join(tmp.path, "redirected-trash")
          const trash = path.join(tmp.path, FileTrash.FOLDER)
          await fs.rm(trash, { recursive: true })
          await fs.mkdir(redirected)
          await fs.symlink(redirected, trash)
          await expect(
            FileTrash.trash({ projectID: Instance.project.id, sessionID: session.id, path: target }),
          ).rejects.toThrow("Invalid workspace trash root")
          expect(await fs.readFile(target, "utf8")).toBe("new bytes\n")
          await fs.unlink(trash)
          await fs.rm(redirected, { recursive: true })
        }

        const trashed = await FileTrash.trash({
          projectID: Instance.project.id,
          sessionID: session.id,
          path: target,
          expectedContent: "new bytes\n",
        })
        await fs.writeFile(target, "replacement must survive\n")
        await expect(
          FileTrash.restore({ projectID: Instance.project.id, sessionID: session.id, id: trashed.id }),
        ).rejects.toThrow("Refusing to overwrite")
        expect(await fs.readFile(target, "utf8")).toBe("replacement must survive\n")
        expect(await FileTrash.list(Instance.project.id)).toMatchObject([{ id: trashed.id, state: "trash" }])
      },
    })
  })

  test("purges expired recovery copies", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const target = path.join(tmp.path, "expired.txt")
        await fs.writeFile(target, "expired\n")
        const record = await FileTrash.trash({
          projectID: Instance.project.id,
          sessionID: session.id,
          path: target,
          now: Date.now() - FileTrash.RETENTION_MS - 1,
        })
        expect(record.expiresAt).toBeLessThan(Date.now())
        expect(await FileTrash.list(Instance.project.id)).toEqual([])
        expect(
          await FileTrash.restore({ projectID: Instance.project.id, sessionID: session.id, id: record.id }),
        ).toBeUndefined()
      },
    })
  })

  test("does not advertise metadata written before a recovery payload exists", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const id = `ftr_${crypto.randomUUID()}`
        const projectID = Instance.project.id
        const project = crypto.createHash("sha256").update(projectID).digest("hex")
        const entry = path.join(Global.Path.data, "file-trash", project, id)
        const now = Date.now()
        await fs.mkdir(entry, { recursive: true })
        await fs.writeFile(
          path.join(entry, "record.json"),
          JSON.stringify({
            id,
            projectID,
            originalPath: path.join(tmp.path, "still-present.txt"),
            filename: "still-present.txt",
            size: 1,
            sha256: "0".repeat(64),
            mode: 0o600,
            state: "trash",
            trashedAt: now,
            expiresAt: now + FileTrash.RETENTION_MS,
          }),
        )
        expect(await FileTrash.list(projectID)).toEqual([])
        await fs.rm(entry, { recursive: true, force: true })
      },
    })
  })

  test("moves folders into same-volume workspace trash and restores them through the routes", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const target = path.join(tmp.path, "dataset")
        await fs.mkdir(path.join(target, "nested"), { recursive: true })
        await fs.writeFile(path.join(target, "nested", "sample.csv"), "x,y\n1,2\n")

        const response = await FileRoutes().request("/file/trash", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: target, sessionID: session.id }),
        })
        expect(response.status).toBe(200)
        const record = (await response.json()) as FileTrash.Record
        expect(record).toMatchObject({ filename: "dataset", kind: "directory", store: "workspace" })
        expect(record.payloadPath).toContain(`${path.sep}${FileTrash.FOLDER}${path.sep}${record.id}${path.sep}payload`)
        expect(await fs.readFile(path.join(tmp.path, FileTrash.FOLDER, ".gitignore"), "utf8")).toBe("*\n")
        await expect(fs.stat(target)).rejects.toThrow()

        const second = path.join(tmp.path, "second.txt")
        await fs.writeFile(second, "second\n")
        const secondRecord = await FileTrash.trash({
          projectID: Instance.project.id,
          sessionID: session.id,
          path: second,
        })
        expect(await fs.readFile(path.join(tmp.path, FileTrash.FOLDER, ".gitignore"), "utf8")).toBe("*\n")
        await FileTrash.purge({ projectID: Instance.project.id, sessionID: session.id, id: secondRecord.id })

        const listing = await FileRoutes().request(
          `/file?path=${encodeURIComponent(tmp.path)}&sessionID=${encodeURIComponent(session.id)}`,
        )
        expect(listing.status).toBe(200)
        expect((await listing.json()) as Array<{ name: string }>).not.toContainEqual({ name: FileTrash.FOLDER })

        const restored = await FileRoutes().request(`/file/trash/${record.id}/restore`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: session.id }),
        })
        expect(restored.status).toBe(200)
        expect(await fs.readFile(path.join(target, "nested", "sample.csv"), "utf8")).toBe("x,y\n1,2\n")
      },
    })
  })

  test("permanently purges a recoverable file through the route", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const target = path.join(tmp.path, "discard.txt")
        await fs.writeFile(target, "discard\n")
        const trashed = await FileTrash.trash({
          projectID: Instance.project.id,
          sessionID: session.id,
          path: target,
        })

        const response = await FileRoutes().request(`/file/trash/${trashed.id}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: session.id }),
        })
        expect(response.status).toBe(200)
        expect(await FileTrash.list(Instance.project.id)).toEqual([])
        await expect(fs.stat(target)).rejects.toThrow()
        if (trashed.payloadPath) await expect(fs.stat(trashed.payloadPath)).rejects.toThrow()
      },
    })
  })

  test("rollback restores the original file mode", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const target = path.join(tmp.path, "rollback.txt")
        await fs.writeFile(target, "rollback\n", { mode: 0o640 })
        const record = await FileTrash.trash({
          projectID: Instance.project.id,
          sessionID: session.id,
          path: target,
        })

        await FileTrash.rollback(record)
        expect(await fs.readFile(target, "utf8")).toBe("rollback\n")
        if (process.platform !== "win32") expect((await fs.stat(target)).mode & 0o777).toBe(0o640)
        expect(await FileTrash.list(Instance.project.id)).toEqual([])
      },
    })
  })

  test("rejects forged workspace metadata before restore", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const target = path.join(tmp.path, "trusted.txt")
        const forged = path.join(tmp.path, "forged.txt")
        await fs.writeFile(target, "trusted\n")
        const record = await FileTrash.trash({
          projectID: Instance.project.id,
          sessionID: session.id,
          path: target,
        })
        expect(record.payloadPath).toBeString()
        const local = path.join(path.dirname(record.payloadPath!), "record.json")
        await fs.writeFile(local, JSON.stringify({ ...record, originalPath: forged }))

        await expect(
          FileTrash.restore({ projectID: Instance.project.id, sessionID: session.id, id: record.id }),
        ).rejects.toThrow("metadata mismatch")
        await expect(fs.stat(forged)).rejects.toThrow()
        await expect(fs.stat(target)).rejects.toThrow()
        expect(await fs.readFile(record.payloadPath!, "utf8")).toBe("trusted\n")
      },
    })
  })
})

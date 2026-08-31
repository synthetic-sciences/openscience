import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { File } from "../../src/file"
import { FileRoutes } from "../../src/server/routes/file"
import { Instance } from "../../src/project/instance"
import { Project } from "../../src/project/project"
import { Storage } from "../../src/storage/storage"
import { FileTrash } from "../../src/file/trash"
import { executionSession, tmpdir } from "../fixture/fixture"

const read = async (file: string, sessionID: string) => {
  const response = await FileRoutes().request(`/file/content?${new URLSearchParams({ path: file, sessionID })}`)
  expect(response.status).toBe(200)
  return File.Content.parse(await response.json())
}

const save = (file: string, sessionID: string, content: string, expectedRevision?: string) =>
  FileRoutes().request("/file/content", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path: file, sessionID, content, expectedRevision }),
  })

test("editor revisions reject stale saves without discarding external changes", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await executionSession()
      const target = path.join(tmp.path, "draft.txt")
      await fs.writeFile(target, "baseline\n")
      const baseline = await read(target, session.id)
      expect(baseline.revision).toMatch(/^[a-f0-9]{64}$/)
      await fs.writeFile(target, "baseline\nexternal result\n")

      const response = await save(target, session.id, "baseline\neditor draft\n", baseline.revision)
      expect(response.status).toBe(409)
      expect(await response.text()).toContain("File changed on disk")
      expect(await fs.readFile(target, "utf8")).toBe("baseline\nexternal result\n")
    },
  })
})

test("successful editor saves advance the revision and legacy callers remain supported", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await executionSession()
      const target = path.join(tmp.path, "draft.txt")
      await fs.writeFile(target, "first – result\n")
      const baseline = await read(target, session.id)
      const response = await save(target, session.id, "second – result\n", baseline.revision)
      expect(response.status).toBe(200)
      const saved = File.Content.parse(await response.json())
      expect(saved.revision).toMatch(/^[a-f0-9]{64}$/)
      expect(saved.revision).not.toBe(baseline.revision)
      expect((await read(target, session.id)).revision).toBe(saved.revision)
      expect((await save(target, session.id, "stale\n", baseline.revision)).status).toBe(409)
      expect((await save(target, session.id, "legacy\n")).status).toBe(200)
      expect(await fs.readFile(target, "utf8")).toBe("legacy\n")
    },
  })
})

test("an editor revision cannot be reused after identical content moves to a different file", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await executionSession()
      const target = path.join(tmp.path, "draft.txt")
      await fs.writeFile(target, "baseline\n")
      const baseline = await read(target, session.id)
      await fs.rename(target, path.join(tmp.path, "retained.txt"))
      await fs.writeFile(target, "baseline\n")

      expect((await save(target, session.id, "wrong file\n", baseline.revision)).status).toBe(409)
      expect(await fs.readFile(target, "utf8")).toBe("baseline\n")
      expect(await fs.readFile(path.join(tmp.path, "retained.txt"), "utf8")).toBe("baseline\n")
    },
  })
})

test("a stale draft cannot recreate a deleted source or overwrite a grown file", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await executionSession()
      const target = path.join(tmp.path, "draft.txt")
      await fs.writeFile(target, "baseline\n")
      const baseline = await read(target, session.id)
      await fs.unlink(target)
      expect((await save(target, session.id, "stale\n", baseline.revision)).status).toBe(409)
      expect(await fs.lstat(target).catch(() => undefined)).toBeUndefined()
      const handle = await fs.open(target, "w")
      await handle.truncate(9 * 1024 * 1024)
      await handle.close()
      expect((await save(target, session.id, "stale\n", baseline.revision)).status).toBe(409)
      expect((await fs.stat(target)).size).toBe(9 * 1024 * 1024)
      const truncated = await read(target, session.id)
      expect(truncated.truncated).toBe(true)
      expect(truncated.revision).toBeUndefined()
    },
  })
})

test("revision checks happen after authorization and competing saves cannot both overwrite", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await executionSession()
      const target = path.join(tmp.path, "draft.txt")
      await fs.writeFile(target, "baseline\n")
      const baseline = await read(target, session.id)
      {
        using barrier = File.testing({ afterWriteAuthorization: () => fs.writeFile(target, "external\n") })
        expect((await save(target, session.id, "stale\n", baseline.revision)).status).toBe(409)
        expect(await fs.readFile(target, "utf8")).toBe("external\n")
      }
      const current = await read(target, session.id)
      const responses = await Promise.all([
        save(target, session.id, "first\n", current.revision),
        save(target, session.id, "second\n", current.revision),
      ])
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409])
      const winner = responses.findIndex((response) => response.status === 200)
      expect(await fs.readFile(target, "utf8")).toBe(winner === 0 ? "first\n" : "second\n")
    },
  })
})

test("saving identical content preserves file identity and modification time", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await executionSession()
      const target = path.join(tmp.path, "draft.txt")
      await fs.writeFile(target, "unchanged\n")
      const baseline = await read(target, session.id)
      const before = await fs.stat(target)
      const response = await save(target, session.id, baseline.content, baseline.revision)
      expect(response.status).toBe(200)
      expect(File.Content.parse(await response.json()).revision).toBe(baseline.revision)
      const after = await fs.stat(target)
      expect(after.ino).toBe(before.ino)
      expect(after.mtimeMs).toBe(before.mtimeMs)
    },
  })
})

test("file mutations advance project activity but previews, no-op saves, and automatic expiry do not", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await executionSession()
      const projectID = Instance.project.id
      const reset = () =>
        Storage.update<Project.Info>(["project", projectID], (draft) => {
          draft.time.activity = 100
        })
      const activity = async () => (await Project.get(projectID)).time.activity
      const target = path.join(tmp.path, "draft.txt")
      await fs.writeFile(target, "baseline\n")
      await reset()
      const baseline = await read(target, session.id)
      await File.list(tmp.path, { sessionID: session.id })
      expect(await activity()).toBe(100)
      expect((await save(target, session.id, baseline.content, baseline.revision)).status).toBe(200)
      await File.rename({ from: target, to: target, sessionID: session.id })
      expect(await activity()).toBe(100)

      expect((await save(target, session.id, "saved\n", baseline.revision)).status).toBe(200)
      expect(await activity()).toBeGreaterThan(100)
      await reset()
      const renamed = path.join(tmp.path, "renamed.txt")
      await File.rename({ from: target, to: renamed, sessionID: session.id })
      expect(await activity()).toBeGreaterThan(100)
      await reset()
      const record = await FileTrash.trash({ projectID, sessionID: session.id, path: renamed })
      expect(await activity()).toBeGreaterThan(100)
      await reset()
      await FileTrash.restore({ projectID, sessionID: session.id, id: record.id })
      expect(await activity()).toBeGreaterThan(100)
      await reset()
      await FileTrash.list(projectID)
      await FileTrash.purgeExpired(projectID, record.expiresAt + 1)
      expect(await activity()).toBe(100)
    },
  })
})

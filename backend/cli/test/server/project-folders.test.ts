import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { File } from "../../src/file"
import { Instance } from "../../src/project/instance"
import { Project } from "../../src/project/project"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../fixture/fixture"

const fetch = Server.internalFetch()
const request = (projectID: string, route: string, body?: unknown, method = body ? "POST" : "GET") =>
  fetch(`http://openscience.internal${route}`, {
    method,
    headers: { "x-openscience-project": projectID, "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })

describe("project folder lifecycle", () => {
  test("connects, browses, edits, changes access, and disconnects without creating a conversation", async () => {
    await using project = await tmpdir()
    await using folder = await tmpdir({ init: (root) => Bun.write(path.join(root, "notes.txt"), "existing notes") })
    const id = (await Project.fromDirectory(project.path)).project.id
    const file = path.join(folder.path, "notes.txt")
    const connected = await request(id, "/project/current/filesystem", { path: folder.path, access: "write" })
    expect(connected.status).toBe(200)
    const grant = SessionFilesystem.Grant.parse(await connected.json())
    const snapshot = await request(id, "/project/current/filesystem").then((response) => response.json())
    expect(snapshot).toMatchObject({
      projectID: id,
      directory: project.path,
      toolDirectory: folder.path,
      grants: [grant],
    })
    expect(snapshot.sessionID).toBeUndefined()
    const listing = await request(id, `/file?path=${encodeURIComponent(folder.path)}`)
    expect(listing.status).toBe(200)
    expect(await listing.json()).toContainEqual(expect.objectContaining({ name: "notes.txt", absolute: file }))
    const read = await request(id, `/file/content?path=${encodeURIComponent(file)}`).then((response) => response.json())
    expect(read).toMatchObject({ content: "existing notes", writable: true })
    const saved = await request(
      id,
      "/file/content",
      { path: file, content: "edited in place", expectedRevision: read.revision },
      "PUT",
    )
    expect(saved.status).toBe(200)
    expect(await Bun.file(file).text()).toBe("edited in place")
    expect(
      (
        await request(
          id,
          "/file/content",
          { path: file, content: "stale edit", expectedRevision: read.revision },
          "PUT",
        )
      ).status,
    ).toBe(409)
    const downgraded = await request(id, "/project/current/filesystem", { path: folder.path, access: "read" })
    const readonly = SessionFilesystem.Grant.parse(await downgraded.json())
    expect(readonly.id).not.toBe(grant.id)
    expect(
      (await request(id, `/file/content?path=${encodeURIComponent(file)}`).then((response) => response.json()))
        .writable,
    ).toBe(false)
    expect((await request(id, "/file/content", { path: file, content: "forbidden" }, "PUT")).status).toBe(403)
    const raw = await request(id, `/file/raw?path=${encodeURIComponent(file)}`)
    expect(raw.status).toBe(200)
    expect(await raw.text()).toBe("edited in place")
    expect((await request(id, `/project/current/filesystem/${readonly.id}`, undefined, "DELETE")).status).toBe(200)
    expect((await request(id, `/file/content?path=${encodeURIComponent(file)}`)).status).toBe(403)
    expect(await Bun.file(file).text()).toBe("edited in place")
    expect(await Storage.list(["session", id])).toEqual([])
    expect(await Storage.list(["session_workspace", id])).toEqual([])
  })

  test("a saved project default reaches existing and new sessions while explicit conversation choices win", async () => {
    await using project = await tmpdir()
    await using first = await tmpdir()
    await using second = await tmpdir()
    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const early = await Session.create({})
        await SessionFilesystem.seedProject({
          projectID: Instance.project.id,
          grants: [{ path: first.path, access: "write" }],
        })
        expect(await SessionFilesystem.toolDirectory(early.id)).toBe(first.path)
        await SessionFilesystem.connectProject({ path: second.path, access: "write" })
        await SessionFilesystem.setProjectWorkingRoot(first.path)
        expect(await SessionFilesystem.toolDirectory(early.id)).toBe(first.path)
        const later = await Session.create({})
        expect(await SessionFilesystem.toolDirectory(later.id)).toBe(first.path)
        await SessionFilesystem.setWorkingRoot(early.id, second.path)
        expect(await SessionFilesystem.toolDirectory(early.id)).toBe(second.path)
        await SessionFilesystem.connectProject({ path: first.path, access: "read" })
        expect(await SessionFilesystem.toolDirectory(later.id)).toBe(await SessionFilesystem.workspace(later.id))
        expect(
          await SessionFilesystem.allows({
            sessionID: later.id,
            path: path.join(first.path, "new.txt"),
            access: "write",
          }),
        ).toBe(false)
        expect(await SessionFilesystem.processWriteRoots(later.id)).not.toContain(first.path)
        expect(await SessionFilesystem.processReadRoots(later.id)).toContain(first.path)
      },
    })
  })

  test("project file rename and recoverable trash need no session and retain grant checks", async () => {
    await using project = await tmpdir()
    await using folder = await tmpdir({ init: (root) => Bun.write(path.join(root, "before.txt"), "recover me") })
    const id = (await Project.fromDirectory(project.path)).project.id
    const grant = await request(id, "/project/current/filesystem", { path: folder.path, access: "write" }).then(
      (response) => response.json(),
    )
    const from = path.join(folder.path, "before.txt")
    const to = path.join(folder.path, "after.txt")
    expect((await request(id, "/file/rename", { from, to })).status).toBe(200)
    expect(await Bun.file(from).exists()).toBe(false)
    const removed = await request(id, "/file/trash", { path: to })
    expect(removed.status).toBe(200)
    const item = await removed.json()
    expect(await Bun.file(to).exists()).toBe(false)
    await request(id, `/project/current/filesystem/${grant.id}`, undefined, "DELETE")
    expect((await request(id, `/file/trash/${item.id}/restore`, {})).status).toBe(403)
    await request(id, "/project/current/filesystem", { path: folder.path, access: "write" })
    expect((await request(id, `/file/trash/${item.id}/restore`, {})).status).toBe(200)
    expect(await Bun.file(to).text()).toBe("recover me")
    expect((await request(id, "/file/rename", { from: folder.path, to: `${folder.path}-moved` })).status).toBe(409)
    expect((await request(id, "/file/trash", { path: folder.path })).status).toBe(409)
    expect(await Storage.list(["session", id])).toEqual([])
  })

  test("canonical connections deduplicate and reject missing folders, files, scratch, and other projects' grants", async () => {
    await using project = await tmpdir()
    await using other = await tmpdir()
    await using folder = await tmpdir({
      init: async (root) => {
        await Bun.write(path.join(root, "file.txt"), "keep")
        await fs.symlink(root, path.join(root, "alias"), "dir")
      },
    })
    const id = (await Project.fromDirectory(project.path)).project.id
    const foreign = (await Project.fromDirectory(other.path)).project.id
    const original = await request(id, "/project/current/filesystem", { path: folder.path, access: "read" }).then(
      (response) => response.json(),
    )
    const duplicate = await request(id, "/project/current/filesystem", {
      path: path.join(folder.path, "alias"),
      access: "read",
    }).then((response) => response.json())
    expect(duplicate.id).toBe(original.id)
    for (const target of ["relative", path.join(folder.path, "missing"), path.join(folder.path, "file.txt")]) {
      expect((await request(id, "/project/current/filesystem", { path: target, access: "write" })).status).toBe(400)
    }
    expect((await request(foreign, `/file?path=${encodeURIComponent(folder.path)}`)).status).toBe(403)
    expect((await request(foreign, `/project/current/filesystem/${original.id}`, undefined, "DELETE")).status).toBe(404)
    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const session = await Session.create({})
        expect(
          (
            await request(id, "/project/current/filesystem", {
              path: await SessionFilesystem.workspace(session.id),
              access: "write",
            })
          ).status,
        ).toBe(400)
      },
    })
  })

  test("revocation between authorization and I/O blocks project writes and streamed reads", async () => {
    await using project = await tmpdir()
    await using folder = await tmpdir({ init: (root) => Bun.write(path.join(root, "notes.txt"), "untouched") })
    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const file = path.join(folder.path, "notes.txt")
        const grant = await SessionFilesystem.connectProject({ path: folder.path, access: "write" })
        using hooks = File.testing({
          afterWriteAuthorization: async () => {
            await SessionFilesystem.revokeProject(grant.id)
          },
        })
        await expect(File.write(file, "forbidden")).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
        expect(await Bun.file(file).text()).toBe("untouched")
        const read = await SessionFilesystem.connectProject({ path: folder.path, access: "read" })
        const source = await File.rawSource(file)
        await SessionFilesystem.revokeProject(read.id)
        await expect(new Response(source.stream()).text()).rejects.toBeDefined()
        await source.close()
      },
    })
  })

  test("a symlink out of a connected folder cannot read or overwrite an unconnected file", async () => {
    await using project = await tmpdir()
    await using outside = await tmpdir({ init: (root) => Bun.write(path.join(root, "private.txt"), "outside") })
    await using folder = await tmpdir({ init: (root) => fs.symlink(outside.path, path.join(root, "outside"), "dir") })
    const id = (await Project.fromDirectory(project.path)).project.id
    await request(id, "/project/current/filesystem", { path: folder.path, access: "write" })
    const target = path.join(folder.path, "outside", "private.txt")
    expect((await request(id, `/file/content?path=${encodeURIComponent(target)}`)).status).toBe(403)
    expect((await request(id, "/file/content", { path: target, content: "forbidden" }, "PUT")).status).toBe(403)
    expect(await Bun.file(path.join(outside.path, "private.txt")).text()).toBe("outside")
  })
})

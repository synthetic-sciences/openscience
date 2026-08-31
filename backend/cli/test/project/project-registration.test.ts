import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { Project } from "../../src/project/project"
import { ManagedProject } from "../../src/project/managed"
import { Instance } from "../../src/project/instance"
import { Storage } from "../../src/storage/storage"
import { Server } from "../../src/server/server"
import { Global } from "../../src/global"
import { tmpdir } from "../fixture/fixture"

describe("project registration boundaries", () => {
  test("global project listing never registers the server working directory", async () => {
    const before = await Storage.list(["project"])
    const response = await Server.internalFetch()("http://openscience.internal/project")
    expect(response.status).toBe(200)
    const legacyQuery = await Server.internalFetch()(
      "http://openscience.internal/project?directory=ignored-missing-legacy-directory",
    )
    expect(legacyQuery.status).toBe(200)
    expect(await Storage.list(["project"])).toEqual(before)
  })

  test("all instance registration entry points reject missing and relative directories before writing", async () => {
    await using tmp = await tmpdir()
    const before = await Storage.list(["project"])
    const missing = path.join(tmp.path, "does-not-exist")
    await expect(Project.fromDirectory(missing)).rejects.toBeInstanceOf(Project.DirectoryError)
    await expect(Project.fromDirectory("relative-folder")).rejects.toBeInstanceOf(Project.DirectoryError)
    await expect(Instance.provide({ directory: missing, fn: () => undefined })).rejects.toBeInstanceOf(
      Project.DirectoryError,
    )
    expect(await Storage.list(["project"])).toEqual(before)
  })

  test("a selected non-git child cwd stays in its parent project without creating another record", async () => {
    const parent = await ManagedProject.create("Parent for scoped child")
    const child = path.join(parent.worktree, "data")
    await fs.mkdir(child)
    const before = await Storage.list(["project"])
    const response = await Server.internalFetch()(
      `http://openscience.internal/project/current?directory=${encodeURIComponent(child)}`,
      {
        headers: { "x-openscience-project": parent.id },
      },
    )
    expect(response.status).toBe(200)
    expect((await response.json()).id).toBe(parent.id)
    expect(await Storage.list(["project"])).toEqual(before)
    expect((await ManagedProject.list()).some((project) => project.worktree === child)).toBe(false)
  })

  test("a removed root remains accessible to internal cleanup while public selectors fail stale", async () => {
    await using tmp = await tmpdir()
    const state = Instance.state(() => ({ closed: false }))
    const projectID = await Instance.provide({
      directory: tmp.path,
      fn: () => {
        state()
        return Instance.project.id
      },
    })
    await fs.rm(tmp.path, { recursive: true, force: true })
    const cleaned = await Instance.provide({
      directory: tmp.path,
      projectID,
      fn: async () => {
        state().closed = true
        await Instance.dispose()
        return true
      },
    })
    expect(cleaned).toBe(true)
    const response = await Server.internalFetch()("http://openscience.internal/project/current", {
      headers: { "x-openscience-project": projectID },
    })
    expect(response.status).toBe(410)
    await expect(Instance.provide({ directory: tmp.path, fn: () => undefined })).rejects.toBeInstanceOf(
      Project.DirectoryError,
    )
  })

  test("a wrong or conflicting selector cannot create or reuse another project's state", async () => {
    const parent = await ManagedProject.create("Parent for conflict")
    const child = path.join(parent.worktree, "independent")
    await fs.mkdir(child)
    const independent = await Instance.provide({ directory: child, fn: () => Instance.project.id })
    const before = await Storage.list(["project"])
    const response = await Server.internalFetch()(
      `http://openscience.internal/project/current?directory=${encodeURIComponent(child)}`,
      {
        headers: { "x-openscience-project": parent.id },
      },
    )
    expect(response.status).toBe(409)
    expect(await Storage.list(["project"])).toEqual(before)
    expect(await Instance.provide({ directory: child, fn: () => Instance.project.id })).toBe(independent)
    // Prior versions marked these incidental children as app-created. Hide the
    // unreceipted child without deleting its record, sessions or provenance.
    await Project.markOpenScience(independent)
    expect((await ManagedProject.list()).some((project) => project.id === independent)).toBe(false)
    expect((await Storage.read<Project.Info>(["project", independent])).origin).toBe("openscience")
    await Storage.write<ManagedProject.Info>(["managed_project", independent], {
      version: 1,
      projectID: independent,
      directory: child,
      time: { created: Date.now() },
    })
    expect((await ManagedProject.list()).some((project) => project.id === independent)).toBe(true)
  })

  test("legacy ownership promotion is restricted to existing direct UUID or digest roots", async () => {
    const root = path.join(Global.Path.data, "projects")
    await fs.mkdir(root, { recursive: true })
    const directory = path.join(root, crypto.randomUUID())
    const arbitrary = path.join(root, `incidental-${crypto.randomUUID()}`)
    await fs.mkdir(directory)
    await fs.mkdir(arbitrary)
    const legacy = (await Project.fromDirectory(directory)).project
    const unrelated = (await Project.fromDirectory(arbitrary)).project
    const listed = await ManagedProject.list()
    expect(listed.some((project) => project.id === legacy.id)).toBe(true)
    expect(listed.some((project) => project.id === unrelated.id)).toBe(false)
    expect((await Project.get(unrelated.id)).origin).toBeUndefined()
    const missing = {
      ...unrelated,
      id: `prj_${crypto.randomUUID().replaceAll("-", "")}`,
      worktree: path.join(root, crypto.randomUUID()),
    }
    await Storage.write(["project", missing.id], missing)
    expect((await ManagedProject.list()).some((project) => project.id === missing.id)).toBe(false)
    expect((await Project.get(missing.id)).origin).toBeUndefined()
  })

  test("directory-less legacy global history is preserved instead of assigned to the next opened project", async () => {
    await using tmp = await tmpdir()
    const id = `ses_unscoped_${crypto.randomUUID()}`
    const legacy = { id, projectID: "global", time: { created: 1, updated: 2 } }
    await Storage.write(["session", "global", id], legacy)
    const project = (await Project.fromDirectory(tmp.path)).project
    expect(await Storage.read<typeof legacy>(["session", "global", id])).toEqual(legacy)
    await expect(Storage.read(["session", project.id, id])).rejects.toBeInstanceOf(Storage.NotFoundError)
  })
})

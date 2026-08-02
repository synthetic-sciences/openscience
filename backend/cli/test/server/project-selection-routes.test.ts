import { $ } from "bun"
import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Project } from "../../src/project/project"
import { Server } from "../../src/server/server"
import { Storage } from "../../src/storage/storage"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

const fetch = Server.internalFetch()

describe("pre-instance project selection routes", () => {
  test("uses an opaque selector without a caller-owned directory", async () => {
    await using tmp = await tmpdir({ git: true })
    const created = await Project.fromDirectory(tmp.path)
    await fs.mkdir(path.join(tmp.path, ".openscience"), { recursive: true })
    await Bun.write(path.join(tmp.path, ".openscience", "project.json"), JSON.stringify({ project_id: "atlas-root" }))

    const repo = await fetch("http://openscience.internal/api/repo/status", {
      headers: {
        "x-openscience-project": created.project.id,
      },
    })
    const atlas = await fetch("http://openscience.internal/api/atlas/project", {
      headers: {
        "x-openscience-project": created.project.id,
      },
    })
    const folder = await fetch("http://openscience.internal/api/resolve-folder/validate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-openscience-project": created.project.id,
      },
      body: "{}",
    })

    expect(repo.status).toBe(200)
    expect(await repo.json()).toMatchObject({
      directory: tmp.path,
      isGit: true,
    })
    expect(atlas.status).toBe(200)
    expect(await atlas.json()).toEqual({ project_id: "atlas-root" })
    expect(folder.status).toBe(200)
    expect(await folder.json()).toMatchObject({
      ok: true,
      absolute: tmp.path,
    })
  })

  test("returns a structured unknown-project error before touching a route directory", async () => {
    await using tmp = await tmpdir()
    const projectID = `prj_unknown_${crypto.randomUUID()}`
    const response = await fetch(
      `http://openscience.internal/api/repo/status?directory=${encodeURIComponent(tmp.path)}`,
      {
        headers: {
          "x-openscience-project": projectID,
        },
      },
    )

    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({
      name: "ProjectUnknownError",
      data: {
        projectID,
      },
    })
  })

  test("returns a structured stale-project error from Atlas project resolution", async () => {
    await using tmp = await tmpdir()
    const created = await Project.fromDirectory(tmp.path)
    await fs.rm(tmp.path, { recursive: true, force: true })

    const response = await fetch("http://openscience.internal/api/atlas/project", {
      headers: {
        "x-openscience-project": created.project.id,
      },
    })

    expect(response.status).toBe(410)
    expect(await response.json()).toMatchObject({
      name: "ProjectStaleError",
      data: {
        projectID: created.project.id,
        reason: "missing_directory",
        directory: tmp.path,
      },
    })
  })

  test("rejects mismatched raw directory overrides on every local pre-instance route", async () => {
    await using first = await tmpdir({ git: true })
    await using second = await tmpdir({ git: true })
    const created = await Project.fromDirectory(first.path)
    const headers = {
      "x-openscience-project": created.project.id,
    }

    const repo = await fetch(
      `http://openscience.internal/api/repo/status?directory=${encodeURIComponent(second.path)}`,
      { headers },
    )
    const atlas = await fetch(
      `http://openscience.internal/api/atlas/project?directory=${encodeURIComponent(second.path)}`,
      { headers },
    )
    const folder = await fetch("http://openscience.internal/api/resolve-folder/validate", {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
      },
      body: JSON.stringify({ path: second.path }),
    })
    const staged = await fetch("http://openscience.internal/api/atlas/nodes", {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        title: "must not stage",
        parent_id: "parent-1",
        directory: second.path,
      }),
    })

    for (const response of [repo, atlas, folder, staged]) {
      expect(response.status).toBe(409)
      expect(await response.json()).toEqual({
        name: "ProjectMismatchError",
        data: {
          projectID: created.project.id,
          directory: second.path,
        },
      })
    }
  })

  test("canonicalizes a symlink override before repository execution", async () => {
    await using tmp = await tmpdir({ git: true })
    const created = await Project.fromDirectory(tmp.path)
    const link = path.join(path.dirname(tmp.path), `${path.basename(tmp.path)}-route-alias`)
    await fs.symlink(tmp.path, link)

    const response = await fetch(`http://openscience.internal/api/repo/status?directory=${encodeURIComponent(link)}`, {
      headers: {
        "x-openscience-project": created.project.id,
      },
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      directory: tmp.path,
      isGit: true,
    })

    await fs.rm(link, { force: true })
  })

  test("preserves raw-directory clients and encoded deep links without a selector", async () => {
    await using tmp = await tmpdir({ git: true })
    const link = path.join(path.dirname(tmp.path), `${path.basename(tmp.path)}-legacy-alias`)
    await fs.symlink(tmp.path, link)

    const repo = await fetch(`http://openscience.internal/api/repo/status?directory=${encodeURIComponent(tmp.path)}`)
    const folder = await fetch("http://openscience.internal/api/resolve-folder/validate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ path: link }),
    })

    expect(repo.status).toBe(200)
    expect(await repo.json()).toMatchObject({
      directory: tmp.path,
      isGit: true,
    })
    expect(folder.status).toBe(200)
    expect(await folder.json()).toMatchObject({
      ok: true,
      absolute: tmp.path,
    })

    await fs.rm(link, { force: true })
  })

  test("accepts a migrated legacy project id as an opaque selector", async () => {
    await using tmp = await tmpdir({ git: true })
    const legacyID = `ng-route-${crypto.randomUUID()}`
    await Storage.write(["project", legacyID], {
      id: legacyID,
      worktree: tmp.path,
      sandboxes: [],
      time: {
        created: 1,
        updated: 1,
      },
    })
    const created = await Project.fromDirectory(tmp.path)

    const response = await fetch("http://openscience.internal/api/repo/status", {
      headers: {
        "x-openscience-project": legacyID,
      },
    })

    expect(created.project.id).not.toBe(legacyID)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({
      directory: tmp.path,
      isGit: true,
    })
  })

  // A stale deep link decodes into junk that is neither absolute nor a real
  // folder. Registering a project for it put a phantom entry on the home list.
  test("refuses to register a project for a directory that does not exist", async () => {
    const missing = path.join(os.tmpdir(), `openscience-missing-${crypto.randomUUID()}`)
    const before = await Project.list()

    const response = await fetch("http://openscience.internal/project/current", {
      headers: {
        "x-openscience-directory": missing,
      },
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      name: "ProjectDirectoryError",
      data: {
        directory: missing,
      },
    })
    expect(await Project.list()).toHaveLength(before.length)
  })

  // Resolving one against the server's cwd silently opened whatever folder
  // happened to sit next to it, so a relative selector is never honoured.
  test("refuses a directory selector that is not absolute", async () => {
    const response = await fetch("http://openscience.internal/project/current", {
      headers: {
        "x-openscience-directory": "codes",
      },
    })

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      name: "ProjectDirectoryError",
      data: {
        directory: "codes",
      },
    })
  })

  test("accepts body project selection for repository mutations", async () => {
    await using tmp = await tmpdir({ git: true })
    const created = await Project.fromDirectory(tmp.path)
    await Bun.write(path.join(tmp.path, "result.txt"), "done\n")

    const response = await fetch("http://openscience.internal/api/repo/commit", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        projectID: created.project.id,
        message: "record result",
      }),
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ committed: true })
    expect((await $`git log -1 --format=%s`.cwd(tmp.path).quiet().text()).trim()).toBe("record result")
  })
})

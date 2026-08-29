import { describe, expect, setDefaultTimeout, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { Project } from "../../src/project/project"
import { Server } from "../../src/server/server"
import { Storage } from "../../src/storage/storage"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })
// These integration cases cross the durable authority boundary and run real
// repository probes. They complete in a few seconds in isolation, but can
// legitimately queue behind other native lifecycle tests when Bun executes the
// full backend suite concurrently.
setDefaultTimeout(30_000)

const fetch = Server.internalFetch()

async function pin(directory: string, projectId: string) {
  await fs.mkdir(path.join(directory, ".openscience"), { recursive: true })
  await Bun.write(path.join(directory, ".openscience", "project.json"), JSON.stringify({ project_id: projectId }))
}

describe("pre-instance project selection routes", () => {
  test("uses an opaque selector without a caller-owned directory", async () => {
    await using tmp = await tmpdir({ git: true })
    const created = await Project.fromDirectory(tmp.path)
    await pin(tmp.path, "atlas-root")

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
      `http://openscience.internal/api/atlas/project?directory=${encodeURIComponent(tmp.path)}`,
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

  test("fails a deep session route closed when its recorded project folder is gone", async () => {
    await using tmp = await tmpdir()
    const created = await Project.fromDirectory(tmp.path)
    await fs.rm(tmp.path, { recursive: true, force: true })

    const response = await fetch("http://openscience.internal/session/ses_stale_deep_link", {
      headers: {
        "x-openscience-project": created.project.id,
      },
    })

    expect(response.status).toBe(410)
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(await response.json()).toEqual({
      name: "ProjectStaleError",
      data: {
        projectID: created.project.id,
        reason: "missing_directory",
        directory: tmp.path,
      },
    })
    expect(await Bun.file(tmp.path).exists()).toBe(false)
    expect((await Project.list()).find((project) => project.id === created.project.id)?.worktree).toBe(tmp.path)
  })

  test("rejects mismatched raw directory overrides on every local pre-instance route", async () => {
    await using first = await tmpdir({ git: true })
    await using second = await tmpdir({ git: true })
    const created = await Project.fromDirectory(first.path)
    const headers = {
      "x-openscience-project": created.project.id,
    }

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

    for (const response of [atlas, folder, staged]) {
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

  test("canonicalizes a symlink override before project resolution", async () => {
    await using tmp = await tmpdir({ git: true })
    const created = await Project.fromDirectory(tmp.path)
    await pin(tmp.path, "atlas-root")
    const link = path.join(path.dirname(tmp.path), `${path.basename(tmp.path)}-route-alias`)
    await fs.symlink(tmp.path, link)

    const response = await fetch(
      `http://openscience.internal/api/atlas/project?directory=${encodeURIComponent(link)}`,
      {
        headers: {
          "x-openscience-project": created.project.id,
        },
      },
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ project_id: "atlas-root" })

    await fs.rm(link, { force: true })
  })

  test("keeps folder discovery compatible for raw legacy paths", async () => {
    await using tmp = await tmpdir({ git: true })
    const link = path.join(path.dirname(tmp.path), `${path.basename(tmp.path)}-legacy-alias`)
    await fs.symlink(tmp.path, link)

    const folder = await fetch("http://openscience.internal/api/resolve-folder/validate", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ path: link }),
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
    await pin(tmp.path, "atlas-root")

    const response = await fetch("http://openscience.internal/api/atlas/project", {
      headers: {
        "x-openscience-project": legacyID,
      },
    })

    expect(created.project.id).not.toBe(legacyID)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ project_id: "atlas-root" })
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

  test("accepts body project selection for staged mutations", async () => {
    await using tmp = await tmpdir({ git: true })
    const created = await Project.fromDirectory(tmp.path)

    // Selection succeeds from the body's opaque project id alone; with no
    // Synthetic Sciences session in the isolated test environment the request
    // then stops at authentication — proving the selector resolved (an unknown
    // or mismatched selection would answer 404/409 instead).
    const response = await fetch("http://openscience.internal/api/atlas/nodes", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        projectID: created.project.id,
        title: "staged from body selection",
        parent_id: "parent-1",
      }),
    })

    expect(response.status).toBe(401)
    expect(await response.json()).toEqual({
      detail: "Sign in to Synthetic Sciences before changing the graph.",
    })
  })
})

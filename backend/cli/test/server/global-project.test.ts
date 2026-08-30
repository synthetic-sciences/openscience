import { afterEach, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Global } from "../../src/global"
import { ManagedProject } from "../../src/project/managed"
import { Project } from "../../src/project/project"
import { GlobalRoutes } from "../../src/server/routes/global"
import { Storage } from "../../src/storage/storage"

const created: Project.Info[] = []
const operations: string[] = []

afterEach(async () => {
  const projects = created.splice(0)
  await Promise.all(
    projects.map(async (project) => {
      await Storage.remove(["managed_project", project.id]).catch(() => undefined)
      await Storage.remove(["project", project.id]).catch(() => undefined)
      await Storage.remove(["project_filesystem", project.id]).catch(() => undefined)
      await fs.rm(project.worktree, { recursive: true, force: true })
    }),
  )
  await Promise.all(
    operations
      .splice(0)
      .map((operationID) => Storage.remove(["managed_project_operation", operationID]).catch(() => undefined)),
  )
})

async function create(body: unknown) {
  return GlobalRoutes().request("/project", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("global.project.create", () => {
  test("creates a named project under an opaque server-owned root", async () => {
    const response = await create({ name: "  Protein   folding  " })

    expect(response.status).toBe(201)
    const project = Project.Info.parse(await response.json())
    created.push(project)

    expect(project.id).toStartWith("prj_")
    expect(project.name).toBe("Protein folding")
    expect(project.origin).toBe("openscience")
    expect(path.dirname(project.worktree)).toBe(await fs.realpath(path.join(Global.Path.data, "projects")))
    expect(path.basename(project.worktree)).not.toContain("Protein")
    expect((await fs.stat(project.worktree)).isDirectory()).toBe(true)
    expect(ManagedProject.Info.parse(await Storage.read(["managed_project", project.id]))).toEqual({
      version: 1,
      projectID: project.id,
      directory: await fs.realpath(project.worktree),
      time: {
        created: expect.any(Number),
      },
    })
  })

  test("keeps repeated display names as distinct projects", async () => {
    const first = Project.Info.parse(await (await create({ name: "Cell atlas" })).json())
    const second = Project.Info.parse(await (await create({ name: "Cell atlas" })).json())
    created.push(first, second)

    expect(second.id).not.toBe(first.id)
    expect(second.worktree).not.toBe(first.worktree)
    expect(second.name).toBe(first.name)
  })

  test("replays a stable operation without creating a duplicate project", async () => {
    const operationID = crypto.randomUUID()
    operations.push(operationID)
    const body = { name: "Retry-safe atlas", operation_id: operationID }

    const firstResponse = await create(body)
    const secondResponse = await create(body)
    const first = Project.Info.parse(await firstResponse.json())
    const second = Project.Info.parse(await secondResponse.json())
    created.push(first)

    expect(firstResponse.status).toBe(201)
    expect(secondResponse.status).toBe(200)
    expect(second).toEqual(first)
    expect(ManagedProject.Operation.parse(await Storage.read(["managed_project_operation", operationID]))).toEqual({
      version: 1,
      operationID,
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/u),
      state: "complete",
      projectID: first.id,
      project: first,
      time: {
        created: expect.any(Number),
        completed: expect.any(Number),
      },
    })
    const matching = await Promise.all(
      (await Storage.list(["project"])).map((key) => Storage.read<Project.Info>(key).catch(() => undefined)),
    )
    expect(matching.filter((project) => project?.worktree === first.worktree)).toHaveLength(1)
  })

  test("serializes concurrent retries of the same operation", async () => {
    const operationID = crypto.randomUUID()
    operations.push(operationID)
    const responses = await Promise.all([
      create({ name: "Concurrent atlas", operation_id: operationID }),
      create({ name: "Concurrent atlas", operation_id: operationID }),
    ])
    const projects = await Promise.all(responses.map(async (response) => Project.Info.parse(await response.json())))
    created.push(projects[0]!)

    expect(responses.map((response) => response.status).toSorted()).toEqual([200, 201])
    expect(new Set(projects.map((project) => project.id))).toEqual(new Set([projects[0]!.id]))
  })

  test("rejects reusing an operation id for a different project draft", async () => {
    const operationID = crypto.randomUUID()
    operations.push(operationID)
    const firstResponse = await create({ name: "Folder project", operation_id: operationID })
    const first = Project.Info.parse(await firstResponse.json())
    created.push(first)

    const conflict = await create({ name: "Blank project", operation_id: operationID })

    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toEqual({
      error: "project_operation_conflict",
      message: "This project operation is already bound to a different workspace choice.",
    })
    expect(
      Project.Info.parse(await (await create({ name: "Folder project", operation_id: operationID })).json()).id,
    ).toBe(first.id)
  })

  test("retains the exact draft binding while recovering an interrupted pending operation", async () => {
    const operationID = crypto.randomUUID()
    operations.push(operationID)
    const fingerprint = "a".repeat(64)
    let interrupted: Project.Info | undefined

    const failure = await ManagedProject.createIdempotent({
      operationID,
      fingerprint,
      name: "Recover pending",
      checkpoint: async (project) => {
        interrupted = project
        throw new Error("simulated interruption")
      },
    }).catch((error) => error as Error)

    expect(failure).toBeInstanceOf(Error)
    if (!(failure instanceof Error)) throw new Error("Expected the interrupted operation to fail")
    expect(failure.message).toBe("simulated interruption")
    expect(interrupted).toBeDefined()
    expect(await Bun.file(interrupted!.worktree).exists()).toBe(false)
    expect(
      ManagedProject.Operation.parse(await Storage.read(["managed_project_operation", operationID])),
    ).toMatchObject({
      state: "pending",
      fingerprint,
    })
    expect(
      await ManagedProject.createIdempotent({
        operationID,
        fingerprint: "b".repeat(64),
        name: "Different draft",
      }),
    ).toEqual({ status: "conflict" })

    const recovered = await ManagedProject.createIdempotent({
      operationID,
      fingerprint,
      name: "Recover pending",
    })
    expect(recovered.status).toBe("created")
    if (recovered.status === "conflict") throw new Error("Expected the bound draft to recover")
    created.push(recovered.project)
    expect(recovered.project.id).not.toBe(interrupted!.id)
    await expect(Storage.read(["project", interrupted!.id])).rejects.toBeInstanceOf(Storage.NotFoundError)
  })

  test("attaches explicitly selected source folders as durable project access", async () => {
    const source = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-project-source-"))
    const response = await create({
      name: "Cell atlas",
      sources: [{ path: source, access: "write" }],
    })
    const project = Project.Info.parse(await response.json())
    created.push(project)

    expect(response.status).toBe(201)
    expect(await Storage.read(["project_filesystem", project.id])).toMatchObject({
      version: 1,
      projectID: project.id,
      grants: [
        {
          path: await fs.realpath(source),
          access: "write",
          scope: "project",
          source: "api",
        },
      ],
    })
    await fs.rm(source, { recursive: true, force: true })
  })

  test("rejects unsafe names and client-selected host paths", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "openscience-project-create-"))
    const bodies = [
      { name: "   " },
      { name: "../outside" },
      { name: "unsafe\u0000name" },
      { name: "Imported", directory: outside },
    ]

    const responses = await Promise.all(bodies.map(create))

    expect(responses.map((response) => response.status)).toEqual([400, 400, 400, 400])
    expect(await fs.readdir(outside)).toEqual([])
    await fs.rm(outside, { recursive: true, force: true })
  })

  test("rolls back the marker, project record, and exact directory when creation fails", async () => {
    const before = new Set(await fs.readdir(path.join(Global.Path.data, "projects")).catch(() => []))
    const failure = await ManagedProject.create("Rollback checkpoint", async (created) => {
      throw Object.assign(new Error("checkpoint failed"), { project: created })
    })
      .then(() => {
        throw new Error("Expected managed project creation to fail")
      })
      .catch((error) => error as Error & { project: Project.Info })
    const project = failure.project

    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toBe("checkpoint failed")
    expect(project.id).toStartWith("prj_")
    expect(await Bun.file(project.worktree).exists()).toBe(false)
    await expect(Storage.read(["project", project.id])).rejects.toBeInstanceOf(Storage.NotFoundError)
    await expect(Storage.read(["managed_project", project.id])).rejects.toBeInstanceOf(Storage.NotFoundError)
    const after = new Set(await fs.readdir(path.join(Global.Path.data, "projects")).catch(() => []))
    expect(after).toEqual(before)
  })
})

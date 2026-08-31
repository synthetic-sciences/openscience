import { describe, expect, test } from "bun:test"
import { Project } from "../../src/project/project"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Storage } from "../../src/storage/storage"
import { Identifier } from "../../src/id/id"
import { Server } from "../../src/server/server"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { Bus } from "../../src/bus"
import { File } from "../../src/file"
import { FileWatcher } from "../../src/file/watcher"
import { tmpdir } from "../fixture/fixture"

describe("project activity", () => {
  test("backfills from historical session metadata, never project refresh time, and freezes the result", async () => {
    await using tmp = await tmpdir()
    const project = (await Project.fromDirectory(tmp.path)).project
    expect(project.time.activity).toBe(project.time.created)
    expect(project.time.updated).toBe(project.time.created)
    await Storage.update<Project.Info>(["project", project.id], (draft) => {
      draft.time = { created: 100, updated: Date.now() }
    })
    await Storage.write(["session", project.id, "ses_activity_history"], {
      projectID: project.id,
      time: { created: 150, updated: 200 },
    })
    await Storage.write(["session", project.id, "ses_activity_foreign"], {
      projectID: "prj_other",
      time: { created: 250, updated: 300 },
    })
    await Storage.write(["session", project.id, "ses_activity_invalid"], {
      projectID: project.id,
      time: { created: -1, updated: Date.now() + 60_000 },
    })
    const before = await Storage.read<Project.Info>(["project", project.id])
    const migrated = await Project.get(project.id)
    expect(migrated.time.activity).toBe(200)
    expect(migrated.time.updated).toBe(before.time.updated)
    expect(migrated.origin).toBe(before.origin)
    await Storage.write(["session", project.id, "ses_activity_history"], {
      projectID: project.id,
      time: { created: 150, updated: 400 },
    })
    expect((await Project.get(project.id)).time.activity).toBe(200)
  })

  test("empty legacy projects fall back to creation, not the most recent metadata update", async () => {
    await using tmp = await tmpdir()
    const project = (await Project.fromDirectory(tmp.path)).project
    await Storage.update<Project.Info>(["project", project.id], (draft) => {
      draft.time = { created: 100, updated: Date.now() }
    })
    expect((await Project.get(project.id)).time.activity).toBe(100)
  })

  test("directory reads and automatic metadata updates do not change activity", async () => {
    await using tmp = await tmpdir()
    const project = (await Project.fromDirectory(tmp.path)).project
    await Storage.update<Project.Info>(["project", project.id], (draft) => {
      draft.time = { created: 100, updated: 200, activity: 150 }
    })
    const reopened = await Project.fromDirectory(tmp.path)
    expect(reopened.project.time).toEqual({ created: 100, updated: 200, activity: 150 })
    await Instance.provide({ directory: tmp.path, fn: () => undefined })
    expect((await Project.get(project.id)).time.activity).toBe(150)
    const updated = await Project.update({ projectID: project.id, icon: { color: "blue" } })
    expect(updated.time.updated).toBeGreaterThan(200)
    expect(updated.time.activity).toBe(150)
    await Project.list()
    expect((await Project.get(project.id)).time.activity).toBe(150)
  })

  test("session actions and completed work advance activity while current-project reads stay fresh", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const projectID = Instance.project.id
        await Storage.update<Project.Info>(["project", projectID], (draft) => {
          draft.time.activity = 1
        })
        const session = await Session.create({ title: "Real user session" })
        expect((await Project.get(projectID)).time.activity).toBeGreaterThan(1)
        await Storage.update<Project.Info>(["project", projectID], (draft) => {
          draft.time.activity = 1
        })
        await Session.touch(session.id)
        expect((await Project.get(projectID)).time.activity).toBeGreaterThan(1)
        await Storage.update<Project.Info>(["project", projectID], (draft) => {
          draft.time.activity = 100
        })
        const assistant = {
          id: Identifier.ascending("message"),
          sessionID: session.id,
          parentID: Identifier.ascending("message"),
          role: "assistant" as const,
          modelID: "fixture",
          providerID: "fixture",
          mode: "research",
          agent: "research",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: 150, completed: 200 },
          finish: "stop",
        }
        await Session.updateMessage(assistant)
        expect((await Project.get(projectID)).time.activity).toBe(200)
        await Session.updateMessage({ ...assistant, summary: true, time: { created: 200, completed: 300 } })
        expect((await Project.get(projectID)).time.activity).toBe(200)
        await Session.updateMessage({ ...assistant, time: { created: 150, completed: 175 } })
        expect((await Project.get(projectID)).time.activity).toBe(200)
        const current = await Server.internalFetch()("http://openscience.internal/project/current", {
          headers: { "x-openscience-project": projectID },
        })
        expect(current.status).toBe(200)
        expect((await current.json()).time.activity).toBe(200)
      },
    })
  })

  test("activity is monotonic across concurrent updates and ignores invalid timestamps", async () => {
    await using tmp = await tmpdir()
    const project = (await Project.fromDirectory(tmp.path)).project
    await Storage.update<Project.Info>(["project", project.id], (draft) => {
      draft.time = { created: 1, updated: 2, activity: 3 }
    })
    await Promise.all([100, 300, 200].map((at) => Project.touchActivity(project.id, at)))
    await Project.touchActivity(project.id, -1)
    await Project.touchActivity(project.id, Number.POSITIVE_INFINITY)
    await Project.touchActivity(project.id, Date.now() + 60_000)
    expect((await Project.get(project.id)).time).toEqual({ created: 1, updated: 2, activity: 300 })
  })

  test("successful tool edit events advance only their project, not filesystem watcher notifications", async () => {
    await using first = await tmpdir()
    await using second = await tmpdir()
    const other = (await Project.fromDirectory(second.path)).project
    await Storage.update<Project.Info>(["project", other.id], (draft) => {
      draft.time.activity = 1
    })
    await Instance.provide({
      directory: first.path,
      init: InstanceBootstrap,
      fn: async () => {
        const projectID = Instance.project.id
        await Storage.update<Project.Info>(["project", projectID], (draft) => {
          draft.time.activity = 1
        })
        await Bus.publish(FileWatcher.Event.Updated, { file: `${first.path}/notes.md`, event: "change" })
        expect((await Project.get(projectID)).time.activity).toBe(1)
        await Bus.publish(File.Event.Edited, { file: `${first.path}/notes.md` })
        expect((await Project.get(projectID)).time.activity).toBeGreaterThan(1)
        expect((await Project.get(other.id)).time.activity).toBe(1)
        await Instance.dispose()
      },
    })
  })
})

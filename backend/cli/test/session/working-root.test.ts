import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { ExecutionAuthority } from "../../src/project/execution"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { SystemPrompt } from "../../src/session/system"
import { WriteTool } from "../../src/tool/write"
import type { PermissionNext } from "../../src/permission/next"
import { tmpdir, trustProject } from "../fixture/fixture"

const ctx = (sessionID: string) => ({
  sessionID,
  messageID: "msg_working_root",
  callID: "call_working_root",
  agent: "research",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: async () => {},
  ask: async (_request: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {},
})

describe("session working root", () => {
  test("a project with no connected folder works in scratch", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const scratch = await SessionFilesystem.workspace(session.id)
        expect(await SessionFilesystem.toolDirectory(session.id)).toBe(scratch)
        expect((await SessionFilesystem.snapshot(session.id)).toolDirectory).toBe(scratch)
      },
    })
  })

  test("the single connected read/write folder becomes the working directory, scratch stays for side outputs", async () => {
    await using folder = await tmpdir()
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const session = await Session.create({})
        await SessionFilesystem.grant({ sessionID: session.id, path: folder.path, access: "write", scope: "project" })
        const scratch = await SessionFilesystem.workspace(session.id)
        expect(await SessionFilesystem.toolDirectory(session.id)).toBe(folder.path)
        expect(scratch).not.toBe(folder.path)

        // Relative writes land in the user's folder; nothing appears in scratch.
        await (await WriteTool.init()).execute({ filePath: "notes.md", content: "kept\n" }, ctx(session.id))
        expect(await Bun.file(path.join(folder.path, "notes.md")).text()).toBe("kept\n")
        expect(await Bun.file(path.join(scratch, "notes.md")).exists()).toBe(false)

        // Process authority: cwd is the folder, caches keep going to scratch.
        const authority = await ExecutionAuthority.require({
          projectID: Instance.project.id,
          sessionID: session.id,
          capability: "shell",
        })
        expect(authority.workspace).toBe(folder.path)
        expect(authority.scratch).toBe(scratch)

        // The model is told which is which.
        const environment = (await SystemPrompt.environment({ api: { id: "m" }, providerID: "p" }, session.id)).join(
          "\n",
        )
        expect(environment).toContain(`Working folder: ${folder.path}`)
        expect(environment).toContain(`Session scratch: ${scratch}`)

        // A later session in the same project inherits the folder automatically.
        const later = await Session.create({})
        expect(await SessionFilesystem.toolDirectory(later.id)).toBe(folder.path)
      },
    })
  })

  test("several connected folders: the newest wins until the user pins one, and scratch can be pinned", async () => {
    await using first = await tmpdir()
    await using second = await tmpdir()
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await SessionFilesystem.grant({ sessionID: session.id, path: first.path, access: "write", scope: "project" })
        await Bun.sleep(2)
        await SessionFilesystem.grant({ sessionID: session.id, path: second.path, access: "write", scope: "project" })
        expect(await SessionFilesystem.toolDirectory(session.id)).toBe(second.path)

        await SessionFilesystem.setWorkingRoot(session.id, first.path)
        expect(await SessionFilesystem.toolDirectory(session.id)).toBe(first.path)

        const pinned = await SessionFilesystem.setWorkingRoot(session.id, "scratch")
        expect(pinned.toolDirectory).toBe(await SessionFilesystem.workspace(session.id))
        expect(pinned.workingRoot).toBe("scratch")

        const automatic = await SessionFilesystem.setWorkingRoot(session.id, null)
        expect(automatic.workingRoot).toBeUndefined()
        expect(automatic.toolDirectory).toBe(second.path)

        // Only an active connected folder can be the working root.
        await using elsewhere = await tmpdir()
        await expect(SessionFilesystem.setWorkingRoot(session.id, elsewhere.path)).rejects.toBeInstanceOf(
          SessionFilesystem.DeniedError,
        )

        // A pinned folder that loses its grant falls back to scratch, never to
        // another folder the user did not choose.
        await SessionFilesystem.setWorkingRoot(session.id, first.path)
        const grant = (await SessionFilesystem.list(session.id)).find((item) => item.path === first.path)!
        await SessionFilesystem.revoke(session.id, grant.id)
        expect(await SessionFilesystem.toolDirectory(session.id)).toBe(await SessionFilesystem.workspace(session.id))
      },
    })
  })

  test("a session can be created already pinned to scratch, and the project lists its roots", async () => {
    await using folder = await tmpdir()
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const seed = await Session.create({})
        await SessionFilesystem.grant({ sessionID: seed.id, path: folder.path, access: "write", scope: "project" })
        expect((await SessionFilesystem.projectWorkingRoots()).map((grant) => grant.path)).toEqual([folder.path])

        const aside = await Session.create({ workingRoot: "scratch" })
        expect(await SessionFilesystem.toolDirectory(aside.id)).toBe(await SessionFilesystem.workspace(aside.id))
      },
    })
  })
})

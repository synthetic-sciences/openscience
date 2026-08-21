import { afterAll, describe, expect, test } from "bun:test"
import crypto from "crypto"
import fs from "fs/promises"
import path from "path"
import { File } from "../../src/file"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { KernelRuntime, type KernelIdentity } from "../../src/science/kernel/registry"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { SessionWorkspace } from "../../src/session/workspace"
import { Storage } from "../../src/storage/storage"
import { BashTool } from "../../src/tool/bash"
import { NotebookTool as BiologyNotebookTool, shutdownBiologyKernels } from "../../src/tool/biology/notebook"
import { assertExternalDirectory } from "../../src/tool/external-directory"
import "../../src/tool/notebook"
import "../../src/tool/rkernel"
import { tmpdir, trustProject } from "../fixture/fixture"

async function managed<T>(fn: (root: string) => Promise<T>) {
  const directory = path.join(Global.Path.data, "projects", crypto.randomUUID())
  await fs.mkdir(directory, { recursive: true })
  const root = await fs.realpath(directory)
  const state = { projectID: "" }
  try {
    return await Instance.provide({
      directory: root,
      fn: async () => {
        state.projectID = Instance.project.id
        await trustProject()
        try {
          return await fn(root)
        } finally {
          const sessions = []
          for await (const session of Session.list()) sessions.push(session.id)
          await Promise.all(sessions.map((sessionID) => Session.remove(sessionID)))
          await Instance.dispose()
        }
      },
    })
  } finally {
    if (state.projectID) {
      await Storage.remove(["project_filesystem", state.projectID]).catch(() => undefined)
      await Storage.remove(["project", state.projectID]).catch(() => undefined)
    }
    await fs.rm(root, { recursive: true, force: true })
  }
}

const context = (sessionID: string) => ({
  sessionID,
  messageID: "",
  callID: "",
  agent: "research",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
})

describe("managed project session scratch", () => {
  test("lets brokered file tools use the managed project directory without a redundant grant", async () => {
    await managed(async (root) => {
      const session = await Session.create({ title: "managed source" })
      const file = path.join(root, "source.ts")
      await Bun.write(file, "export const value = 1\n")

      const authorized = await assertExternalDirectory(context(session.id), file)

      expect(authorized?.path).toBe(await fs.realpath(file))
    })
  })

  test("creates separate durable roots without changing project binding", async () => {
    await managed(async (root) => {
      const first = await Session.create({ title: "first" })
      const second = await Session.create({ title: "second" })
      const base = await fs.realpath(SessionWorkspace.root())
      const firstRoot = path.join(base, first.id)
      const secondRoot = path.join(base, second.id)

      expect(first.directory).toBe(root)
      expect(second.directory).toBe(root)
      expect(await SessionFilesystem.workspace(first.id)).toBe(firstRoot)
      expect(await SessionFilesystem.workspace(second.id)).toBe(secondRoot)
      expect((await fs.stat(firstRoot)).isDirectory()).toBe(true)
      expect((await fs.stat(secondRoot)).isDirectory()).toBe(true)
      expect(await SessionFilesystem.processWriteRoots(first.id)).toEqual([firstRoot])
      expect(await SessionFilesystem.snapshot(first.id)).toMatchObject({
        directory: root,
        workspace: {
          projectID: Instance.project.id,
          sessionID: first.id,
          scratchRoot: firstRoot,
          mode: "isolated",
          state: "active",
        },
      })

      await File.write("result.csv", "sample,value\nfirst,1\n", { sessionID: first.id })
      await File.write("result.csv", "sample,value\nsecond,2\n", { sessionID: second.id })
      expect(await Bun.file(path.join(firstRoot, "result.csv")).text()).toContain("first,1")
      expect(await Bun.file(path.join(secondRoot, "result.csv")).text()).toContain("second,2")
      expect((await File.list(firstRoot, { sessionID: first.id }))[0]?.path).toBe("result.csv")
      expect((await File.artifacts({ sessionID: first.id })).map((artifact) => artifact.path)).toEqual(["result.csv"])

      await SessionFilesystem.grant({
        sessionID: first.id,
        path: root,
        access: "read",
        scope: "project",
      })
      expect(await SessionFilesystem.processWriteRoots(first.id)).toEqual([firstRoot])
      await expect(File.read(path.join(firstRoot, "result.csv"), { sessionID: second.id })).rejects.toBeInstanceOf(
        SessionFilesystem.DeniedError,
      )
      await expect(
        SessionFilesystem.grant({
          sessionID: second.id,
          path: firstRoot,
          access: "read",
          scope: "session",
        }),
      ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
    })
  })

  test("deletes only the removed session's managed scratch directory", async () => {
    const external = await fs.mkdtemp(path.join(Global.Path.data, "managed-scratch-connected-"))
    try {
      await managed(async () => {
        const first = await Session.create({ title: "first" })
        const second = await Session.create({ title: "second" })
        const firstRoot = await SessionFilesystem.workspace(first.id)
        const secondRoot = await SessionFilesystem.workspace(second.id)
        await File.write("temporary.txt", "temporary", { sessionID: first.id })
        await SessionFilesystem.grant({
          sessionID: first.id,
          path: external,
          access: "write",
          scope: "project",
        })

        await Session.remove(first.id)

        expect(await Bun.file(firstRoot).exists()).toBe(false)
        expect((await fs.stat(secondRoot)).isDirectory()).toBe(true)
        expect((await fs.stat(external)).isDirectory()).toBe(true)
        const workspace = await SessionWorkspace.get(first.id)
        expect(workspace).toMatchObject({
          sessionID: first.id,
          scratchRoot: firstRoot,
          mode: "isolated",
          state: "trash",
          size: 9,
        })
        expect(workspace.trashRoot).toBeString()
        expect(await Bun.file(path.join(workspace.trashRoot!, "temporary.txt")).text()).toBe("temporary")
      })
    } finally {
      await fs.rm(external, { recursive: true, force: true })
    }
  })

  test("gives imported-folder sessions isolated scratch while keeping the project as working data", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const workspace = await SessionFilesystem.workspace(session.id)
        try {
          expect(workspace).not.toBe(tmp.path)
          expect(path.dirname(workspace)).toBe(await fs.realpath(SessionWorkspace.root()))
          expect(await SessionFilesystem.processWriteRoots(session.id)).toContain(tmp.path)
          expect(await SessionFilesystem.processWriteRoots(session.id)).toContain(workspace)
          expect(await Bun.file(path.join(tmp.path, ".openscience", "sessions", session.id)).exists()).toBe(false)
        } finally {
          await Session.remove(session.id)
        }
        expect((await fs.stat(tmp.path)).isDirectory()).toBe(true)
        expect(await Bun.file(workspace).exists()).toBe(false)
      },
    })
  })

  test("restores trashed isolated scratch idempotently without changing its identity", async () => {
    await managed(async () => {
      const session = await Session.create({ title: "restore" })
      const root = await SessionFilesystem.workspace(session.id)
      const before = await SessionWorkspace.get(session.id)
      await File.write("recover.txt", "recoverable", { sessionID: session.id })

      const trashed = await SessionWorkspace.trash(session.id)
      expect(trashed.state).toBe("trash")
      expect(await Bun.file(root).exists()).toBe(false)
      expect(await SessionWorkspace.trash(session.id)).toEqual(trashed)

      const restored = await SessionWorkspace.restore(session.id)
      expect(restored).toMatchObject({
        workspaceID: before.workspaceID,
        scratchRoot: root,
        state: "active",
      })
      expect(await Bun.file(path.join(root, "recover.txt")).text()).toBe("recoverable")
      expect(await SessionWorkspace.restore(session.id)).toEqual(restored)
    })
  })

  test("reusing a deleted session id starts with fresh scratch and retains the prior recovery copy", async () => {
    await managed(async (root) => {
      const session = await Session.create({ title: "original" })
      const scratch = await SessionFilesystem.workspace(session.id)
      const before = await SessionWorkspace.get(session.id)
      await File.write("old-draft.txt", "recoverable", { sessionID: session.id })

      await Session.remove(session.id)
      const deleted = await SessionWorkspace.get(session.id)
      expect(deleted).toMatchObject({ workspaceID: before.workspaceID, state: "trash" })

      const replacement = await Session.createNext({ id: session.id, directory: root, title: "replacement" })
      const active = await SessionWorkspace.get(replacement.id)
      expect(active).toMatchObject({ sessionID: session.id, scratchRoot: scratch, state: "active" })
      expect(active.workspaceID).not.toBe(before.workspaceID)
      expect((await fs.stat(scratch)).isDirectory()).toBe(true)
      expect(await Bun.file(path.join(scratch, "old-draft.txt")).exists()).toBe(false)

      const recovery = await SessionWorkspace.listTrash(session.id)
      expect(recovery).toContainEqual(expect.objectContaining({ workspaceID: before.workspaceID, state: "trash" }))
      expect(await Bun.file(path.join(deleted.trashRoot!, "old-draft.txt")).text()).toBe("recoverable")

      await Session.remove(replacement.id)
    })
  })

  test("lazily restores a durable workspace record for pre-record sessions", async () => {
    await managed(async () => {
      const session = await Session.create({ title: "migration" })
      const root = await SessionFilesystem.workspace(session.id)
      await Storage.remove(["session_workspace", Instance.project.id, session.id])

      const snapshot = await SessionFilesystem.snapshot(session.id)
      expect(snapshot.workspace).toMatchObject({
        projectID: Instance.project.id,
        sessionID: session.id,
        scratchRoot: root,
        mode: "isolated",
        state: "active",
      })
      expect(snapshot.workspace.workspaceID).toStartWith("wsp_")
    })
  })

  test("purges only isolated workspace trash older than seven days", async () => {
    await managed(async () => {
      const session = await Session.create({ title: "purge" })
      const root = await SessionFilesystem.workspace(session.id)
      await File.write("expired.txt", "expired", { sessionID: session.id })
      await Session.remove(session.id)
      const trashed = await SessionWorkspace.get(session.id)
      const now = Date.now()
      await Storage.update<SessionWorkspace.Info>(["session_workspace", Instance.project.id, session.id], (draft) => {
        draft.trashedAt = now - 8 * 24 * 60 * 60 * 1000
      })

      await SessionWorkspace.sweep(now)

      await expect(SessionWorkspace.get(session.id)).rejects.toBeInstanceOf(Storage.NotFoundError)
      expect(await Bun.file(root).exists()).toBe(false)
      expect(await Bun.file(trashed.trashRoot!).exists()).toBe(false)
    })
  })

  test("defaults Bash and Python, R, and biology kernels to the owning scratch root", async () => {
    await managed(async (root) => {
      const first = await Session.create({ title: "first" })
      const second = await Session.create({ title: "second" })
      const firstRoot = await SessionFilesystem.workspace(first.id)
      const secondRoot = await SessionFilesystem.workspace(second.id)
      const bash = await BashTool.init()
      const shell = await bash.execute(
        {
          command: "pwd && printf shell > shell.txt",
          description: "Print and write workspace",
        },
        context(first.id),
      )
      expect(shell.output).toContain(firstRoot)
      expect(await Bun.file(path.join(firstRoot, "shell.txt")).text()).toBe("shell")
      await expect(
        bash.execute(
          {
            command: "pwd",
            workdir: secondRoot,
            description: "Try another workspace",
          },
          context(first.id),
        ),
      ).rejects.toThrow("External write paths must be connected to this project")

      const python: KernelIdentity = {
        projectID: Instance.project.id,
        sessionID: first.id,
        name: "scratch-python",
        language: "python",
      }
      const pythonResult = await KernelRuntime.execute(
        python,
        "import os\nprint(os.getcwd())\nopen('python.txt', 'w').write('python')",
      )
      expect(pythonResult.stdout).toContain(firstRoot)
      expect(KernelRuntime.status(python).environment?.cwd).toBe(firstRoot)
      expect(await Bun.file(path.join(firstRoot, "python.txt")).text()).toBe("python")

      if (Bun.which("Rscript")) {
        const r: KernelIdentity = {
          projectID: Instance.project.id,
          sessionID: first.id,
          name: "scratch-r",
          language: "r",
        }
        const rResult = await KernelRuntime.execute(r, "cat(getwd())")
        expect(rResult.stdout).toContain(firstRoot)
        expect(KernelRuntime.status(r).environment?.cwd).toBe(firstRoot)
      }

      const biology = await BiologyNotebookTool.init()
      const biologyResult = await biology.execute(
        {
          code: "import os\nprint(os.getcwd())\nopen('biology.txt', 'w').write('biology')",
          timeout: 30_000,
        },
        context(second.id),
      )
      expect(biologyResult.output).toContain(secondRoot)
      expect(await Bun.file(path.join(secondRoot, "biology.txt")).text()).toBe("biology")
      expect(await Bun.file(path.join(root, "python.txt")).exists()).toBe(false)
    })
  }, 60_000)

  test("sweep removes only stale orphaned scratch workspaces", async () => {
    await managed(async (root) => {
      const live = await Session.create({ title: "live" })
      const liveRoot = await SessionFilesystem.workspace(live.id)
      expect(liveRoot).toBeTruthy()

      const base = path.dirname(liveRoot!)
      const staleOrphan = path.join(base, "ses_orphan_stale")
      const freshOrphan = path.join(base, "ses_orphan_fresh")
      await fs.mkdir(staleOrphan, { recursive: true })
      await fs.mkdir(freshOrphan, { recursive: true })
      const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
      await fs.utimes(staleOrphan, past, past)

      await SessionFilesystem.sweep()

      // The stale orphan is gone; the fresh orphan and the live session stay.
      expect(
        await fs.stat(staleOrphan).then(
          () => true,
          () => false,
        ),
      ).toBe(false)
      expect(
        await fs.stat(freshOrphan).then(
          () => true,
          () => false,
        ),
      ).toBe(true)
      expect(
        await fs.stat(liveRoot!).then(
          () => true,
          () => false,
        ),
      ).toBe(true)
    })
  })
})

afterAll(() => {
  shutdownBiologyKernels()
})

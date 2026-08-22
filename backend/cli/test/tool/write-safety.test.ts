import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { WriteTool } from "../../src/tool/write"
import { EditTool } from "../../src/tool/edit"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { FileTime } from "../../src/file/time"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import type { Tool } from "../../src/tool/tool"

const base = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "research",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
}

test("write refuses a target swapped to a symlink during approval", async () => {
  if (process.platform === "win32") return
  await using outside = await tmpdir({ init: (dir) => Bun.write(path.join(dir, "secret.txt"), "secret\n") })
  await using tmp = await tmpdir({ init: (dir) => Bun.write(path.join(dir, "target.txt"), "old\n") })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const target = path.join(tmp.path, "target.txt")
      FileTime.read(base.sessionID, target)
      const tool = await WriteTool.init()
      await expect(
        tool.execute(
          { filePath: target, content: "agent\n" },
          {
            ...base,
            ask: async (request) => {
              if (request.permission !== "edit") return
              await fs.unlink(target)
              await fs.symlink(path.join(outside.path, "secret.txt"), target)
            },
          },
        ),
      ).rejects.toThrow("symbolic link")
      expect(await fs.readFile(path.join(outside.path, "secret.txt"), "utf8")).toBe("secret\n")
    },
  })
})

test("write refuses a new target that appears during approval", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const target = path.join(tmp.path, "new.txt")
      const tool = await WriteTool.init()
      await expect(
        tool.execute(
          { filePath: target, content: "agent\n" },
          {
            ...base,
            ask: async (request) => {
              if (request.permission === "edit") await fs.writeFile(target, "concurrent\n")
            },
          },
        ),
      ).rejects.toThrow("unapproved file")
      expect(await fs.readFile(target, "utf8")).toBe("concurrent\n")
    },
  })
})

test("edit refuses content and symlink swaps after approval", async () => {
  if (process.platform === "win32") return
  await using outside = await tmpdir({ init: (dir) => Bun.write(path.join(dir, "secret.txt"), "secret\n") })
  await using tmp = await tmpdir({ init: (dir) => Bun.write(path.join(dir, "target.txt"), "old value\n") })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const target = path.join(tmp.path, "target.txt")
      FileTime.read(base.sessionID, target)
      const tool = await EditTool.init()
      await expect(
        tool.execute(
          { filePath: target, oldString: "old", newString: "new" },
          {
            ...base,
            ask: async (request) => {
              if (request.permission !== "edit") return
              await fs.unlink(target)
              await fs.symlink(path.join(outside.path, "secret.txt"), target)
            },
          },
        ),
      ).rejects.toThrow("symbolic link")
      expect(await fs.readFile(path.join(outside.path, "secret.txt"), "utf8")).toBe("secret\n")

      await fs.unlink(target)
      await fs.writeFile(target, "old value\n")
      FileTime.read(base.sessionID, target)
      await expect(
        tool.execute(
          { filePath: target, oldString: "old", newString: "new" },
          {
            ...base,
            ask: async (request) => {
              if (request.permission === "edit") await fs.writeFile(target, "concurrent value\n")
            },
          },
        ),
      ).rejects.toThrow("changed after approval")
      expect(await fs.readFile(target, "utf8")).toBe("concurrent value\n")
    },
  })
})

test("write and edit stop when external write authority is revoked during approval", async () => {
  await using project = await tmpdir({ git: true })
  await using external = await tmpdir({ init: (directory) => Bun.write(path.join(directory, "target.txt"), "old\n") })
  await Instance.provide({
    directory: project.path,
    fn: async () => {
      const session = await Session.create({ title: "revoked tool writes" })
      try {
        const run = async (execute: (context: Tool.Context) => Promise<unknown>) => {
          const grant = await SessionFilesystem.grant({
            sessionID: session.id,
            path: external.path,
            access: "write",
            scope: "session",
          })
          return execute({
            ...base,
            sessionID: session.id,
            ask: async (request) => {
              if (request.permission === "edit") await SessionFilesystem.revoke(session.id, grant.id)
            },
          })
        }
        const target = path.join(external.path, "target.txt")
        FileTime.read(session.id, target)
        await expect(
          run(async (context) => (await WriteTool.init()).execute({ filePath: target, content: "written\n" }, context)),
        ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
        expect(await Bun.file(target).text()).toBe("old\n")

        FileTime.read(session.id, target)
        await expect(
          run(async (context) =>
            (await EditTool.init()).execute({ filePath: target, oldString: "old", newString: "edited" }, context),
          ),
        ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
        expect(await Bun.file(target).text()).toBe("old\n")
      } finally {
        await Session.remove(session.id)
      }
    },
  })
})

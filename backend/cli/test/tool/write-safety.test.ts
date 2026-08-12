import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { WriteTool } from "../../src/tool/write"
import { EditTool } from "../../src/tool/edit"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { FileTime } from "../../src/file/time"

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

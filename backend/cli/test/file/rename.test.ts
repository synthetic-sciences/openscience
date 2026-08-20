import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { FileRoutes } from "../../src/server/routes/file"
import { Instance } from "../../src/project/instance"
import { executionSession, tmpdir } from "../fixture/fixture"

const rename = (from: string, to: string, sessionID: string) =>
  FileRoutes().request("/file/rename", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ from, to, sessionID }),
  })

describe("workspace rename", () => {
  test("renames files and folders without overwriting", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const source = path.join(tmp.path, "draft.txt")
        const target = path.join(tmp.path, "final.txt")
        await fs.writeFile(source, "result\n")

        const response = await rename(source, target, session.id)
        expect(response.status).toBe(200)
        expect(await response.json()).toMatchObject({ from: source, to: target, type: "file" })
        expect(await fs.readFile(target, "utf8")).toBe("result\n")
        await expect(fs.stat(source)).rejects.toThrow()

        const folder = path.join(tmp.path, "old-folder")
        const renamed = path.join(tmp.path, "new-folder")
        await fs.mkdir(folder)
        expect((await rename(folder, renamed, session.id)).status).toBe(200)
        expect((await fs.stat(renamed)).isDirectory()).toBe(true)
        const nested = await rename(renamed, path.join(renamed, "nested"), session.id)
        expect(nested.status).toBe(409)
        expect((await fs.stat(renamed)).isDirectory()).toBe(true)

        await fs.writeFile(source, "replacement\n")
        const conflict = await rename(source, target, session.id)
        expect(conflict.status).toBe(409)
        expect(await fs.readFile(source, "utf8")).toBe("replacement\n")
        expect(await fs.readFile(target, "utf8")).toBe("result\n")
      },
    })
  })

  test("refuses to rename the workspace root", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const response = await rename(tmp.path, `${tmp.path}-renamed`, session.id)
        expect(response.status).toBe(409)
        expect((await fs.stat(tmp.path)).isDirectory()).toBe(true)
      },
    })
  })
})

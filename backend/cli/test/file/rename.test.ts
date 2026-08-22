import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "node:path"
import { File } from "../../src/file"
import { SafeFileIO } from "../../src/file/safe-io"
import { FileRoutes } from "../../src/server/routes/file"
import { Instance } from "../../src/project/instance"
import { SessionFilesystem } from "../../src/session/filesystem"
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

        const archive = path.join(tmp.path, "archive")
        const pending = path.join(tmp.path, "pending.txt")
        const archived = path.join(archive, "pending.txt")
        await fs.mkdir(archive)
        await fs.writeFile(pending, "cross-parent\n")
        expect((await rename(pending, archived, session.id)).status).toBe(200)
        expect(await fs.readFile(archived, "utf8")).toBe("cross-parent\n")

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

  test.skipIf(process.platform === "win32")("does not follow a parent swapped for an external directory", async () => {
    await using outside = await tmpdir({
      init: (dir) => fs.writeFile(path.join(dir, "sentinel.txt"), "outside\n"),
    })
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const folder = path.join(tmp.path, "papers")
        const retained = path.join(tmp.path, "papers-retained")
        const source = path.join(folder, "draft.txt")
        const target = path.join(folder, "final.txt")
        await fs.mkdir(folder)
        await fs.writeFile(source, "approved\n")

        using _ = SafeFileIO.testing({
          afterRenameMutation: async () => {
            await fs.rename(folder, retained)
            await fs.symlink(outside.path, folder, "dir")
          },
        })
        await expect(File.rename({ from: source, to: target, sessionID: session.id })).rejects.toThrow(
          "directory identity changed",
        )
        expect(await fs.readFile(path.join(retained, "draft.txt"), "utf8")).toBe("approved\n")
        expect(await fs.readdir(retained)).toEqual(["draft.txt"])
        expect(await fs.readFile(path.join(outside.path, "sentinel.txt"), "utf8")).toBe("outside\n")
        expect(await fs.lstat(path.join(outside.path, "draft.txt")).catch(() => undefined)).toBeUndefined()
        expect(await fs.lstat(path.join(outside.path, "final.txt")).catch(() => undefined)).toBeUndefined()
      },
    })
  })

  test("does not overwrite a target created after verification", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const source = path.join(tmp.path, "draft.txt")
        const target = path.join(tmp.path, "final.txt")
        await fs.writeFile(source, "approved\n")

        using _ = SafeFileIO.testing({
          afterRenameVerify: () => fs.writeFile(target, "concurrent\n"),
        })
        const response = await rename(source, target, session.id)
        expect(response.status).toBe(409)
        expect(await fs.readFile(source, "utf8")).toBe("approved\n")
        expect(await fs.readFile(target, "utf8")).toBe("concurrent\n")
      },
    })
  })

  test("lets revocation win before a rename mutation", async () => {
    await using external = await tmpdir({
      init: (dir) => fs.writeFile(path.join(dir, "draft.txt"), "approved\n"),
    })
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const source = path.join(external.path, "draft.txt")
        const target = path.join(external.path, "final.txt")
        const grant = await SessionFilesystem.grant({
          sessionID: session.id,
          path: external.path,
          access: "write",
          scope: "session",
        })

        using _ = File.testing({
          afterRenameAuthorization: () => SessionFilesystem.revoke(session.id, grant.id).then(() => undefined),
        })
        await expect(File.rename({ from: source, to: target, sessionID: session.id })).rejects.toBeInstanceOf(
          SessionFilesystem.DeniedError,
        )
        expect(await fs.readFile(source, "utf8")).toBe("approved\n")
        expect(await fs.lstat(target).catch(() => undefined)).toBeUndefined()
      },
    })
  })

  test("keeps one-shot authority inside one rename operation", async () => {
    await using external = await tmpdir({
      init: (dir) => fs.writeFile(path.join(dir, "draft.txt"), "approved\n"),
    })
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const source = path.join(external.path, "draft.txt")
        const target = path.join(external.path, "final.txt")
        await SessionFilesystem.grant({
          sessionID: session.id,
          path: external.path,
          access: "write",
          scope: "once",
        })

        await expect(File.rename({ from: source, to: target, sessionID: session.id })).resolves.toMatchObject({
          from: source,
          to: target,
        })
        await expect(
          File.rename({ from: target, to: path.join(external.path, "again.txt"), sessionID: session.id }),
        ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
        expect(await fs.readFile(target, "utf8")).toBe("approved\n")
      },
    })
  })

  test("lets revocation win before a write mutation", async () => {
    await using external = await tmpdir({
      init: (dir) => fs.writeFile(path.join(dir, "draft.txt"), "approved\n"),
    })
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const source = path.join(external.path, "draft.txt")
        const grant = await SessionFilesystem.grant({
          sessionID: session.id,
          path: external.path,
          access: "write",
          scope: "session",
        })

        using _ = File.testing({
          afterWriteAuthorization: () => SessionFilesystem.revoke(session.id, grant.id).then(() => undefined),
        })
        await expect(File.write(source, "mutated\n", { sessionID: session.id })).rejects.toBeInstanceOf(
          SessionFilesystem.DeniedError,
        )
        expect(await fs.readFile(source, "utf8")).toBe("approved\n")
      },
    })
  })
})

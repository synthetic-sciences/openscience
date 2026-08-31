import { describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { SafeTrashIO } from "../../src/file/safe-trash-io"
import { FileTrash } from "../../src/file/trash"
import { WindowsSafeIO } from "../../src/file/windows-safe-io"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { FileRoutes } from "../../src/server/routes/file"
import { SessionFilesystem } from "../../src/session/filesystem"
import { executionSession, tmpdir } from "../fixture/fixture"

describe("recoverable source file trash", () => {
  test("uses the 64-bit directory ABI for Intel macOS trash traversal", () => {
    expect(SafeTrashIO.directorySymbolsForTests("darwin", "x64")).toEqual({
      fdopendir: "fdopendir$INODE64",
      readdir: "readdir$INODE64",
    })
    expect(SafeTrashIO.directorySymbolsForTests("darwin", "arm64")).toEqual({
      fdopendir: "fdopendir",
      readdir: "readdir",
    })
    expect(SafeTrashIO.directorySymbolsForTests("linux", "x64")).toEqual({
      fdopendir: "fdopendir",
      readdir: "readdir",
    })

    const inode64 = Buffer.alloc(32)
    inode64.writeUInt16LE(32, 16)
    inode64.writeUInt16LE(8, 18)
    inode64.write("Contents", 21)
    expect(SafeTrashIO.decodeDirectoryRecordForTests(inode64, "darwin")).toBe("Contents")

    const legacy = Buffer.alloc(264)
    legacy.writeUInt16LE(12, 4)
    legacy.write("Contents", 8)
    expect(() => SafeTrashIO.decodeDirectoryRecordForTests(legacy, "darwin")).toThrow("does not match the selected ABI")
  })

  test("encodes the complete 64-bit FILE_RENAME_INFO layout", () => {
    const name = "result.txt"
    const encoded = Buffer.from(name, "utf16le")
    const buffer = WindowsSafeIO.renameBufferForTests(0x1234n, name, false)

    expect(buffer.byteLength).toBe(24 + encoded.byteLength)
    expect(buffer.readUInt8(0)).toBe(0)
    expect(buffer.readBigUInt64LE(8)).toBe(0x1234n)
    expect(buffer.readUInt32LE(16)).toBe(encoded.byteLength)
    expect(buffer.subarray(20, 20 + encoded.byteLength)).toEqual(encoded)
    expect(buffer.subarray(20 + encoded.byteLength)).toEqual(Buffer.alloc(4))
  })

  test.skipIf(process.platform !== "win32")("hashes a Windows trash snapshot in bounded chunks", async () => {
    await using tmp = await tmpdir()
    const target = path.join(tmp.path, "large-result.bin")
    const bytes = Buffer.alloc(3 * 1024 * 1024 + 17, 0x5a)
    await fs.writeFile(target, bytes)
    const chunks: number[] = []

    const snapshot = await WindowsSafeIO.inspectTrash(target, {
      afterSnapshotChunk: (size) => {
        chunks.push(size)
      },
    })

    expect(snapshot.sha256).toBe(crypto.createHash("sha256").update(bytes).digest("hex"))
    expect(chunks.length).toBeGreaterThan(1)
    expect(Math.max(...chunks)).toBeLessThanOrEqual(64 * 1024)
    expect(chunks.reduce((total, size) => total + size, 0)).toBe(bytes.byteLength)
  })

  test("retains approved bytes for 30 days and restores through the file route", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const target = path.join(tmp.path, "results", "finding.txt")
        await fs.mkdir(path.dirname(target), { recursive: true })
        await fs.writeFile(target, "approved finding\n", { mode: 0o640 })
        const mode = (await fs.stat(target)).mode & 0o777

        const trashed = await FileTrash.trash({
          projectID: Instance.project.id,
          sessionID: session.id,
          path: target,
          expectedContent: "approved finding\n",
        })

        expect(trashed).toMatchObject({
          originalPath: target,
          filename: "finding.txt",
          state: "trash",
          size: 17,
          mode,
        })
        expect(trashed.expiresAt - trashed.trashedAt).toBe(FileTrash.RETENTION_MS)
        await expect(fs.readFile(target)).rejects.toThrow()

        const listed = await FileRoutes().request("/file/trash")
        expect(listed.status).toBe(200)
        expect(await listed.json()).toMatchObject([{ id: trashed.id, originalPath: target, state: "trash" }])

        const restored = await FileRoutes().request(`/file/trash/${trashed.id}/restore`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: session.id }),
        })
        expect(restored.status).toBe(200)
        expect(await restored.json()).toMatchObject({ id: trashed.id, state: "restored" })
        expect(await fs.readFile(target, "utf8")).toBe("approved finding\n")
        if (process.platform !== "win32") expect((await fs.stat(target)).mode & 0o777).toBe(mode)
        expect(await FileTrash.list(Instance.project.id)).toEqual([])

        const duplicate = await FileRoutes().request(`/file/trash/${trashed.id}/restore`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: session.id }),
        })
        expect(duplicate.status).toBe(404)
      },
    })
  })

  test("fails closed on changed bytes, symbolic links, and restore conflicts", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const target = path.join(tmp.path, "source.txt")
        await fs.writeFile(target, "new bytes\n")
        await expect(
          FileTrash.trash({
            projectID: Instance.project.id,
            sessionID: session.id,
            path: target,
            expectedContent: "approved bytes\n",
          }),
        ).rejects.toThrow("changed after approval")
        expect(await fs.readFile(target, "utf8")).toBe("new bytes\n")
        expect(await FileTrash.list(Instance.project.id)).toEqual([])

        if (process.platform !== "win32") {
          const linked = path.join(tmp.path, "linked.txt")
          await fs.symlink(target, linked)
          await expect(
            FileTrash.trash({ projectID: Instance.project.id, sessionID: session.id, path: linked }),
          ).rejects.toThrow("symbolic link")
          expect(await fs.readlink(linked)).toBe(target)
          expect(await fs.readFile(target, "utf8")).toBe("new bytes\n")

          const redirected = path.join(tmp.path, "redirected-trash")
          const trash = path.join(tmp.path, FileTrash.FOLDER)
          await fs.rm(trash, { recursive: true, force: true })
          await fs.mkdir(redirected)
          await fs.symlink(redirected, trash)
          await expect(
            FileTrash.trash({ projectID: Instance.project.id, sessionID: session.id, path: target }),
          ).rejects.toThrow("Invalid workspace trash root")
          expect(await fs.readFile(target, "utf8")).toBe("new bytes\n")
          await fs.unlink(trash)
          await fs.rm(redirected, { recursive: true })
        }

        const trashed = await FileTrash.trash({
          projectID: Instance.project.id,
          sessionID: session.id,
          path: target,
          expectedContent: "new bytes\n",
        })
        await fs.writeFile(target, "replacement must survive\n")
        await expect(
          FileTrash.restore({ projectID: Instance.project.id, sessionID: session.id, id: trashed.id }),
        ).rejects.toThrow("Refusing to overwrite")
        expect(await fs.readFile(target, "utf8")).toBe("replacement must survive\n")
        expect(await FileTrash.list(Instance.project.id)).toMatchObject([{ id: trashed.id, state: "trash" }])
      },
    })
  })

  test("purges expired recovery copies", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const target = path.join(tmp.path, "expired.txt")
        await fs.writeFile(target, "expired\n")
        const record = await FileTrash.trash({
          projectID: Instance.project.id,
          sessionID: session.id,
          path: target,
          now: Date.now() - FileTrash.RETENTION_MS - 1,
        })
        expect(record.expiresAt).toBeLessThan(Date.now())
        expect(await FileTrash.list(Instance.project.id)).toEqual([])
        expect(
          await FileTrash.restore({ projectID: Instance.project.id, sessionID: session.id, id: record.id }),
        ).toBeUndefined()
      },
    })
  })

  test.each(["file", "directory"] as const)(
    "expires restored %s metadata without touching restored content",
    async (kind) => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await executionSession()
          const target = path.join(tmp.path, "restored")
          if (kind === "directory") await fs.mkdir(target)
          const content = kind === "directory" ? path.join(target, "result.txt") : target
          await fs.writeFile(content, "approved result\n")
          const record = await FileTrash.trash({ projectID: Instance.project.id, sessionID: session.id, path: target })
          expect(record.store).toBe("workspace")
          expect(
            (await FileTrash.restore({ projectID: Instance.project.id, sessionID: session.id, id: record.id }))?.state,
          ).toBe("restored")
          await fs.writeFile(content, "new result after restore\n")

          expect(await FileTrash.purgeExpired(Instance.project.id, record.expiresAt + 1)).toBe(1)
          expect(await fs.readFile(content, "utf8")).toBe("new result after restore\n")
          expect(await FileTrash.list(Instance.project.id)).toEqual([])
          expect(await FileTrash.purgeExpired(Instance.project.id, record.expiresAt + 1)).toBe(0)

          const next = path.join(tmp.path, "next.txt")
          await fs.writeFile(next, "next result\n")
          const trashed = await FileTrash.trash({ projectID: Instance.project.id, sessionID: session.id, path: next })
          expect(await FileTrash.list(Instance.project.id)).toMatchObject([{ id: trashed.id }])
        },
      })
    },
  )

  test.each(["unavailable", "changed"] as const)(
    "automatic expiry retains an %s payload record without blocking unrelated trash",
    async (state) => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await executionSession()
          const projectID = Instance.project.id
          const target = path.join(tmp.path, "retained.txt")
          await fs.writeFile(target, "approved result\n")
          const record = await FileTrash.trash({
            projectID,
            sessionID: session.id,
            path: target,
            now: Date.now() - FileTrash.RETENTION_MS - 1,
          })
          const retained = `${record.payloadPath!}.unavailable`
          if (state === "unavailable") await fs.rename(record.payloadPath!, retained)
          if (state === "changed") await fs.writeFile(record.payloadPath!, "changed payload\n")
          const metadata = path.join(
            Global.Path.data,
            "file-trash",
            crypto.createHash("sha256").update(projectID).digest("hex"),
            record.id,
            "record.json",
          )

          const next = path.join(tmp.path, "expired.txt")
          await fs.writeFile(next, "safe to expire\n")
          await FileTrash.trash({
            projectID,
            sessionID: session.id,
            path: next,
            now: Date.now() - FileTrash.RETENTION_MS - 1,
          })
          expect(await FileTrash.purgeExpired(projectID)).toBe(1)
          expect(await FileTrash.purgeExpired(projectID)).toBe(0)
          await expect(FileTrash.list(projectID)).resolves.toBeArray()
          expect(await Bun.file(metadata).json()).toMatchObject({ id: record.id, state: "trash" })
          expect(await fs.readFile(state === "unavailable" ? retained : record.payloadPath!, "utf8")).toBe(
            state === "unavailable" ? "approved result\n" : "changed payload\n",
          )

          const purge = FileTrash.purge({ projectID, sessionID: session.id, id: record.id })
          if (state === "unavailable") expect(await purge).toBeUndefined()
          if (state === "changed") await expect(purge).rejects.toThrow("checksum mismatch")
          expect(await Bun.file(metadata).exists()).toBe(true)
        },
      })
    },
  )

  test("does not advertise metadata written before a recovery payload exists", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const id = `ftr_${crypto.randomUUID()}`
        const projectID = Instance.project.id
        const project = crypto.createHash("sha256").update(projectID).digest("hex")
        const entry = path.join(Global.Path.data, "file-trash", project, id)
        const now = Date.now()
        await fs.mkdir(entry, { recursive: true })
        await fs.writeFile(
          path.join(entry, "record.json"),
          JSON.stringify({
            id,
            projectID,
            originalPath: path.join(tmp.path, "still-present.txt"),
            filename: "still-present.txt",
            size: 1,
            sha256: "0".repeat(64),
            mode: 0o600,
            state: "trash",
            trashedAt: now,
            expiresAt: now + FileTrash.RETENTION_MS,
          }),
        )
        expect(await FileTrash.list(projectID)).toEqual([])
        await fs.rm(entry, { recursive: true, force: true })
      },
    })
  })

  test("moves folders into same-volume workspace trash and restores them through the routes", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const target = path.join(tmp.path, "dataset")
        await fs.mkdir(path.join(target, "nested"), { recursive: true })
        await fs.writeFile(path.join(target, "nested", "sample.csv"), "x,y\n1,2\n")

        const response = await FileRoutes().request("/file/trash", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path: target, sessionID: session.id }),
        })
        expect(response.status).toBe(200)
        const record = (await response.json()) as FileTrash.Record
        expect(record).toMatchObject({ filename: "dataset", kind: "directory", store: "workspace" })
        expect(record.payloadPath).toContain(`${path.sep}${FileTrash.FOLDER}${path.sep}${record.id}${path.sep}payload`)
        expect(await fs.readFile(path.join(tmp.path, FileTrash.FOLDER, ".gitignore"), "utf8")).toBe("*\n")
        await expect(fs.stat(target)).rejects.toThrow()

        const second = path.join(tmp.path, "second.txt")
        await fs.writeFile(second, "second\n")
        const secondRecord = await FileTrash.trash({
          projectID: Instance.project.id,
          sessionID: session.id,
          path: second,
        })
        expect(await fs.readFile(path.join(tmp.path, FileTrash.FOLDER, ".gitignore"), "utf8")).toBe("*\n")
        await FileTrash.purge({ projectID: Instance.project.id, sessionID: session.id, id: secondRecord.id })

        const listing = await FileRoutes().request(
          `/file?path=${encodeURIComponent(tmp.path)}&sessionID=${encodeURIComponent(session.id)}`,
        )
        expect(listing.status).toBe(200)
        expect((await listing.json()) as Array<{ name: string }>).not.toContainEqual({ name: FileTrash.FOLDER })

        const restored = await FileRoutes().request(`/file/trash/${record.id}/restore`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: session.id }),
        })
        expect(restored.status).toBe(200)
        expect(await fs.readFile(path.join(target, "nested", "sample.csv"), "utf8")).toBe("x,y\n1,2\n")
      },
    })
  })

  test("permanently purges a recoverable file through the route", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const target = path.join(tmp.path, "discard.txt")
        await fs.writeFile(target, "discard\n")
        const trashed = await FileTrash.trash({
          projectID: Instance.project.id,
          sessionID: session.id,
          path: target,
        })

        const response = await FileRoutes().request(`/file/trash/${trashed.id}`, {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ sessionID: session.id }),
        })
        expect(response.status).toBe(200)
        expect(await FileTrash.list(Instance.project.id)).toEqual([])
        await expect(fs.stat(target)).rejects.toThrow()
        if (trashed.payloadPath) await expect(fs.stat(trashed.payloadPath)).rejects.toThrow()
      },
    })
  })

  test("rollback restores the original file mode", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const target = path.join(tmp.path, "rollback.txt")
        await fs.writeFile(target, "rollback\n", { mode: 0o640 })
        const record = await FileTrash.trash({
          projectID: Instance.project.id,
          sessionID: session.id,
          path: target,
        })

        await FileTrash.rollback(record)
        expect(await fs.readFile(target, "utf8")).toBe("rollback\n")
        if (process.platform !== "win32") expect((await fs.stat(target)).mode & 0o777).toBe(0o640)
        expect(await FileTrash.list(Instance.project.id)).toEqual([])
      },
    })
  })

  test("rejects forged workspace metadata before restore", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const target = path.join(tmp.path, "trusted.txt")
        const forged = path.join(tmp.path, "forged.txt")
        await fs.writeFile(target, "trusted\n")
        const record = await FileTrash.trash({
          projectID: Instance.project.id,
          sessionID: session.id,
          path: target,
        })
        expect(record.payloadPath).toBeString()
        const local = path.join(path.dirname(record.payloadPath!), "record.json")
        await fs.writeFile(local, JSON.stringify({ ...record, originalPath: forged }))

        await expect(
          FileTrash.restore({ projectID: Instance.project.id, sessionID: session.id, id: record.id }),
        ).rejects.toThrow("metadata mismatch")
        await expect(fs.stat(forged)).rejects.toThrow()
        await expect(fs.stat(target)).rejects.toThrow()
        expect(await fs.readFile(record.payloadPath!, "utf8")).toBe("trusted\n")
      },
    })
  })

  test.skipIf(process.platform === "win32")(
    "does not move an outside item when the approved source parent is swapped",
    async () => {
      await using outside = await tmpdir({
        init: (directory) => Bun.write(path.join(directory, "finding.txt"), "outside\n"),
      })
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const session = await executionSession()
          const parent = path.join(tmp.path, "paper")
          const retained = path.join(tmp.path, "retained")
          const source = path.join(parent, "finding.txt")
          await fs.mkdir(parent)
          await Bun.write(source, "approved\n")
          using barrier = FileTrash.testing({
            afterDirectoryVerify: async (operation, target) => {
              if (operation !== "move" || target !== source) return
              await fs.rename(parent, retained)
              await fs.symlink(outside.path, parent)
            },
          })

          await expect(
            FileTrash.trash({ projectID: Instance.project.id, sessionID: session.id, path: source }),
          ).rejects.toThrow("directory identity changed")
          expect(await Bun.file(path.join(outside.path, "finding.txt")).text()).toBe("outside\n")
          expect(await Bun.file(path.join(retained, "finding.txt")).text()).toBe("approved\n")
          expect(await FileTrash.list(Instance.project.id)).toEqual([])
        },
      })
    },
  )

  test("does not overwrite a restore target created after its parent was verified", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const target = path.join(tmp.path, "result.txt")
        await Bun.write(target, "recoverable\n")
        const record = await FileTrash.trash({
          projectID: Instance.project.id,
          sessionID: session.id,
          path: target,
        })
        using barrier = FileTrash.testing({
          afterDirectoryVerify: async (operation, current) => {
            if (operation !== "restore" || current !== target) return
            await Bun.write(target, "concurrent\n")
          },
        })

        await expect(
          FileTrash.restore({ projectID: Instance.project.id, sessionID: session.id, id: record.id }),
        ).rejects.toMatchObject({ status: 409 })
        expect(await Bun.file(target).text()).toBe("concurrent\n")
        expect(await Bun.file(record.payloadPath!).text()).toBe("recoverable\n")
      },
    })
  })

  test("lets a completed revocation win before the final trash mutation", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const target = path.join(tmp.path, "revoked.txt")
        await Bun.write(target, "retained\n")
        const grant = (await SessionFilesystem.list(session.id)).find(
          (item) => item.access === "write" && item.path === tmp.path && !item.time.revoked,
        )!
        const authorizations: SessionFilesystem.Authorization[] = []
        using barrier = FileTrash.testing({
          afterAuthorization: async (action, _record, authorization) => {
            if (authorization) authorizations.push(authorization)
            if (action === "trash") await SessionFilesystem.revoke(session.id, grant.id)
          },
        })

        await expect(
          FileTrash.trash({ projectID: Instance.project.id, sessionID: session.id, path: target }),
        ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
        expect(await Bun.file(target).text()).toBe("retained\n")
        expect(await FileTrash.list(Instance.project.id)).toEqual([])
        expect(authorizations).toHaveLength(1)
        await expect(SessionFilesystem.revalidateAuthorization(authorizations[0]!)).rejects.toBeInstanceOf(
          SessionFilesystem.DeniedError,
        )
      },
    })
  })

  test("releases owned trash, restore, and purge bindings while preserving borrowed bindings", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const captured: SessionFilesystem.Authorization[] = []
        using barrier = FileTrash.testing({
          afterAuthorization: (_action, _record, authorization) => {
            if (authorization) captured.push(authorization)
          },
        })
        const first = path.join(tmp.path, "first.txt")
        await Bun.write(first, "first\n")
        const record = await FileTrash.trash({
          projectID: Instance.project.id,
          sessionID: session.id,
          path: first,
        })
        await expect(SessionFilesystem.revalidateAuthorization(captured[0]!)).rejects.toBeInstanceOf(
          SessionFilesystem.DeniedError,
        )

        await FileTrash.restore({ projectID: Instance.project.id, sessionID: session.id, id: record.id })
        await expect(SessionFilesystem.revalidateAuthorization(captured[1]!)).rejects.toBeInstanceOf(
          SessionFilesystem.DeniedError,
        )

        const second = path.join(tmp.path, "second.txt")
        await Bun.write(second, "second\n")
        const secondRecord = await FileTrash.trash({
          projectID: Instance.project.id,
          sessionID: session.id,
          path: second,
        })
        await FileTrash.purge({ projectID: Instance.project.id, sessionID: session.id, id: secondRecord.id })
        for (const authorization of captured.slice(2)) {
          await expect(SessionFilesystem.revalidateAuthorization(authorization)).rejects.toBeInstanceOf(
            SessionFilesystem.DeniedError,
          )
        }

        const borrowedTarget = path.join(tmp.path, "borrowed.txt")
        await Bun.write(borrowedTarget, "borrowed\n")
        const authorized = await SessionFilesystem.authorize({
          sessionID: session.id,
          path: borrowedTarget,
          access: "write",
        })
        const borrowed = await SessionFilesystem.bindAuthorization({
          sessionID: session.id,
          access: "write",
          authorized,
        })
        await expect(
          FileTrash.trash({
            projectID: Instance.project.id,
            sessionID: session.id,
            path: borrowedTarget,
            authorization: borrowed,
            authorizationOwnership: "borrowed",
            expectedContent: "different\n",
          }),
        ).rejects.toThrow("changed after approval")
        await expect(SessionFilesystem.revalidateAuthorization(borrowed)).resolves.toMatchObject({
          path: borrowedTarget,
        })
        SessionFilesystem.releaseAuthorization(borrowed)
      },
    })
  })

  test("releases trash authority when an authorized operation errors", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const target = path.join(tmp.path, "error.txt")
        await Bun.write(target, "retained\n")
        const captured: SessionFilesystem.Authorization[] = []
        using barrier = FileTrash.testing({
          afterAuthorization: (_action, _record, authorization) => {
            if (authorization) captured.push(authorization)
            throw new Error("injected authorized failure")
          },
        })
        await expect(
          FileTrash.trash({ projectID: Instance.project.id, sessionID: session.id, path: target }),
        ).rejects.toThrow("injected authorized failure")
        expect(await Bun.file(target).text()).toBe("retained\n")
        await expect(SessionFilesystem.revalidateAuthorization(captured[0]!)).rejects.toBeInstanceOf(
          SessionFilesystem.DeniedError,
        )
      },
    })
  })

  test.skipIf(process.platform === "win32")("never follows a swapped connected trash root during purge", async () => {
    await using outside = await tmpdir()
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const target = path.join(tmp.path, "purge.txt")
        await Bun.write(target, "recoverable\n")
        const record = await FileTrash.trash({
          projectID: Instance.project.id,
          sessionID: session.id,
          path: target,
        })
        const trash = path.join(tmp.path, FileTrash.FOLDER)
        const retained = path.join(tmp.path, "retained-trash")
        const outsideEntry = path.join(outside.path, record.id)
        await fs.mkdir(outsideEntry)
        await Bun.write(path.join(outsideEntry, "sentinel.txt"), "outside\n")
        using barrier = FileTrash.testing({
          afterDirectoryVerify: async (operation, current) => {
            if (operation !== "remove" || current !== path.dirname(record.payloadPath!)) return
            await fs.rename(trash, retained)
            await fs.symlink(outside.path, trash)
          },
        })

        await expect(
          FileTrash.purge({ projectID: Instance.project.id, sessionID: session.id, id: record.id }),
        ).rejects.toThrow("directory identity changed")
        expect(await Bun.file(path.join(outsideEntry, "sentinel.txt")).text()).toBe("outside\n")
        expect(await Bun.file(path.join(retained, record.id, "payload")).text()).toBe("recoverable\n")
      },
    })
  })

  test.skipIf(process.platform === "win32")(
    "restores an unapproved entry raced into a purge pathname before mutation",
    async () => {
      await using tmp = await tmpdir()
      const target = path.join(tmp.path, "approved-directory")
      const retained = path.join(tmp.path, "approved-retained")
      await fs.mkdir(target)
      await Bun.write(path.join(target, "identity"), "approved\n")
      const approved = await SafeTrashIO.inspect(target)

      await expect(
        SafeTrashIO.remove(target, approved, {
          afterFinalEntryVerify: async () => {
            await fs.rename(target, retained)
            await fs.mkdir(target)
            await Bun.write(path.join(target, "identity"), "replacement\n")
          },
        }),
      ).rejects.toThrow("identity changed during purge")

      expect(await Bun.file(path.join(target, "identity")).text()).toBe("replacement\n")
      expect(await Bun.file(path.join(retained, "identity")).text()).toBe("approved\n")
      expect((await fs.readdir(tmp.path)).some((name) => name.startsWith(".openscience-purge-"))).toBe(false)
    },
  )
})

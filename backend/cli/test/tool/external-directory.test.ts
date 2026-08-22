import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import path from "path"
import type { Tool } from "../../src/tool/tool"
import { Instance } from "../../src/project/instance"
import { assertExternalDirectory } from "../../src/tool/external-directory"
import type { PermissionNext } from "../../src/permission/next"
import { Filesystem } from "../../src/util/filesystem"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { tmpdir } from "../fixture/fixture"

const baseCtx: Omit<Tool.Context, "ask"> = {
  sessionID: "test",
  messageID: "",
  callID: "",
  agent: "research",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
}

describe("tool.assertExternalDirectory", () => {
  test("no-ops for empty target", async () => {
    const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
    const ctx: Tool.Context = {
      ...baseCtx,
      ask: async (req) => {
        requests.push(req)
      },
    }

    await Instance.provide({
      directory: "/tmp",
      fn: async () => {
        await assertExternalDirectory(ctx)
      },
    })

    expect(requests.length).toBe(0)
  })

  test("no-ops for paths inside Instance.directory", async () => {
    const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
    const ctx: Tool.Context = {
      ...baseCtx,
      ask: async (req) => {
        requests.push(req)
      },
    }

    await Instance.provide({
      directory: "/tmp/project",
      fn: async () => {
        await assertExternalDirectory(ctx, path.join("/tmp/project", "file.txt"))
      },
    })

    expect(requests.length).toBe(0)
  })

  test("asks with a single canonical glob", async () => {
    const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
    const ctx: Tool.Context = {
      ...baseCtx,
      ask: async (req) => {
        requests.push(req)
      },
    }

    const directory = "/tmp/project"
    const target = "/tmp/outside/file.txt"
    const expected = path.join(path.dirname((await Filesystem.canonical(target))!), "*")

    await Instance.provide({
      directory,
      fn: async () => {
        await assertExternalDirectory(ctx, target)
      },
    })

    const req = requests.find((r) => r.permission === "external_directory")
    expect(req).toBeDefined()
    expect(req!.patterns).toEqual([expected])
    expect(req!.always).toEqual([expected])
  })

  test("uses target directory when kind=directory", async () => {
    const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
    const ctx: Tool.Context = {
      ...baseCtx,
      ask: async (req) => {
        requests.push(req)
      },
    }

    const directory = "/tmp/project"
    const target = "/tmp/outside"
    const expected = path.join((await Filesystem.canonical(target))!, "*")

    await Instance.provide({
      directory,
      fn: async () => {
        await assertExternalDirectory(ctx, target, { kind: "directory" })
      },
    })

    const req = requests.find((r) => r.permission === "external_directory")
    expect(req).toBeDefined()
    expect(req!.patterns).toEqual([expected])
    expect(req!.always).toEqual([expected])
  })

  test("skips prompting when bypass=true", async () => {
    const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
    const ctx: Tool.Context = {
      ...baseCtx,
      ask: async (req) => {
        requests.push(req)
      },
    }

    await Instance.provide({
      directory: "/tmp/project",
      fn: async () => {
        await assertExternalDirectory(ctx, "/tmp/outside/file.txt", { bypass: true })
      },
    })

    expect(requests.length).toBe(0)
  })

  test("releases owned bindings after success, error, and abort", async () => {
    await using project = await tmpdir({ git: true })
    await using external = await tmpdir({ init: (directory) => Bun.write(path.join(directory, "paper.md"), "paper\n") })
    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const session = await Session.create({ title: "external scope lifecycle" })
        try {
          await SessionFilesystem.grant({
            sessionID: session.id,
            path: external.path,
            access: "read",
            scope: "session",
          })
          const target = path.join(external.path, "paper.md")
          const bindings: SessionFilesystem.Authorization[] = []
          const context = (abort = AbortSignal.any([])): Tool.Context => ({
            ...baseCtx,
            sessionID: session.id,
            abort,
            ask: async () => {},
          })

          await (async () => {
            using access = await assertExternalDirectory(context(), target)
            expect(access?.authorizationOwnership).toBe("owned")
            bindings.push(access!.authorization!)
            await expect(access?.revalidate()).resolves.toBe(target)
          })()

          await expect(
            (async () => {
              using access = await assertExternalDirectory(context(), target)
              bindings.push(access!.authorization!)
              throw new Error("injected consumer failure")
            })(),
          ).rejects.toThrow("injected consumer failure")

          const controller = new AbortController()
          await expect(
            (async () => {
              using access = await assertExternalDirectory(context(controller.signal), target)
              bindings.push(access!.authorization!)
              controller.abort()
              controller.signal.throwIfAborted()
            })(),
          ).rejects.toBeInstanceOf(DOMException)

          for (const binding of bindings) {
            await expect(SessionFilesystem.revalidateAuthorization(binding)).rejects.toBeInstanceOf(
              SessionFilesystem.DeniedError,
            )
          }
        } finally {
          await Session.remove(session.id)
        }
      },
    })
  })

  test("rejects an internal path whose parent is swapped for an external symlink", async () => {
    await using project = await tmpdir({
      git: true,
      init: async (directory) => {
        await Bun.write(path.join(directory, "papers", "paper.md"), "internal\n")
      },
    })
    await using external = await tmpdir({
      init: (directory) => Bun.write(path.join(directory, "paper.md"), "external\n"),
    })
    await Instance.provide({
      directory: project.path,
      fn: async () => {
        const folder = path.join(project.path, "papers")
        const target = path.join(folder, "paper.md")
        using access = await assertExternalDirectory({ ...baseCtx, ask: async () => {} }, target)
        await fs.rename(folder, path.join(project.path, "papers-retained"))
        await fs.symlink(external.path, folder, "dir")

        await expect(access?.revalidate()).rejects.toBeInstanceOf(SessionFilesystem.InvalidPathError)
        expect(await Bun.file(path.join(external.path, "paper.md")).text()).toBe("external\n")
      },
    })
  })
})

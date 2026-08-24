import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { GrepTool } from "../../src/tool/grep"
import { ReadTool } from "../../src/tool/read"
import { materializeTaskToolOutputs } from "../../src/tool/task"
import { Truncate } from "../../src/tool/truncation"
import type { PermissionNext } from "../../src/permission/next"
import { tmpdir } from "../fixture/fixture"

describe("Task tool-output handoff", () => {
  test("grants a direct child read-only access to parent artifacts only", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})
        const child = await Session.create({ parentID: parent.id })
        const sibling = await Session.create({})
        const parentFile = path.join(await SessionFilesystem.workspace(parent.id), "result.json")
        const siblingFile = path.join(await SessionFilesystem.workspace(sibling.id), "private.json")
        await Bun.write(parentFile, "parent evidence")
        await Bun.write(siblingFile, "sibling evidence")

        try {
          const grant = await SessionFilesystem.grantTaskHandoff({
            parentSessionID: parent.id,
            childSessionID: child.id,
          })
          expect(grant).toMatchObject({ path: path.dirname(parentFile), access: "read", source: "handoff" })
          await expect(
            SessionFilesystem.authorize({ sessionID: child.id, path: parentFile, access: "read" }),
          ).resolves.toBeDefined()
          await expect(
            SessionFilesystem.authorize({ sessionID: child.id, path: parentFile, access: "write" }),
          ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
          await expect(
            SessionFilesystem.authorize({ sessionID: child.id, path: siblingFile, access: "read" }),
          ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
          expect(await SessionFilesystem.processReadRoots(child.id)).toContain(path.dirname(parentFile))
          expect(await SessionFilesystem.processWriteRoots(child.id)).not.toContain(path.dirname(parentFile))

          const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
          const ctx = {
            sessionID: child.id,
            messageID: "msg_handoff",
            callID: "call_handoff",
            agent: "execute",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => {},
            ask: async (request: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
              requests.push(request)
            },
          }
          expect((await (await ReadTool.init()).execute({ filePath: parentFile }, ctx)).output).toContain(
            "parent evidence",
          )
          expect(requests.some((request) => request.permission === "external_directory")).toBe(false)
        } finally {
          await Promise.all([Session.remove(child.id), Session.remove(sibling.id)])
          await Session.remove(parent.id)
        }
      },
    })
  })

  test("copies exact broker outputs into child scratch for Read and Grep", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})
        const child = await Session.create({})
        const name = Identifier.ascending("tool")
        const source = path.join(Truncate.DIR, name)
        await fs.mkdir(Truncate.DIR, { recursive: true })
        await Bun.write(source, "alpha evidence\nbeta evidence\n")
        await SessionFilesystem.grantToolOutput({ sessionID: parent.id, path: source })

        try {
          const physical = await fs.realpath(source)
          const result = await materializeTaskToolOutputs({
            parentSessionID: parent.id,
            childSessionID: child.id,
            prompt: `Inspect ${source}, then confirm the same file at ${physical}. Repeat ${source}.`,
          })

          expect(result.files).toHaveLength(1)
          expect(result.prompt).not.toContain(source)
          expect(result.prompt).not.toContain(physical)
          expect(result.prompt.match(new RegExp(result.files[0], "g"))).toHaveLength(3)
          expect(await Bun.file(result.files[0]).text()).toBe("alpha evidence\nbeta evidence\n")
          expect(result.files[0].startsWith(await SessionFilesystem.workspace(child.id))).toBe(true)

          const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
          const ctx = {
            sessionID: child.id,
            messageID: "msg_handoff",
            callID: "call_handoff",
            agent: "explore",
            abort: AbortSignal.any([]),
            messages: [],
            metadata: () => {},
            ask: async (request: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
              requests.push(request)
            },
          }
          expect((await (await ReadTool.init()).execute({ filePath: result.files[0] }, ctx)).output).toContain(
            "alpha evidence",
          )
          expect(
            (await (await GrepTool.init()).execute({ path: result.files[0], pattern: "beta" }, ctx)).output,
          ).toContain("beta evidence")
          expect(requests.some((request) => request.permission === "external_directory")).toBe(false)
        } finally {
          await fs.rm(source, { force: true })
          await Promise.all([Session.remove(parent.id), Session.remove(child.id)])
        }
      },
    })
  })

  test("does not transfer arbitrary external or sibling-workspace paths", async () => {
    await using tmp = await tmpdir({ git: true })
    await using external = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})
        const child = await Session.create({})
        const sibling = await Session.create({})
        const externalPath = path.join(external.path, Identifier.ascending("tool"))
        const siblingPath = path.join(await SessionFilesystem.workspace(sibling.id), Identifier.ascending("tool"))
        await Bun.write(externalPath, "external secret")
        await Bun.write(siblingPath, "sibling secret")

        const prompt = `Leave ${externalPath}, ${siblingPath}, and ${Truncate.DIR} unchanged.`
        const result = await materializeTaskToolOutputs({
          prompt,
          parentSessionID: parent.id,
          childSessionID: child.id,
        })
        expect(result).toEqual({ prompt, files: [] })

        await expect(
          SessionFilesystem.authorize({ sessionID: child.id, path: externalPath, access: "read" }),
        ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
        await expect(
          SessionFilesystem.authorize({ sessionID: child.id, path: siblingPath, access: "read" }),
        ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)

        await Promise.all([Session.remove(parent.id), Session.remove(child.id), Session.remove(sibling.id)])
      },
    })
  })

  test("rejects broker entries that are missing or symlink outside the broker", async () => {
    await using tmp = await tmpdir({ git: true })
    await using external = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})
        const child = await Session.create({})
        await fs.mkdir(Truncate.DIR, { recursive: true })
        const missing = path.join(Truncate.DIR, Identifier.ascending("tool"))
        const link = path.join(Truncate.DIR, Identifier.ascending("tool"))
        const target = path.join(external.path, "secret.txt")
        await Bun.write(target, "external secret")
        await fs.symlink(target, link)

        try {
          await expect(
            materializeTaskToolOutputs({
              prompt: `Inspect ${missing}`,
              parentSessionID: parent.id,
              childSessionID: child.id,
            }),
          ).rejects.toThrow("unavailable broker tool output")
          await expect(
            materializeTaskToolOutputs({
              prompt: `Inspect ${link}`,
              parentSessionID: parent.id,
              childSessionID: child.id,
            }),
          ).rejects.toThrow("unavailable broker tool output")
        } finally {
          await fs.rm(link, { force: true })
          await Promise.all([Session.remove(parent.id), Session.remove(child.id)])
        }
      },
    })
  })

  test("rejects a broker output owned by another session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const owner = await Session.create({})
        const parent = await Session.create({})
        const child = await Session.create({})
        const source = path.join(Truncate.DIR, Identifier.ascending("tool"))
        await fs.mkdir(Truncate.DIR, { recursive: true })
        await Bun.write(source, "session-private evidence")
        await SessionFilesystem.grantToolOutput({ sessionID: owner.id, path: source })

        try {
          await expect(
            materializeTaskToolOutputs({
              prompt: `Inspect ${source}`,
              parentSessionID: parent.id,
              childSessionID: child.id,
            }),
          ).rejects.toThrow("unavailable broker tool output")
          expect(await fs.readdir(await SessionFilesystem.workspace(child.id))).toEqual([])
        } finally {
          await fs.rm(source, { force: true })
          await Promise.all([Session.remove(owner.id), Session.remove(parent.id), Session.remove(child.id)])
        }
      },
    })
  })
})

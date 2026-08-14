import { describe, expect, test } from "bun:test"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { EditTool } from "../../src/tool/edit"
import { GlobTool } from "../../src/tool/glob"
import { GrepTool } from "../../src/tool/grep"
import { ListTool } from "../../src/tool/ls"
import { ReadTool } from "../../src/tool/read"
import { WriteTool } from "../../src/tool/write"
import { Truncate } from "../../src/tool/truncation"
import type { PermissionNext } from "../../src/permission/next"
import { tmpdir, trustProject } from "../fixture/fixture"
import { Agent } from "../../src/agent/agent"
import { PermissionNext as Permission } from "../../src/permission/next"

describe("session workspace file tools", () => {
  test("Agent policy keeps the tool-output broker exact and session-owned", async () => {
    await using tmp = await tmpdir({
      git: true,
      config: { permission: { external_directory: "deny" } },
    })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const owner = await Session.create({})
        const sibling = await Session.create({})
        const research = await Agent.get("research")
        if (!research) throw new Error("missing research agent")
        const truncated = await Truncate.output("broker evidence\n".repeat(20), {
          maxLines: 2,
          sessionID: owner.id,
        })
        if (!truncated.truncated) throw new Error("expected a managed tool output")
        const tool = async (sessionID: string, request: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) =>
          Permission.ask({
            ...request,
            sessionID,
            tool: { messageID: "msg_broker_boundary", callID: "call_broker_boundary" },
            ruleset: research.permission,
          })
        const ctx = (sessionID: string) => ({
          sessionID,
          messageID: "msg_broker_boundary",
          callID: "call_broker_boundary",
          agent: "research",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: async () => {},
          ask: (request: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => tool(sessionID, request),
        })

        expect(
          (await (await ReadTool.init()).execute({ filePath: truncated.outputPath }, ctx(owner.id))).output,
        ).toContain("broker evidence")
        await expect(
          (await ReadTool.init()).execute({ filePath: truncated.outputPath }, ctx(sibling.id)),
        ).rejects.toBeInstanceOf(Permission.DeniedError)
        await expect(
          (await GlobTool.init()).execute({ path: Truncate.DIR, pattern: "tool_*" }, ctx(sibling.id)),
        ).rejects.toBeInstanceOf(Permission.DeniedError)
        await expect((await ListTool.init()).execute({ path: Truncate.DIR }, ctx(sibling.id))).rejects.toBeInstanceOf(
          Permission.DeniedError,
        )

        await Promise.all([Session.remove(owner.id), Session.remove(sibling.id)])
      },
    })
  })

  test("relative and default file operations share the runtime workspace while sibling isolation remains closed", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const owner = await Session.create({})
        const sibling = await Session.create({})
        const workspace = await SessionFilesystem.workspace(owner.id)
        const siblingWorkspace = await SessionFilesystem.workspace(sibling.id)
        await Bun.write(path.join(workspace, "evidence.txt"), "workspace evidence\n")
        await Bun.write(path.join(siblingWorkspace, "private.txt"), "sibling secret\n")

        const requests: Array<Omit<PermissionNext.Request, "id" | "sessionID" | "tool">> = []
        const ctx = {
          sessionID: owner.id,
          messageID: "msg_workspace",
          callID: "call_workspace",
          agent: "research",
          abort: AbortSignal.any([]),
          messages: [],
          metadata: async () => {},
          ask: async (request: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => {
            requests.push(request)
          },
        }

        expect((await (await ReadTool.init()).execute({ filePath: "evidence.txt" }, ctx)).output).toContain(
          "workspace evidence",
        )
        expect((await (await GlobTool.init()).execute({ pattern: "*.txt" }, ctx)).output).toContain("evidence.txt")
        expect((await (await GrepTool.init()).execute({ pattern: "workspace" }, ctx)).output).toContain(
          "workspace evidence",
        )
        expect((await (await ListTool.init()).execute({}, ctx)).output).toContain("evidence.txt")
        await (await WriteTool.init()).execute({ filePath: "notes.txt", content: "draft\n" }, ctx)
        await (await EditTool.init()).execute({ filePath: "notes.txt", oldString: "draft", newString: "verified" }, ctx)
        await (
          await ApplyPatchTool.init()
        ).execute(
          {
            patchText: [
              "*** Begin Patch",
              "*** Update File: notes.txt",
              "@@",
              "-verified",
              "+verified result",
              "*** End Patch",
            ].join("\n"),
          },
          ctx,
        )
        expect(await Bun.file(path.join(workspace, "notes.txt")).text()).toBe("verified result\n")
        expect(requests.some((request) => request.permission === "external_directory")).toBeFalse()

        const truncated = await Truncate.output("managed evidence\n".repeat(20), {
          maxLines: 2,
          sessionID: owner.id,
        })
        if (!truncated.truncated) throw new Error("expected a managed tool output")
        const before = requests.length
        expect((await (await ReadTool.init()).execute({ filePath: truncated.outputPath }, ctx)).output).toContain(
          "managed evidence",
        )
        expect(requests.length).toBe(before)
        const toolGrant = (await SessionFilesystem.list(owner.id)).find((grant) => grant.source === "tool")
        expect(toolGrant).toEqual(
          expect.objectContaining({
            access: "read",
            scope: "session",
            source: "tool",
          }),
        )
        expect(path.basename(toolGrant!.path)).toBe(path.basename(truncated.outputPath))
        await expect(
          (await ReadTool.init()).execute({ filePath: truncated.outputPath }, { ...ctx, sessionID: sibling.id }),
        ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
        expect(requests.some((request) => request.permission === "external_directory")).toBeTrue()

        await expect(
          (await ReadTool.init()).execute({ filePath: path.join(siblingWorkspace, "private.txt") }, ctx),
        ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
        expect(requests.some((request) => request.permission === "external_directory")).toBeTrue()

        await Promise.all([Session.remove(owner.id), Session.remove(sibling.id)])
      },
    })
  })
})

import { expect, test } from "bun:test"
import path from "node:path"
import { createOpenScienceClient } from "@synsci/sdk/v2"
import { session } from "../../src/cli/cmd/run"
import { Identifier } from "../../src/id/id"
import { ExecutionAuthority } from "../../src/project/execution"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { SessionWorkspace } from "../../src/session/workspace"
import { Storage } from "../../src/storage/storage"
import { BashTool } from "../../src/tool/bash"
import { ReadTool } from "../../src/tool/read"
import { WriteTool } from "../../src/tool/write"
import { tmpdir, trustProject } from "../fixture/fixture"

function client(directory: string) {
  return createOpenScienceClient({ baseUrl: "http://openscience.internal", fetch: Server.internalFetch(), directory })
}

function context(sessionID: string) {
  return {
    sessionID,
    messageID: "msg_workspace_contract",
    callID: "call_workspace_contract",
    agent: "research",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: async () => {},
    ask: async () => {},
  }
}

test("project workspace sets the actual default tool cwd and session deletion never moves or removes project files", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const sdk = client(tmp.path)
      await Bun.write(path.join(tmp.path, "fixture-input.txt"), "42\n")
      const sessionID = await session(sdk, { message: "Read the task", workspace: "project" })
      if (!sessionID) throw new Error("missing session")
      try {
        expect((await sdk.session.get({ sessionID })).data?.workspace).toBe("project")
        expect((await ExecutionAuthority.require({ sessionID, capability: "shell" })).workspace).toBe(tmp.path)
        const bash = await (
          await BashTool.init()
        ).execute(
          { command: "pwd; cat fixture-input.txt > result.txt", description: "Read fixture in default directory" },
          context(sessionID),
        )
        expect(bash.metadata.exit).toBe(0)
        expect(bash.output.trim()).toBe(tmp.path)
        expect(await Bun.file(path.join(tmp.path, "result.txt")).text()).toBe("42\n")
        expect(
          (await (await ReadTool.init()).execute({ filePath: "fixture-input.txt" }, context(sessionID))).output,
        ).toContain("42")
        await (
          await WriteTool.init()
        ).execute({ filePath: "notes.txt", content: "project evidence\n" }, context(sessionID))
        expect(await Bun.file(path.join(tmp.path, "notes.txt")).text()).toBe("project evidence\n")
      } finally {
        await sdk.session.delete({ sessionID }, { throwOnError: true })
      }
      const workspace = await SessionWorkspace.get(sessionID)
      expect(workspace).toMatchObject({ mode: "legacy", state: "trash", scratchRoot: tmp.path, size: 0 })
      expect(workspace.trashRoot).toBeUndefined()
      await SessionWorkspace.purge(sessionID)
      expect(await Bun.file(path.join(tmp.path, "fixture-input.txt")).text()).toBe("42\n")
      expect(await Bun.file(path.join(tmp.path, "result.txt")).text()).toBe("42\n")
      expect(await Bun.file(path.join(tmp.path, "notes.txt")).text()).toBe("project evidence\n")
    },
  })
})

test("omitting workspace keeps owned isolated scratch as the actual default tool cwd", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const sdk = client(tmp.path)
      const sessionID = await session(sdk, { message: "Use scratch" })
      if (!sessionID) throw new Error("missing session")
      try {
        const workspace = await SessionFilesystem.workspace(sessionID)
        expect(workspace).not.toBe(tmp.path)
        expect((await sdk.session.get({ sessionID })).data?.workspace).toBe("isolated")
        const bash = await (
          await BashTool.init()
        ).execute({ command: "pwd", description: "Check default scratch directory" }, context(sessionID))
        expect(bash.metadata.exit).toBe(0)
        expect(bash.output.trim()).toBe(workspace)
        await (await WriteTool.init()).execute({ filePath: "notes.txt", content: "scratch\n" }, context(sessionID))
        expect(await Bun.file(path.join(workspace, "notes.txt")).text()).toBe("scratch\n")
        expect(await Bun.file(path.join(tmp.path, "notes.txt")).exists()).toBe(false)
      } finally {
        await sdk.session.delete({ sessionID }, { throwOnError: true })
        await SessionWorkspace.purge(sessionID)
      }
    },
  })
})

test("resumed and continued sessions preserve workspace and reject an explicitly conflicting mode", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const sdk = client(tmp.path)
      const sessionID = await session(sdk, { message: "Project session", workspace: "project" })
      if (!sessionID) throw new Error("missing session")
      try {
        // Historical records have no public selection field; their durable
        // filesystem/workspace record remains authoritative on resume.
        await Storage.update<Session.Info>(["session", Instance.project.id, sessionID], (draft) => {
          delete draft.workspace
        })
        expect(await session(sdk, { session: sessionID, message: "Resume" })).toBe(sessionID)
        expect(await session(sdk, { session: sessionID, message: "Resume", workspace: "project" })).toBe(sessionID)
        expect(await session(sdk, { continue: true, message: "Continue", workspace: "project" })).toBe(sessionID)
        await expect(session(sdk, { session: sessionID, message: "Resume", workspace: "isolated" })).rejects.toThrow(
          "cannot use isolated",
        )
        await expect(session(sdk, { continue: true, message: "Continue", workspace: "isolated" })).rejects.toThrow(
          "cannot use isolated",
        )
        expect(await SessionFilesystem.workspace(sessionID)).toBe(tmp.path)
      } finally {
        await sdk.session.delete({ sessionID }, { throwOnError: true })
        await SessionWorkspace.purge(sessionID)
      }
    },
  })
})

test("public session ID retries retain the original workspace and return HTTP 409 for explicit conflicts", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const sdk = client(tmp.path)
      for (const workspace of ["project", "isolated"] as const) {
        const id = Identifier.descending("session")
        const created = await sdk.session.create({ id, workspace }, { throwOnError: true })
        try {
          expect(created.data.workspace).toBe(workspace)
          expect((await sdk.session.create({ id, workspace })).data).toEqual(created.data)
          expect((await sdk.session.create({ id })).data).toEqual(created.data)
          const conflict = await sdk.session.create({ id, workspace: workspace === "project" ? "isolated" : "project" })
          expect(conflict.response?.status).toBe(409)
          expect(conflict.error).toMatchObject({
            name: "SessionWorkspaceMismatchError",
            data: { sessionID: id, workspace },
          })
          expect((await sdk.session.get({ sessionID: id })).data).toEqual(created.data)
          const snapshot = await SessionFilesystem.snapshot(id)
          expect(snapshot.workspace.mode).toBe(workspace === "project" ? "legacy" : "isolated")
        } finally {
          await sdk.session.delete({ sessionID: id }, { throwOnError: true })
          await SessionWorkspace.purge(id)
        }
      }
    },
  })
})

test("an attached older server that ignores workspace cannot silently run a project request in scratch", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const created: string[] = []
      const internal = Server.internalFetch()
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          if (request.method !== "POST" || new URL(request.url).pathname !== "/session") return internal(request)
          // The previous create schema strips this unknown optional field.
          // Everything else uses the real server and persistent session store.
          const body = await request.json()
          delete body.workspace
          const response = await internal(
            new Request(request.url, {
              method: request.method,
              headers: request.headers,
              body: JSON.stringify(body),
            }),
          )
          created.push((await response.clone().json()).id)
          return response
        },
      })
      try {
        const sdk = createOpenScienceClient({ baseUrl: server.url.href, directory: tmp.path })
        await expect(session(sdk, { message: "Use the task project", workspace: "project" })).rejects.toThrow(
          "cannot use project",
        )
        expect(created).toHaveLength(1)
        expect((await sdk.session.list()).data).toEqual([])
        const workspace = await SessionWorkspace.get(created[0])
        expect(workspace).toMatchObject({ mode: "isolated", state: "trash" })
        await SessionWorkspace.purge(created[0])
      } finally {
        await server.stop(true)
      }
    },
  })
})

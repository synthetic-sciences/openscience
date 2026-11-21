import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { Log } from "../../src/util/log"
import { tmpdir } from "../fixture/fixture"

Log.init({ print: false })

let scratch: string
let folder: string
const saved = process.env.OPENSCIENCE_IMPORT_ROOT_CLAUDE

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "os-import-route-"))
  folder = path.join(scratch, "source-folder")
  await fs.mkdir(folder, { recursive: true })
  const root = path.join(scratch, "claude-projects")
  process.env.OPENSCIENCE_IMPORT_ROOT_CLAUDE = root
  const dir = path.join(root, "-source-folder")
  await fs.mkdir(dir, { recursive: true })
  const t = (s: number) => new Date(Date.parse("2026-11-01T10:00:00Z") + s * 1000).toISOString()
  const records = [
    {
      type: "user",
      uuid: "u1",
      parentUuid: null,
      cwd: folder,
      timestamp: t(0),
      message: { role: "user", content: "route question" },
    },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      cwd: folder,
      timestamp: t(1),
      message: {
        id: "m1",
        role: "assistant",
        model: "claude-sonnet-5",
        content: [{ type: "text", text: "route answer" }],
        stop_reason: "end_turn",
      },
    },
  ]
  await fs.writeFile(path.join(dir, "conv-route.jsonl"), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
})
afterEach(async () => {
  if (saved === undefined) delete process.env.OPENSCIENCE_IMPORT_ROOT_CLAUDE
  else process.env.OPENSCIENCE_IMPORT_ROOT_CLAUDE = saved
  await fs.rm(scratch, { recursive: true, force: true })
})

async function withServer(fn: (call: (route: string, init?: RequestInit) => Promise<Response>) => Promise<void>) {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const fetch = Server.internalFetch()
      const query = `directory=${encodeURIComponent(tmp.path)}`
      await fn((route, init) =>
        fetch(`http://openscience.internal${route}${route.includes("?") ? "&" : "?"}${query}`, init),
      )
    },
  })
}

describe("session import routes", () => {
  test("lists Claude Code conversations", async () => {
    await withServer(async (call) => {
      const response = await call("/session/import/claude")
      expect(response.status).toBe(200)
      const body = (await response.json()) as Array<{ id: string; firstMessage?: string; cwd?: string }>
      expect(body).toHaveLength(1)
      expect(body[0]).toMatchObject({ id: "conv-route", firstMessage: "route question", cwd: folder })
    })
  })

  test("reports the original folder", async () => {
    await withServer(async (call) => {
      const response = await call("/session/import/claude/conv-route/folder")
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ path: folder, exists: true })
    })
  })

  test("imports a conversation", async () => {
    await withServer(async (call) => {
      const response = await call("/session/import/claude", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceID: "conv-route", folderAccess: "read" }),
      })
      expect(response.status).toBe(200)
      const body = (await response.json()) as { sessionID: string; outcome: string }
      expect(body.outcome).toBe("created")
      const messages = await Session.messages({ sessionID: body.sessionID })
      expect(messages.map((m) => m.info.role)).toEqual(["user", "assistant"])
    })
  })

  test("rejects an unknown source", async () => {
    await withServer(async (call) => {
      expect((await call("/session/import/cursor")).status).toBe(400)
    })
  })

  test("a path-like id is not found", async () => {
    await withServer(async (call) => {
      const response = await call("/session/import/claude", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceID: "../-source-folder/conv-route", folderAccess: "none" }),
      })
      expect(response.status).toBe(404)
      expect((await call(`/session/import/claude/${encodeURIComponent("../conv-route")}/folder`)).status).toBe(404)
    })
  })
})

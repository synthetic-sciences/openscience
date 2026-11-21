import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Instance } from "../../../src/project/instance"
import { Session } from "../../../src/session"
import { SessionFilesystem } from "../../../src/session/filesystem"
import { ForeignImport } from "../../../src/session/foreign/import"
import { Provenance } from "../../../src/session/foreign/provenance"
import { Storage } from "../../../src/storage/storage"
import { MessageV2 } from "../../../src/session/message-v2"
import { Identifier } from "../../../src/id/id"
import { Filesystem } from "../../../src/util/filesystem"
import { Project } from "../../../src/project/project"
import { Log } from "../../../src/util/log"
import { tmpdir } from "../../fixture/fixture"

Log.init({ print: false })

// Claude Code-format fixtures in a temp "~/.claude/projects", pointing at a
// temp source folder. The OpenScience project is a separate temp directory.
let scratch: string
let claudeRoot: string
let folder: string

beforeEach(async () => {
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "os-import-"))
  claudeRoot = path.join(scratch, "claude-projects")
  folder = path.join(scratch, "source-folder")
  await fs.mkdir(folder, { recursive: true })
})
afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true })
})

const t0 = Date.parse("2026-11-01T10:00:00Z")
const at = (s: number) => new Date(t0 + s * 1000).toISOString()
type Rec = Record<string, unknown>
const user = (uuid: string, parent: string | null, text: string, s: number, cwd = folder): Rec => ({
  type: "user",
  uuid,
  parentUuid: parent,
  cwd,
  timestamp: at(s),
  message: { role: "user", content: text },
})
const reply = (uuid: string, parent: string, text: string, s: number): Rec => ({
  type: "assistant",
  uuid,
  parentUuid: parent,
  cwd: folder,
  timestamp: at(s),
  message: {
    id: `msg_${uuid}`,
    role: "assistant",
    model: "claude-sonnet-5",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
    usage: { input_tokens: 1, output_tokens: 1 },
  },
})

async function source(records: Rec[], id = "conv-1") {
  const dir = path.join(claudeRoot, "-source-folder")
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, `${id}.jsonl`), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
}

async function inProject<T>(fn: () => Promise<T>) {
  await using tmp = await tmpdir()
  return await Instance.provide({ directory: tmp.path, fn })
}

const run = (folderAccess: "write" | "read" | "none" = "write", sourceID = "conv-1") =>
  ForeignImport.run({ source: "claude", sourceID, folderAccess, root: claudeRoot })

const texts = async (sessionID: string) =>
  (await Session.messages({ sessionID })).flatMap((m) =>
    m.parts.filter((p) => p.type === "text").map((p) => `${m.info.role}:${(p as MessageV2.TextPart).text}`),
  )

const canonical = async (value: string) => Project.canonicalize((await Filesystem.canonical(value))!)

const grantsFor = async (dir: string) => {
  const root = await canonical(dir)
  return (await SessionFilesystem.projectSnapshot()).grants.filter((g) => !g.time.revoked && g.path === root)
}

const base = () => [user("u1", null, "first question", 0), reply("a1", "u1", "first answer", 1)]

describe("ForeignImport", () => {
  test("lists sessions and reports the folder", async () => {
    await source(base())
    await inProject(async () => {
      const list = await ForeignImport.list("claude", claudeRoot)
      expect(list.map((s) => s.id)).toEqual(["conv-1"])
      expect(await ForeignImport.folder("claude", "conv-1", claudeRoot)).toEqual({ path: folder, exists: true })
    })
  })

  test("an unknown id is not found", async () => {
    await source(base())
    await inProject(async () => {
      await expect(run("write", "../conv-1")).rejects.toThrow(ForeignImport.NotFoundError)
    })
  })

  test("creates a session in the source folder with write access", async () => {
    await source(base())
    await inProject(async () => {
      const result = await run("write")
      expect(result).toMatchObject({ outcome: "created" })
      expect(result.folderMissing).toBeUndefined()
      const grants = await grantsFor(folder)
      expect(grants.map((g) => g.access)).toEqual(["write"])
      expect((await SessionFilesystem.state(result.sessionID)).workingRoot).toBe(grants[0].path)
      expect(await texts(result.sessionID)).toEqual(["user:first question", "assistant:first answer"])
      expect((await Session.get(result.sessionID)).title).toBe("first question")
    })
  })

  test("read access grants read and leaves workingRoot automatic", async () => {
    await source(base())
    await inProject(async () => {
      const result = await run("read")
      expect((await grantsFor(folder)).map((g) => g.access)).toEqual(["read"])
      const record = await Storage.read<{ workingRoot?: string }>([
        "session_filesystem",
        Instance.project.id,
        result.sessionID,
      ]).catch((): { workingRoot?: string } => ({}))
      expect(record.workingRoot).toBeUndefined()
    })
  })

  test("missing folder imports into the normal workspace and reports it", async () => {
    await source([user("u1", null, "q", 0, "/definitely/not/here"), reply("a1", "u1", "a", 1)])
    await inProject(async () => {
      const result = await run("write")
      expect(result.folderMissing).toBe(true)
      expect(await texts(result.sessionID)).toEqual(["user:q", "assistant:a"])
    })
  })

  test("re-import appends when the copy was not continued", async () => {
    await source(base())
    await inProject(async () => {
      const first = await run()
      await source([...base(), user("u2", "a1", "second question", 2), reply("a2", "u2", "second answer", 3)])
      const second = await run()
      expect(second).toMatchObject({ sessionID: first.sessionID, outcome: "updated" })
      expect(await texts(first.sessionID)).toEqual([
        "user:first question",
        "assistant:first answer",
        "user:second question",
        "assistant:second answer",
      ])
    })
  })

  test("re-import with nothing new is unchanged", async () => {
    await source(base())
    await inProject(async () => {
      const first = await run()
      expect(await run()).toMatchObject({ sessionID: first.sessionID, outcome: "unchanged" })
    })
  })

  test("re-import copies when the copy was continued", async () => {
    await source(base())
    await inProject(async () => {
      const first = await run()
      const id = await MessageV2.nextMessageID(first.sessionID)
      await Session.updateMessage({
        id,
        sessionID: first.sessionID,
        role: "user",
        time: { created: Date.now() },
        agent: "research",
        model: { providerID: "test", modelID: "m" },
        effort: "normal",
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        sessionID: first.sessionID,
        messageID: id,
        type: "text",
        text: "work in OpenScience",
      })
      await source([...base(), user("u2", "a1", "more in Claude", 2), reply("a2", "u2", "ok", 3)])
      const second = await run()
      expect(second).toMatchObject({ outcome: "copied", reason: "continued" })
      expect(second.sessionID).not.toBe(first.sessionID)
      expect(await texts(second.sessionID)).toEqual([
        "user:first question",
        "assistant:first answer",
        "user:more in Claude",
        "assistant:ok",
      ])
      expect(await texts(first.sessionID)).toContain("user:work in OpenScience")
    })
  })

  test("re-import copies when the source was rewound", async () => {
    const two = [...base(), user("u2", "a1", "old branch", 2), reply("a2", "u2", "old answer", 3)]
    await source(two)
    await inProject(async () => {
      const first = await run()
      await source([...two, user("u2b", "a1", "new branch", 10), reply("a2b", "u2b", "new answer", 11)])
      const second = await run()
      expect(second).toMatchObject({ outcome: "copied", reason: "rewound" })
      expect(await texts(second.sessionID)).toEqual([
        "user:first question",
        "assistant:first answer",
        "user:new branch",
        "assistant:new answer",
      ])
      expect(await texts(first.sessionID)).toContain("user:old branch")
    })
  })

  test("re-import after the source compacted is an update, not a rewind", async () => {
    await source(base())
    await inProject(async () => {
      const first = await run()
      await source([
        ...base(),
        {
          type: "system",
          subtype: "compact_boundary",
          uuid: "b1",
          parentUuid: null,
          logicalParentUuid: "a1",
          timestamp: at(5),
        },
        { ...user("sum", "b1", "Summary so far.", 6), isCompactSummary: true },
        user("u2", "sum", "after compaction", 7),
        reply("a2", "u2", "still here", 8),
      ])
      const second = await run()
      expect(second).toMatchObject({ sessionID: first.sessionID, outcome: "updated" })
      expect(await texts(first.sessionID)).toEqual([
        "user:first question",
        "assistant:first answer",
        "assistant:Summary so far.",
        "user:after compaction",
        "assistant:still here",
      ])
    })
  })

  test("concurrent imports of one session create one copy", async () => {
    await source(base())
    await inProject(async () => {
      const [a, b] = await Promise.all([run(), run()])
      expect(a.sessionID).toBe(b.sessionID)
      expect(await Provenance.findBySource("claude", "conv-1")).toEqual([a.sessionID])
      expect([a.outcome, b.outcome].toSorted()).toEqual(["created", "unchanged"])
    })
  })

  test("an already-connected folder in another form is not granted again", async () => {
    const link = path.join(scratch, "link-to-folder")
    await fs.symlink(folder, link)
    await source([user("u1", null, "q", 0, link + "/"), reply("a1", "u1", "a", 1)])
    await inProject(async () => {
      const before = await SessionFilesystem.connectProject({ path: folder, access: "write" })
      await run("write")
      const grants = await grantsFor(folder)
      expect(grants.map((g) => g.id)).toEqual([before.id])
    })
  })

  test("read never downgrades an existing write grant", async () => {
    await source(base())
    await inProject(async () => {
      const before = await SessionFilesystem.connectProject({ path: folder, access: "write" })
      const result = await run("read")
      const grants = await grantsFor(folder)
      expect(grants.map((g) => [g.id, g.access])).toEqual([[before.id, "write"]])
      expect((await SessionFilesystem.state(result.sessionID)).workingRoot).toBe(before.path)
    })
  })

  test("a deleted imported session is ignored and its provenance removed", async () => {
    await source(base())
    await inProject(async () => {
      const first = await run()
      await Session.remove(first.sessionID)
      expect(await Provenance.read(first.sessionID)).toBeUndefined()
      const second = await run()
      expect(second.outcome).toBe("created")
      expect(second.sessionID).not.toBe(first.sessionID)
    })
  })

  test("an empty conversation is not listed and cannot be imported", async () => {
    const dir = path.join(claudeRoot, "-source-folder")
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(
      path.join(dir, "empty.jsonl"),
      [
        { type: "permission-mode", mode: "default" },
        { type: "system", uuid: "s1", parentUuid: null, cwd: folder },
      ]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    )
    // Too large to read whole while listing, so it is listed; importing it is refused.
    await fs.writeFile(
      path.join(dir, "empty-big.jsonl"),
      JSON.stringify({ type: "file-history-snapshot", snapshot: { blob: "x".repeat(300_000) } }) + "\n",
    )
    await source(base())
    await inProject(async () => {
      const listed = (await ForeignImport.list("claude", claudeRoot)).map((s) => s.id)
      expect(listed).toContain("conv-1")
      expect(listed).not.toContain("empty")
      await expect(run("write", "empty")).rejects.toThrow(ForeignImport.NotFoundError)
      await expect(run("write", "empty-big")).rejects.toThrow(ForeignImport.EmptyError)
      expect(await Provenance.findBySource("claude", "empty-big")).toEqual([])
    })
  })
})

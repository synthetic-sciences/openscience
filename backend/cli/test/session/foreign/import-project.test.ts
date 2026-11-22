import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Identifier } from "../../../src/id/id"
import { Instance } from "../../../src/project/instance"
import { Session } from "../../../src/session"
import { SessionFilesystem } from "../../../src/session/filesystem"
import { ClaudeReader } from "../../../src/session/foreign/claude"
import { ForeignConvert } from "../../../src/session/foreign/convert"
import { ForeignImport } from "../../../src/session/foreign/import"
import { Provenance } from "../../../src/session/foreign/provenance"
import { MessageV2 } from "../../../src/session/message-v2"
import { Log } from "../../../src/util/log"

Log.init({ print: false })

// The OpenScience project is opened from `project`; conversations ran in it,
// in a subfolder of it, in its parent, and in two other folders.
let scratch: string
let project: string
let claudeRoot: string
let codexRoot: string

beforeEach(async () => {
  scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "os-import-project-")))
  project = path.join(scratch, "parent", "project")
  claudeRoot = path.join(scratch, "claude-projects")
  codexRoot = path.join(scratch, "codex-sessions")
  await fs.mkdir(path.join(project, "sub"), { recursive: true })
  await fs.mkdir(path.join(scratch, "readonly"), { recursive: true })
  await fs.mkdir(path.join(scratch, "writable"), { recursive: true })
})
afterEach(async () => {
  await fs.rm(scratch, { recursive: true, force: true })
})

const t0 = Date.parse("2026-11-01T10:00:00Z")
const at = (s: number) => new Date(t0 + s * 1000).toISOString()
type Rec = Record<string, unknown>
const user = (uuid: string, parent: string | null, text: string, s: number, cwd: string): Rec => ({
  type: "user",
  uuid,
  parentUuid: parent,
  cwd,
  timestamp: at(s),
  message: { role: "user", content: text },
})
const reply = (uuid: string, parent: string, text: string, s: number, cwd: string): Rec => ({
  type: "assistant",
  uuid,
  parentUuid: parent,
  cwd,
  timestamp: at(s),
  message: {
    id: `msg_${uuid}`,
    role: "assistant",
    model: "claude-sonnet-5",
    content: [{ type: "text", text }],
    stop_reason: "end_turn",
  },
})

/** A finished Claude Code conversation in `cwd`, with `turns` question/answer pairs. */
async function claude(id: string, cwd: string, turns = 1, modifiedAgo = 3600) {
  const dir = path.join(claudeRoot, "-slug")
  await fs.mkdir(dir, { recursive: true })
  const records: Rec[] = []
  for (let i = 0; i < turns; i++) {
    records.push(user(`u${i}`, i ? `a${i - 1}` : null, `${id} question ${i}`, i * 2, cwd))
    records.push(reply(`a${i}`, `u${i}`, `${id} answer ${i}`, i * 2 + 1, cwd))
  }
  const file = path.join(dir, `${id}.jsonl`)
  await fs.writeFile(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  const when = new Date(Date.now() - modifiedAgo * 1000)
  await fs.utimes(file, when, when)
}

async function codex(id: string, cwd: string) {
  const dir = path.join(codexRoot, "2026", "11", "02")
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `rollout-2026-11-02T09-00-00-${id}.jsonl`)
  const records = [
    { timestamp: at(0), type: "session_meta", payload: { id, cwd } },
    { timestamp: at(1), type: "event_msg", payload: { type: "user_message", message: `${id} question` } },
    {
      timestamp: at(2),
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: `${id} answer` }] },
    },
  ]
  await fs.writeFile(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  const when = new Date(Date.now() - 3600_000)
  await fs.utimes(file, when, when)
}

const roots = () => ({ claude: [claudeRoot], codex: [codexRoot] })
const runProject = (sources?: Array<"claude" | "codex">) => ForeignImport.runProject({ sources, roots: roots() })
const inProject = <T>(fn: () => Promise<T>) => Instance.provide({ directory: project, fn })
const byID = (result: Awaited<ReturnType<typeof runProject>>) =>
  Object.fromEntries(result.results.map((item) => [item.sourceID, item]))

async function continueInOpenScience(sessionID: string) {
  const id = await MessageV2.nextMessageID(sessionID)
  await Session.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "research",
    model: { providerID: "test", modelID: "m" },
    effort: "normal",
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID,
    messageID: id,
    type: "text",
    text: "work here",
  })
}

describe("ForeignImport.runProject", () => {
  test("the project's own folder counts and only exact folders match", async () => {
    await claude("own", project)
    await claude("sub", path.join(project, "sub"))
    await claude("parent", path.dirname(project))
    await inProject(async () => {
      const result = await runProject()
      expect(result.results.map((item) => item.sourceID)).toEqual(["own"])
      expect(result.counts.created).toBe(1)
      const session = await Session.get(result.results[0].sessionID!)
      expect(session.title).toBe("own question 0")
    })
  })

  test("matches across both tools, and a source filter limits it", async () => {
    await claude("c1", project)
    await codex("x1", project)
    await inProject(async () => {
      expect(
        (await ForeignImport.runProject({ sources: ["codex"], roots: roots() })).results.map((r) => r.sourceID),
      ).toEqual(["x1"])
      const both = await runProject()
      expect(both.results.map((r) => `${r.source}:${r.sourceID}:${r.outcome}`).toSorted()).toEqual([
        "claude:c1:created",
        "codex:x1:unchanged",
      ])
    })
  })

  test("connected folders: write works there, read-only works in scratch, never re-granted", async () => {
    const readonly = path.join(scratch, "readonly")
    const writable = path.join(scratch, "writable")
    await claude("ro", readonly)
    await claude("rw", writable)
    await claude("own", project)
    await inProject(async () => {
      await SessionFilesystem.connectProject({ path: readonly, access: "read" })
      const write = await SessionFilesystem.connectProject({ path: writable, access: "write" })
      const before = (await SessionFilesystem.projectSnapshot()).grants.filter((g) => !g.time.revoked).length
      const result = byID(await runProject())
      expect((await SessionFilesystem.state(result.rw.sessionID!)).workingRoot).toBe(write.path)
      expect((await SessionFilesystem.state(result.ro.sessionID!)).workingRoot).toBe("scratch")
      const own = await import("../../../src/storage/storage").then(({ Storage }) =>
        Storage.read<{ workingRoot?: string }>([
          "session_filesystem",
          Instance.project.id,
          result.own.sessionID!,
        ]).catch((): { workingRoot?: string } => ({})),
      )
      expect(own.workingRoot).toBeUndefined()
      expect((await SessionFilesystem.projectSnapshot()).grants.filter((g) => !g.time.revoked).length).toBe(before)
    })
  })

  test("one folder connected twice in different forms matches each conversation once", async () => {
    await claude("own", project + "/")
    await inProject(async () => {
      await SessionFilesystem.connectProject({ path: project, access: "write" })
      const result = await runProject()
      expect(result.results.map((r) => r.sourceID)).toEqual(["own"])
    })
  })

  test("refresh updates, copies, adds and leaves continued-but-unchanged alone", async () => {
    await claude("grows", project)
    await claude("diverges", project)
    await claude("continued", project)
    await claude("same", project)
    await inProject(async () => {
      const first = byID(await runProject())
      await continueInOpenScience(first.diverges.sessionID!)
      await continueInOpenScience(first.continued.sessionID!)
      await claude("grows", project, 2)
      await claude("diverges", project, 2)
      await claude("fresh", project)
      const second = byID(await runProject())
      expect(second.grows).toMatchObject({ outcome: "updated", sessionID: first.grows.sessionID })
      expect(second.diverges).toMatchObject({ outcome: "copied", reason: "continued" })
      expect(second.diverges.title).toBe("diverges question 0")
      expect((await Session.get(second.diverges.sessionID!)).title).toBe("diverges question 0 (import #2)")
      expect(second.continued).toMatchObject({ outcome: "unchanged", sessionID: first.continued.sessionID })
      expect(second.same.outcome).toBe("unchanged")
      expect(second.fresh.outcome).toBe("created")
    })
  })

  test("skips conversations whose imports were deleted", async () => {
    await claude("gone", project)
    await claude("kept", project)
    await inProject(async () => {
      const first = byID(await runProject())
      await Session.remove(first.gone.sessionID!)
      const second = byID(await runProject())
      expect(second.gone.outcome).toBe("skipped")
      expect(second.kept.outcome).toBe("unchanged")
      expect(await Provenance.findBySource("claude", "gone")).toEqual([])
      // An explicit single import still brings it back.
      const single = await ForeignImport.run({
        source: "claude",
        sourceID: "gone",
        folderAccess: "none",
        root: claudeRoot,
      })
      expect(single.outcome).toBe("created")
    })
  })

  test("one failing conversation does not stop the rest", async () => {
    await claude("a", project, 1, 7200)
    await claude("b", project)
    await inProject(async () => {
      const spy = spyOn(ForeignConvert, "write").mockImplementationOnce(async () => {
        throw new Error("disk full")
      })
      const result = byID(await runProject())
      spy.mockRestore()
      expect(result.a).toMatchObject({ outcome: "failed", error: "disk full" })
      expect(result.b.outcome).toBe("created")
      expect(await Provenance.findBySource("claude", "a")).toEqual([])
    })
  })

  test("lists each reader once", async () => {
    for (const id of ["m1", "m2", "m3"]) await claude(id, project)
    await claude("elsewhere", path.join(scratch, "writable"))
    await inProject(async () => {
      const stats = ClaudeReader.readStats()
      stats.bytes = 0
      await ClaudeReader.create(claudeRoot).list()
      const once = stats.bytes
      stats.bytes = 0
      await ForeignImport.runProject({ sources: ["claude"], roots: roots() })
      expect(stats.bytes).toBe(once)
    })
  })

  test("a refresh racing a single import of the same conversation makes one session", async () => {
    await claude("race", project)
    await inProject(async () => {
      await Promise.all([
        runProject(["claude"]),
        ForeignImport.run({ source: "claude", sourceID: "race", folderAccess: "none", root: claudeRoot }),
      ])
      expect(await Provenance.findBySource("claude", "race")).toHaveLength(1)
    })
  })

  test("a conversation whose first message is beyond the listed bytes is titled from it", async () => {
    const id = "late-title"
    const dir = path.join(codexRoot, "2026", "11", "03")
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, `rollout-2026-11-03T09-00-00-${id}.jsonl`)
    const records = [
      { timestamp: at(0), type: "session_meta", payload: { id, cwd: project } },
      { timestamp: at(0), type: "turn_context", payload: { model: "gpt-6-codex", note: "n".repeat(90_000) } },
      { timestamp: at(1), type: "event_msg", payload: { type: "user_message", message: "Tune the learning rate" } },
      {
        timestamp: at(2),
        type: "response_item",
        payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "x".repeat(90_000) }] },
      },
    ]
    await fs.writeFile(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n")
    const when = new Date(Date.now() - 3600_000)
    await fs.utimes(file, when, when)
    await inProject(async () => {
      const result = byID(await runProject(["codex"]))
      expect(result[id].title).toBe("Tune the learning rate")
      expect((await Session.get(result[id].sessionID!)).title).toBe("Tune the learning rate")
    })
  })

  test("a failed conversation is imported on the next refresh, not skipped", async () => {
    await claude("flaky", project)
    await inProject(async () => {
      const spy = spyOn(ForeignConvert, "write").mockImplementationOnce(async () => {
        throw new Error("disk full")
      })
      expect(byID(await runProject()).flaky.outcome).toBe("failed")
      spy.mockRestore()
      const again = byID(await runProject())
      expect(again.flaky.outcome).toBe("created")
      expect((await Session.get(again.flaky.sessionID!)).title).toBe("flaky question 0")
    })
  })

  test("a refresh reads the import records once, not once per conversation", async () => {
    for (const id of ["r1", "r2", "r3", "r4"]) await claude(id, project)
    await inProject(async () => {
      await runProject()
      const scans = spyOn(Provenance, "findBySource")
      await runProject()
      expect(scans).toHaveBeenCalledTimes(0)
      scans.mockRestore()
    })
  })

  test("a whitespace-only first message never gives an empty title", async () => {
    const dir = path.join(claudeRoot, "-slug")
    await fs.mkdir(dir, { recursive: true })
    const file = path.join(dir, "blank.jsonl")
    await fs.writeFile(
      file,
      [user("u0", null, "   ", 0, project), reply("a0", "u0", "hello", 1, project)]
        .map((r) => JSON.stringify(r))
        .join("\n") + "\n",
    )
    const when = new Date(Date.now() - 3600_000)
    await fs.utimes(file, when, when)
    await inProject(async () => {
      const result = byID(await runProject())
      expect(result.blank.title).toBe("Imported conversation")
      expect((await Session.get(result.blank.sessionID!)).title).toBe("Imported conversation")
    })
  })
})

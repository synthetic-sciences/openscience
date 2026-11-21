import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { CodexReader } from "../../../src/session/foreign/codex"
import { isCompaction, type ForeignConversation, type ForeignTurn } from "../../../src/session/foreign/types"

// Synthetic Codex rollouts. Record shapes follow real Codex files:
// session_meta, turn_context, response_item, event_msg and compacted.
let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "os-codex-import-"))
})
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

const t0 = Date.parse("2026-11-02T09:00:00Z")
const at = (seconds: number) => new Date(t0 + seconds * 1000).toISOString()
const rec = (type: string, payload: Record<string, unknown>, seconds: number) => ({
  timestamp: at(seconds),
  type,
  payload,
})
const meta = (id: string, seconds = 0) =>
  rec("session_meta", { id, cwd: "/work/codex-proj", timestamp: at(seconds) }, seconds)
const ctx = (seconds: number) => rec("turn_context", { model: "gpt-6-codex" }, seconds)
const typed = (text: string, seconds: number) => rec("event_msg", { type: "user_message", message: text }, seconds)
const injected = (text: string, seconds: number) =>
  rec("response_item", { type: "message", role: "user", content: [{ type: "input_text", text }] }, seconds)
const said = (text: string, seconds: number) =>
  rec("response_item", { type: "message", role: "assistant", content: [{ type: "output_text", text }] }, seconds)
const thought = (text: string, seconds: number) =>
  rec(
    "response_item",
    { type: "reasoning", summary: [{ type: "summary_text", text }], encrypted_content: "enc" },
    seconds,
  )
const call = (id: string, name: string, args: Record<string, unknown>, seconds: number) =>
  rec("response_item", { type: "function_call", call_id: id, name, arguments: JSON.stringify(args) }, seconds)
const output = (id: string, out: string, seconds: number) =>
  rec("response_item", { type: "function_call_output", call_id: id, output: out }, seconds)

async function write(day: string, id: string, records: unknown[], tail = "") {
  const dir = path.join(root, ...day.split("/"))
  await fs.mkdir(dir, { recursive: true })
  const file = path.join(dir, `rollout-${day.replaceAll("/", "-")}T09-00-00-${id}.jsonl`)
  await fs.writeFile(file, records.map((r) => JSON.stringify(r)).join("\n") + "\n" + tail)
  return file
}
async function load(id: string): Promise<ForeignConversation> {
  const reader = CodexReader.create(root)
  const info = (await reader.list()).find((item) => item.id === id)
  if (!info) throw new Error(`fixture ${id} not listed`)
  return reader.load(info)
}
const turns = (c: ForeignConversation) => c.entries.filter((e): e is ForeignTurn => !isCompaction(e))
const texts = (c: ForeignConversation) =>
  turns(c).map(
    (t) =>
      `${t.role}:${t.parts
        .filter((p) => p.type === "text")
        .map((p) => (p as { text: string }).text)
        .join("|")}`,
  )

const basic = (id: string, start = 0) => [
  meta(id, start),
  ctx(start + 1),
  injected("<environment_context>\n<cwd>/work/codex-proj</cwd>\n</environment_context>", start + 1),
  injected("fix the parser", start + 2),
  typed("fix the parser", start + 2),
  thought("look at parser.ts", start + 3),
  call("call_1", "shell", { command: ["cat", "parser.ts"] }, start + 4),
  output("call_1", "export const x = 1", start + 5),
  said("Fixed it.", start + 6),
]

describe("CodexReader", () => {
  test("lists rollouts under YYYY/MM/DD newest first", async () => {
    await write(
      "2026/11/01",
      "aaaaaaaa-0000-0000-0000-000000000001",
      basic("aaaaaaaa-0000-0000-0000-000000000001", -86400),
    )
    await write("2026/11/02", "bbbbbbbb-0000-0000-0000-000000000002", basic("bbbbbbbb-0000-0000-0000-000000000002"))
    const older = path.join(root, "2026", "11", "01")
    const file = (await fs.readdir(older))[0]
    await fs.utimes(path.join(older, file), new Date(t0 - 86400_000), new Date(t0 - 86400_000))
    const list = await CodexReader.create(root).list()
    expect(list.map((s) => s.id)).toEqual([
      "bbbbbbbb-0000-0000-0000-000000000002",
      "aaaaaaaa-0000-0000-0000-000000000001",
    ])
    expect(list[0]).toMatchObject({ source: "codex", cwd: "/work/codex-proj", firstMessage: "fix the parser" })
  })

  test("maps messages, function calls and outputs, reasoning", async () => {
    await write("2026/11/02", "cccccccc-0000-0000-0000-000000000003", basic("cccccccc-0000-0000-0000-000000000003"))
    const c = await load("cccccccc-0000-0000-0000-000000000003")
    expect(texts(c)).toEqual(["user:fix the parser", "assistant:Fixed it."])
    const reply = turns(c)[1]
    expect(reply.model).toBe("gpt-6-codex")
    expect(reply.parts.map((p) => p.type)).toEqual(["reasoning", "tool", "text"])
    expect(reply.parts[1]).toMatchObject({
      type: "tool",
      callID: "call_1",
      name: "shell",
      input: { command: ["cat", "parser.ts"] },
      output: "export const x = 1",
    })
    expect(JSON.stringify(c.entries)).not.toContain("environment_context")
  })

  test("keeps an encrypted compaction item", async () => {
    const id = "dddddddd-0000-0000-0000-000000000004"
    await write("2026/11/02", id, [
      ...basic(id),
      rec(
        "compacted",
        {
          message: "",
          replacement_history: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "fix the parser" }] },
            { type: "compaction", encrypted_content: "ENCRYPTED-HISTORY" },
          ],
        },
        20,
      ),
      typed("now add tests", 21),
      said("Added tests.", 22),
    ])
    const c = await load(id)
    const compaction = c.entries.find(isCompaction)!
    expect(compaction.summary.startsWith("Context compacted by Codex.")).toBe(true)
    expect(compaction.codex?.item).toEqual({ type: "compaction", encrypted_content: "ENCRYPTED-HISTORY" })
    expect(compaction.codex?.keptUserMessages).toEqual(["fix the parser"])
    expect(c.entries.map((e) => (isCompaction(e) ? "compaction" : e.role))).toEqual([
      "user",
      "assistant",
      "compaction",
      "user",
      "assistant",
    ])
  })

  test("uses a readable compaction summary when present", async () => {
    const id = "eeeeeeee-0000-0000-0000-000000000005"
    await write("2026/11/02", id, [
      ...basic(id),
      rec("compacted", { message: "The parser was fixed.", replacement_history: [] }, 20),
    ])
    const compaction = (await load(id)).entries.find(isCompaction)!
    expect(compaction.summary).toBe("The parser was fixed.")
  })

  test("carries the plaintext user messages from replacement_history into the compaction summary", async () => {
    const id = "ffffffff-0000-0000-0000-000000000006"
    await write("2026/11/02", id, [
      ...basic(id),
      rec(
        "compacted",
        {
          message: "",
          replacement_history: [
            { type: "message", role: "user", content: [{ type: "input_text", text: "fix the parser" }] },
            { type: "message", role: "user", content: [{ type: "input_text", text: "and keep the API stable" }] },
            { type: "compaction", encrypted_content: "ENC" },
          ],
        },
        20,
      ),
    ])
    const compaction = (await load(id)).entries.find(isCompaction)!
    expect(compaction.summary).toContain("fix the parser")
    expect(compaction.summary).toContain("and keep the API stable")
  })

  test("skips event_msg UI records, injected context and a half-written last line", async () => {
    const id = "11111111-0000-0000-0000-000000000007"
    await write(
      "2026/11/02",
      id,
      [
        ...basic(id),
        rec("event_msg", { type: "token_count", info: {} }, 7),
        rec("event_msg", { type: "agent_message", message: "Fixed it." }, 6),
      ],
      '{"timestamp":"2026-11-02T09:00:30Z","type":"response_item","payload":{"type":"mess',
    )
    const c = await load(id)
    expect(texts(c)).toEqual(["user:fix the parser", "assistant:Fixed it."])
  })

  test("gives every entry a stable synthetic id", async () => {
    const id = "22222222-0000-0000-0000-000000000008"
    await write("2026/11/02", id, basic(id))
    const first = await load(id)
    const second = await load(id)
    expect(first.branchIDs).toEqual(second.branchIDs)
    expect(first.branchIDs.every((value) => value.startsWith("codex:"))).toBe(true)
    expect(first.branchIDs).toContain("codex:7:call_1")
    expect(turns(first)[1].sourceID).toBe("codex:9")
  })

  test("applies thread_rolled_back", async () => {
    const id = "33333333-0000-0000-0000-000000000009"
    await write("2026/11/02", id, [
      ...basic(id),
      typed("try a risky change", 10),
      said("Risky change made.", 11),
      rec("event_msg", { type: "thread_rolled_back", num_turns: 1 }, 12),
      typed("do the safe change", 13),
      said("Safe change made.", 14),
    ])
    const c = await load(id)
    expect(texts(c)).toEqual([
      "user:fix the parser",
      "assistant:Fixed it.",
      "user:do the safe change",
      "assistant:Safe change made.",
    ])
    expect(c.branchIDs).not.toContain("codex:11")
    expect(c.branchIDs).not.toContain("codex:12")
  })

  test("skips a trailing incomplete turn", async () => {
    const id = "44444444-0000-0000-0000-000000000010"
    await write("2026/11/02", id, [
      ...basic(id),
      typed("run the tests", 10),
      call("call_2", "shell", { command: ["bun", "test"] }, 11),
    ])
    const c = await load(id)
    expect(texts(c)).toEqual(["user:fix the parser", "assistant:Fixed it.", "user:run the tests"])
  })

  test("a reply that ends in text closes the assistant turn", async () => {
    const id = "55555555-0000-0000-0000-000000000011"
    await write("2026/11/02", id, [
      ...basic(id),
      call("call_2", "shell", { command: ["ls"] }, 10),
      output("call_2", "a b", 11),
      said("Listed.", 12),
    ])
    const c = await load(id)
    expect(turns(c).map((t) => t.role)).toEqual(["user", "assistant", "assistant"])
    expect(turns(c)[1].sourceID).toBe("codex:9")
  })

  test("skips a trailing turn that does not end in text", async () => {
    const id = "66666666-0000-0000-0000-000000000012"
    await write("2026/11/02", id, [
      ...basic(id),
      typed("list files", 10),
      call("call_2", "shell", { command: ["ls"] }, 11),
      output("call_2", "a b", 12),
    ])
    const c = await load(id)
    expect(texts(c)).toEqual(["user:fix the parser", "assistant:Fixed it.", "user:list files"])
  })
})

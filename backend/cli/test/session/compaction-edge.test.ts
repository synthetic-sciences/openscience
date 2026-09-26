import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { Bus } from "../../src/bus"
import type { Config } from "../../src/config/config"
import { HarnessState } from "../../src/harness/state"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { Session } from "../../src/session"
import { resolveAccessRoute } from "../../src/session/access-route"
import { SessionCompaction } from "../../src/session/compaction"
import { SessionLoopState } from "../../src/session/loop-state"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir, trustProject } from "../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

afterEach(() => HarnessState.reset())

const MODEL = { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL }
const CAP_MARKER = "characters of this result omitted for the handoff"
const encoder = new TextEncoder()

// A 1x1 PNG. Distinct figures are the same PNG with a different trailing byte:
// only the base64 identity and byte size matter to the media budget.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
)
const figure = (tag: string) => Buffer.concat([PNG, Buffer.from(`figure:${tag}`)])
const base64 = (buffer: Buffer) => buffer.toString("base64")

// ---------------------------------------------------------------------------
// Loopback provider. Every test hands it a policy; the fixture records each
// request with its classification and the status it answered.
// ---------------------------------------------------------------------------

type Kind = "main" | "summary"
type Recorded = { kind: Kind; body: string; bytes: number; status: number }
type PolicyInput = {
  kind: Kind
  body: string
  bytes: number
  /** Earlier requests of each kind, so a policy can answer by position. */
  prior: { mains: Recorded[]; summaries: Recorded[]; all: Recorded[] }
}
type Policy = (input: PolicyInput) => Response

function chunk(delta: Record<string, unknown>, finish: string | null) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-edge",
    object: "chat.completion.chunk",
    created: 1,
    model: STRESS_PROVIDER_MODEL,
    choices: [{ index: 0, delta: finish ? {} : delta, finish_reason: finish }],
    ...(finish ? { usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } } : {}),
  })}\n\n`
}

function sse(body: string | ReadableStream<Uint8Array>) {
  return new Response(body, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache" } })
}

function reply(text: string) {
  return sse(`${chunk({ role: "assistant", content: text }, null)}${chunk({}, "stop")}data: [DONE]\n\n`)
}

function toolCall(name: string, args: Record<string, unknown>, id: string) {
  return sse(
    `${chunk(
      {
        role: "assistant",
        tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
      null,
    )}${chunk({}, "tool_calls")}data: [DONE]\n\n`,
  )
}

/** What an edge proxy returns when the serialized body is past its limit. */
function tooLarge() {
  return new Response("<html><body><h1>413 Request Entity Too Large</h1></body></html>", {
    status: 413,
    headers: { "content-type": "text/html" },
  })
}

/** Opens the stream, sends an empty first delta and never finishes. */
function stalled(open: WritableStreamDefaultWriter<Uint8Array>[]) {
  const pipe = new TransformStream<Uint8Array, Uint8Array>()
  const writer = pipe.writable.getWriter()
  open.push(writer)
  void writer.write(encoder.encode(chunk({ role: "assistant", content: "" }, null))).catch(() => undefined)
  return sse(pipe.readable)
}

/** Title/summary side requests never touch the conversation under test. */
function side(body: string) {
  return body.includes("The following is the text to summarize:") || body.includes("title generator")
}

function classify(body: string): Kind {
  return body.includes("Output exactly this Markdown structure") ||
    body.includes("You are UPDATING an existing handoff")
    ? "summary"
    : "main"
}

function fixture(policy: Policy) {
  const requests: Recorded[] = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      if (request.method !== "POST" || new URL(request.url).pathname !== "/v1/chat/completions")
        return new Response("not found", { status: 404 })
      const body = await request.text()
      if (side(body)) return reply("Fixture title")
      const kind = classify(body)
      const prior = {
        mains: requests.filter((item) => item.kind === "main"),
        summaries: requests.filter((item) => item.kind === "summary"),
        all: [...requests],
      }
      const response = policy({ kind, body, bytes: Buffer.byteLength(body), prior })
      requests.push({ kind, body, bytes: Buffer.byteLength(body), status: response.status })
      return response
    },
  })
  return {
    server,
    requests,
    url: `http://127.0.0.1:${server.port}/v1`,
    mains: () => requests.filter((item) => item.kind === "main"),
    summaries: () => requests.filter((item) => item.kind === "summary"),
    statuses: () => requests.map((item) => [item.kind, item.status] as const),
    stop: () => server.stop(true),
  }
}

async function withProject<T>(input: {
  config: Partial<Config.Info>
  files?: Record<string, string | Uint8Array>
  fn: (root: string) => Promise<T>
}) {
  await using tmp = await tmpdir({
    git: true,
    config: input.config,
    init: async (dir) => {
      for (const [name, contents] of Object.entries(input.files ?? {})) {
        await Bun.write(path.join(dir, name), contents)
      }
    },
  })
  // `await using` disposes at scope exit: the body must settle before then.
  return await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await trustProject()
      await Provider.invalidate()
    },
    fn: () => input.fn(tmp.path),
  })
}

// ---------------------------------------------------------------------------
// Transcript builders: durable records shaped the way SessionPrompt writes
// them (typed prompts carry their epoch), so the loop treats them as its own.
// ---------------------------------------------------------------------------

async function typed(sessionID: string, text: string) {
  const id = await MessageV2.nextMessageID(sessionID)
  const info = await Session.updateMessage({
    id,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "research",
    model: MODEL,
    effort: "normal",
    internal: SessionLoopState.prompt(id),
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: id,
    sessionID,
    type: "text",
    text,
    time: { start: Date.now(), end: Date.now() },
  })
  return info as MessageV2.User
}

type ToolSpec = {
  tool: string
  output: string
  input?: Record<string, unknown>
  attachments?: { filename: string; data: Buffer }[]
}

async function replied(
  sessionID: string,
  parentID: string,
  input: { finish: "stop" | "tool-calls"; text?: string; tools?: ToolSpec[] },
) {
  const id = await MessageV2.nextMessageID(sessionID)
  const now = Date.now()
  const info = await Session.updateMessage({
    id,
    sessionID,
    parentID,
    role: "assistant",
    time: { created: now, completed: now },
    mode: "research",
    agent: "research",
    path: { cwd: Instance.directory, root: Instance.worktree },
    cost: 0,
    tokens: { input: 12, output: 3, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: MODEL.modelID,
    providerID: MODEL.providerID,
    finish: input.finish,
  })
  for (const [index, spec] of (input.tools ?? []).entries()) {
    await Session.updatePart({
      id: Identifier.ascending("part"),
      sessionID,
      messageID: id,
      type: "tool",
      tool: spec.tool,
      callID: `call_${id}_${index}`,
      state: {
        status: "completed",
        input: spec.input ?? {},
        output: spec.output,
        title: spec.tool,
        metadata: {},
        time: { start: now - 2, end: now - 1 },
        ...(spec.attachments
          ? {
              attachments: spec.attachments.map((attachment) => ({
                id: Identifier.ascending("part"),
                sessionID,
                messageID: id,
                type: "file" as const,
                mime: "image/png",
                filename: attachment.filename,
                url: `data:image/png;base64,${base64(attachment.data)}`,
              })),
            }
          : {}),
      },
    })
  }
  if (input.text)
    await Session.updatePart({
      id: Identifier.ascending("part"),
      messageID: id,
      sessionID,
      type: "text",
      text: input.text,
      time: { start: now, end: now },
    })
  await Session.flushPendingParts(sessionID)
  return info as MessageV2.Assistant
}

const summaries = (messages: MessageV2.WithParts[]) =>
  messages.filter(
    (message): message is MessageV2.WithParts & { info: MessageV2.Assistant } =>
      message.info.role === "assistant" && message.info.summary === true,
  )
const text = (message: MessageV2.WithParts) =>
  message.parts
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim()
const errors = (messages: MessageV2.WithParts[]) =>
  messages.flatMap((message) =>
    message.info.role === "assistant" && message.info.error ? [message.info.error.data.message as string] : [],
  )

async function until<T>(read: () => Promise<T | undefined>, what: string, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = await read()
    if (value !== undefined) return value
    await Bun.sleep(20)
  }
  throw new Error(`timed out waiting for ${what}`)
}

/** The transcript of case 1/2/7: one answered turn whose tool result is long
 * enough for the reduced-fidelity cap to bite (> REDUCED_TOOL_OUTPUT_CHARS). */
const MIDDLE = "MIDDLE_OF_LONG_TOOL_OUTPUT_MARKER"
const LONG_OUTPUT = `${"A".repeat(3_000)}${MIDDLE}${"Z".repeat(3_000)}`
const QUESTION = "EDGE_QUESTION: which marker did the earlier tool print?"

async function longToolHistory(sessionID: string) {
  const first = await typed(sessionID, "Run the long tool and keep its output.")
  // The shape the processor writes: the step that called the tool ends in
  // "tool-calls" and the answer is a later step. A "stop" step that carries a
  // local tool result is still an open turn to the loop (isContinuingTurn).
  await replied(sessionID, first.id, {
    finish: "tool-calls",
    tools: [{ tool: "bash", input: { command: "cat big.log" }, output: LONG_OUTPUT }],
  })
  await replied(sessionID, first.id, { finish: "stop", text: "The tool ran; its output is above." })
  return first
}

describe("compaction edge cases", () => {
  test("1. summarizer overflows twice: one too-large error, the request preserved, the retry capped", async () => {
    const provider = fixture(() => tooLarge())
    try {
      await withProject({
        config: {
          ...stressProviderConfig(provider.url),
          compaction: { tailTurns: 1, tailTokens: 8_000 },
        },
        fn: async () => {
          const session = await Session.create({ title: "Summarizer overflows twice" })
          await longToolHistory(session.id)
          const result = await SessionPrompt.prompt({
            sessionID: session.id,
            model: MODEL,
            agent: "research",
            parts: [{ type: "text", text: QUESTION }],
          })
          // The conversation request, then exactly two summarizer attempts:
          // the full one and the reduced one. Nothing is retried past that.
          expect(provider.statuses()).toEqual([
            ["main", 413],
            ["summary", 413],
            ["summary", 413],
          ])
          const [full, reduced] = provider.summaries()
          expect(full.body).toContain(MIDDLE)
          expect(full.body).not.toContain(CAP_MARKER)
          expect(reduced.body).not.toContain(MIDDLE)
          expect(reduced.body).toContain(CAP_MARKER)
          expect(reduced.body).toContain("A".repeat(1_000))
          expect(reduced.body).toContain("Z".repeat(300))
          expect(reduced.bytes).toBeLessThan(full.bytes)

          const messages = await Session.messages({ sessionID: session.id })
          const request = messages.find((message) => text(message) === QUESTION)
          expect(request?.info.role).toBe("user")
          if (result.info.role !== "assistant") throw new Error("expected an assistant result")
          expect(result.info.parentID).toBe(request!.info.id)
          expect(result.info.error?.data.message).toContain("assembled conversation")
          expect(errors(messages).filter((message) => message.includes("assembled conversation"))).toHaveLength(1)
          expect(errors(messages)).toHaveLength(1)
          // The context the next prompt would see still holds the history
          // and the question: nothing was replaced by an empty summary.
          const view = await MessageV2.filterCompacted(MessageV2.stream(session.id))
          expect(view.some((message) => text(message) === QUESTION)).toBe(true)
          expect(
            view.some((message) =>
              message.parts.some(
                (part) =>
                  part.type === "tool" && part.state.status === "completed" && part.state.output === LONG_OUTPUT,
              ),
            ),
          ).toBe(true)
          // Neither attempt produced a summary, so neither leaves a record: a
          // text-less summary message would only confuse a reader.
          expect(summaries(messages)).toHaveLength(0)
          expect(SessionCompaction.previousSummary(messages)).toBeUndefined()
          expect(SessionLoopState.pendingCompaction(messages)).toBeUndefined()
        },
      })
    } finally {
      provider.stop()
    }
  }, 30_000)

  test("2. summarizer succeeds only at reduced fidelity: the turn completes and no orphan attempt remains", async () => {
    const HANDOFF = "REDUCED_HANDOFF: the earlier tool printed a long A/Z block; answer the marker question."
    const provider = fixture(({ kind, body, prior }) => {
      if (kind === "summary") return prior.summaries.length === 0 ? tooLarge() : reply(HANDOFF)
      return body.includes(HANDOFF) ? reply("EDGE_ANSWER_TWO") : tooLarge()
    })
    try {
      await withProject({
        config: {
          ...stressProviderConfig(provider.url),
          compaction: { tailTurns: 1, tailTokens: 8_000 },
        },
        fn: async () => {
          const session = await Session.create({ title: "Reduced summary succeeds" })
          await longToolHistory(session.id)
          const result = await SessionPrompt.prompt({
            sessionID: session.id,
            model: MODEL,
            agent: "research",
            parts: [{ type: "text", text: QUESTION }],
          })
          expect(provider.statuses()).toEqual([
            ["main", 413],
            ["summary", 413],
            ["summary", 200],
            ["main", 200],
          ])
          const [full, reduced] = provider.summaries()
          expect(full.body).toContain(MIDDLE)
          expect(reduced.body).not.toContain(MIDDLE)
          expect(reduced.body).toContain(CAP_MARKER)

          if (result.info.role !== "assistant") throw new Error("expected an assistant result")
          expect(result.info.error).toBeUndefined()
          expect(result.info.time.completed).toBeDefined()
          expect(text(result)).toBe("EDGE_ANSWER_TWO")

          const messages = await Session.messages({ sessionID: session.id })
          const stored = summaries(messages)
          // One summary record: the reduced attempt. The overflowed full
          // attempt was removed, not left as an errored/finish-compact orphan.
          expect(stored).toHaveLength(1)
          expect(text(stored[0])).toBe(HANDOFF)
          expect(stored[0].info.finish).toBe("stop")
          expect(stored[0].info.error).toBeUndefined()
          const request = messages.find((message) => text(message) === QUESTION)!
          expect(stored[0].info.tailStartId).toBe(request.info.id)
          expect(errors(messages)).toEqual([])
          expect(SessionCompaction.previousSummary(messages)).toBe(HANDOFF)

          // The resumed request works from the handoff plus the verbatim
          // tail (the question), not from the summarized tool output.
          const resumed = provider.mains().at(-1)!
          expect(resumed.body).toContain(HANDOFF)
          expect(resumed.body).toContain(QUESTION)
          expect(resumed.body).not.toContain(MIDDLE)
          expect(resumed.bytes).toBeLessThan(provider.mains()[0].bytes)
          const view = await MessageV2.filterCompacted(MessageV2.stream(session.id))
          expect(view.filter((message) => message.info.role === "assistant" && message.info.summary)).toHaveLength(1)
          expect(view.some((message) => text(message) === QUESTION)).toBe(true)
        },
      })
    } finally {
      provider.stop()
    }
  }, 30_000)

  test("2b. an empty handoff is a terminal compaction failure, not a reduced-fidelity retry", async () => {
    const provider = fixture(({ kind, body }) => {
      if (kind === "summary") return reply("   ")
      return body.includes("EDGE_FOLLOWUP_2B") ? reply("EDGE_ANSWER_2B") : tooLarge()
    })
    try {
      await withProject({
        config: {
          ...stressProviderConfig(provider.url),
          compaction: { tailTurns: 1, tailTokens: 8_000 },
        },
        fn: async () => {
          const session = await Session.create({ title: "Empty handoff" })
          await longToolHistory(session.id)
          const result = await SessionPrompt.prompt({
            sessionID: session.id,
            model: MODEL,
            agent: "research",
            parts: [{ type: "text", text: QUESTION }],
          })
          // The reduced attempt exists for an overflowed summarizer only; a
          // model that returns nothing ends the turn with one clear error.
          expect(provider.statuses()).toEqual([
            ["main", 413],
            ["summary", 200],
          ])
          if (result.info.role !== "assistant") throw new Error("expected an assistant result")
          expect(result.info.summary).toBe(true)
          expect(result.info.error?.data.message).toContain("without producing a usable summary")
          expect(result.info.error?.data.message).toContain("preserved the original context")
          const messages = await Session.messages({ sessionID: session.id })
          expect(errors(messages)).toHaveLength(1)
          expect(SessionCompaction.previousSummary(messages)).toBeUndefined()
          expect(SessionLoopState.pendingCompaction(messages)).toBeUndefined()
          // Not a boundary: the history and the question are all still there.
          const view = await MessageV2.filterCompacted(MessageV2.stream(session.id))
          expect(view.some((message) => text(message) === QUESTION)).toBe(true)
          expect(JSON.stringify(view)).toContain(MIDDLE)
          // The stale carrier is not replayed under the next real prompt.
          const next = await SessionPrompt.prompt({
            sessionID: session.id,
            model: MODEL,
            agent: "research",
            parts: [{ type: "text", text: "EDGE_FOLLOWUP_2B: a fresh request." }],
          })
          if (next.info.role !== "assistant") throw new Error("expected an answer")
          expect(next.info.error).toBeUndefined()
          expect(text(next)).toBe("EDGE_ANSWER_2B")
          expect(provider.summaries()).toHaveLength(1)
        },
      })
    } finally {
      provider.stop()
    }
  }, 30_000)

  test("3. two automatic compactions in one long turn behind a byte-limited gateway", async () => {
    const line = (tag: string, index: number) => `${tag} line ${String(index).padStart(4, "0")} ${"x".repeat(80)}`
    const bigFile = (tag: string) => Array.from({ length: 300 }, (_, index) => line(tag, index)).join("\n")
    const limit = { bytes: undefined as number | undefined }
    const provider = fixture(({ kind, bytes, prior }) => {
      // The first request sets the gateway's body limit just above itself:
      // any request carrying a whole file result is past it.
      if (limit.bytes === undefined) limit.bytes = bytes + 12_000
      if (bytes > limit.bytes) return tooLarge()
      if (kind === "summary") {
        const accepted = prior.summaries.filter((item) => item.status === 200).length
        return reply(accepted === 0 ? "HANDOFF_ONE: big-1.txt was read." : "HANDOFF_TWO: both files were read.")
      }
      const accepted = prior.mains.filter((item) => item.status === 200).length
      if (accepted === 0) return toolCall("read", { filePath: "big-1.txt" }, "call_big_1")
      if (accepted === 1) return toolCall("read", { filePath: "big-2.txt" }, "call_big_2")
      return reply("EDGE_FINAL_ANSWER_THREE")
    })
    try {
      await withProject({
        config: {
          ...stressProviderConfig(provider.url),
          compaction: { tailTurns: 1, tailTokens: 1_000 },
        },
        files: { "big-1.txt": bigFile("BIG_FILE_ONE"), "big-2.txt": bigFile("BIG_FILE_TWO") },
        fn: async () => {
          const session = await Session.create({ title: "Two compactions in one turn", workspace: "project" })
          const result = await SessionPrompt.prompt({
            sessionID: session.id,
            model: MODEL,
            agent: "research",
            parts: [{ type: "text", text: "EDGE_TASK_THREE: read big-1.txt then big-2.txt and report." }],
          })
          if (result.info.role !== "assistant") throw new Error("expected an assistant result")
          expect(result.info.error).toBeUndefined()
          expect(text(result)).toBe("EDGE_FINAL_ANSWER_THREE")

          // Each file result overflows the gateway once; each overflow costs
          // one compaction whose full attempt overflows too and whose
          // reduced attempt lands. No request is repeated past that.
          expect(provider.mains().map((item) => item.status)).toEqual([200, 413, 200, 413, 200])
          expect(provider.summaries().map((item) => item.status)).toEqual([413, 200, 413, 200])
          const [, , third] = provider.summaries()
          expect(third.body).toContain("You are UPDATING an existing handoff")
          expect(third.body).toContain("HANDOFF_ONE")

          const messages = await Session.messages({ sessionID: session.id })
          const stored = summaries(messages)
          expect(stored.map(text)).toEqual(["HANDOFF_ONE: big-1.txt was read.", "HANDOFF_TWO: both files were read."])
          expect(stored.every((message) => message.info.finish === "stop" && !message.info.error)).toBe(true)
          expect(errors(messages)).toEqual([])

          // The layout the next request sees: pinned request, the newest
          // carrier + summary, its continuation, the answer. No file body.
          const view = await MessageV2.filterCompacted(MessageV2.stream(session.id))
          const roles = view.map((message) =>
            message.info.role === "user"
              ? message.parts.some((part) => part.type === "compaction")
                ? "carrier"
                : (SessionLoopState.messageKind(message.info) ?? "prompt")
              : message.info.summary
                ? "summary"
                : "assistant",
          )
          expect(roles).toEqual(["prompt", "carrier", "summary", "compaction", "assistant"])
          expect(text(view[2])).toContain("HANDOFF_TWO")
          expect(text(view[0])).toContain("EDGE_TASK_THREE")
          expect(JSON.stringify(view)).not.toContain("BIG_FILE_ONE line")
          expect(JSON.stringify(view)).not.toContain("BIG_FILE_TWO line")
          expect(view.at(-1)?.info.id).toBe(result.info.id)
          const final = provider.mains().at(-1)!
          expect(final.body).toContain("HANDOFF_TWO")
          expect(final.body).not.toContain("HANDOFF_ONE")
          expect(final.body).not.toContain("BIG_FILE_TWO line")
        },
      })
    } finally {
      provider.stop()
    }
  }, 30_000)

  test("4. compaction with images: the standalone summarizer sees no image, the resumed request keeps the budget", async () => {
    const a = figure("a")
    const b = figure("b")
    const c = figure("c")
    const HANDOFF = "IMAGE_HANDOFF: the first figure was plotted."
    const provider = fixture(({ kind }) => (kind === "summary" ? reply(HANDOFF) : reply("EDGE_ANSWER_FOUR")))
    try {
      const base = stressProviderConfig(provider.url)
      const models = base.provider[STRESS_PROVIDER_ID].models as Record<string, Record<string, unknown>>
      models[STRESS_PROVIDER_MODEL] = {
        ...models[STRESS_PROVIDER_MODEL],
        attachment: true,
        modalities: { input: ["text", "image"], output: ["text"] },
      }
      await withProject({
        config: { ...base, compaction: { tailTurns: 1, recentImages: 1 } },
        fn: async () => {
          const session = await Session.create({ title: "Compaction with images" })
          const first = await typed(session.id, "Plot the first figure.")
          await replied(session.id, first.id, {
            finish: "tool-calls",
            tools: [
              {
                tool: "read",
                input: { filePath: "a.png" },
                output: "read a.png",
                attachments: [{ filename: "a.png", data: a }],
              },
            ],
          })
          await replied(session.id, first.id, { finish: "stop", text: "Plotted a.png." })
          const second = await typed(session.id, "Plot two more figures.")
          await replied(session.id, second.id, {
            finish: "tool-calls",
            tools: [
              {
                tool: "read",
                input: { filePath: "b.png" },
                output: "read b.png and c.png",
                attachments: [
                  { filename: "b.png", data: b },
                  { filename: "c.png", data: c },
                ],
              },
            ],
          })
          await replied(session.id, second.id, { finish: "stop", text: "Plotted b.png and c.png." })
          // No request has left this process for the session, so the
          // summary takes the standalone path (compaction agent, media
          // stripped) rather than riding a remembered prefix.
          await SessionCompaction.create({
            sessionID: session.id,
            agent: "research",
            model: MODEL,
            auto: false,
            trigger: "manual",
          })
          const compacted = await SessionPrompt.loop(session.id)
          if (compacted.info.role !== "assistant") throw new Error("expected a summary")
          expect(compacted.info.summary).toBe(true)
          expect(compacted.info.error).toBeUndefined()
          expect(compacted.info.agent).toBe("compaction")
          expect(compacted.info.tailStartId).toBe(second.id)

          const summary = provider.summaries()
          expect(summary).toHaveLength(1)
          expect(summary[0].body).not.toContain("image_url")
          expect(summary[0].body).not.toContain(base64(a))
          expect(summary[0].body).not.toContain(base64(b))
          expect(summary[0].body).not.toContain(base64(c))
          expect(summary[0].body).toContain("[image omitted: a.png]")
          expect(summary[0].body).toContain("read a.png")
          // The tail (second turn) is not summarized, so its figures are
          // neither shipped nor named to the summarizer.
          expect(summary[0].body).not.toContain("read b.png")

          const result = await SessionPrompt.prompt({
            sessionID: session.id,
            model: MODEL,
            agent: "research",
            parts: [{ type: "text", text: "Which figures can you still see?" }],
          })
          if (result.info.role !== "assistant") throw new Error("expected an answer")
          expect(result.info.error).toBeUndefined()
          expect(text(result)).toBe("EDGE_ANSWER_FOUR")

          const resumed = provider.mains().at(-1)!
          expect(resumed.body).toContain(HANDOFF)
          // The head's figure is gone with the head; the tail's two figures
          // meet the count window (recentImages 1): only the newest ships.
          expect(resumed.body).not.toContain(base64(a))
          expect(resumed.body).not.toContain(base64(b))
          expect(resumed.body).toContain(base64(c))
          expect(resumed.body.match(/"type":"image_url"/g) ?? []).toHaveLength(1)
          expect(resumed.body).toContain("older image omitted to save context: b.png")
          expect(resumed.body).toContain("1 image from this result follows in the next message")
          // The byte budget is the route's: a loopback provider is a direct
          // route, and what shipped is far under it.
          const route = await resolveAccessRoute(MODEL.providerID, MODEL.modelID)
          expect(route).toBe("local")
          expect(SessionCompaction.imageBytes(route)).toBe(SessionCompaction.IMAGE_BYTES_DIRECT)
          const shipped = [...resumed.body.matchAll(/data:image\/png;base64,([A-Za-z0-9+/=]+)/g)]
            .map((match) => Buffer.from(match[1], "base64").byteLength)
            .reduce((sum, bytes) => sum + bytes, 0)
          expect(shipped).toBe(c.byteLength)
          expect(shipped).toBeLessThanOrEqual(SessionCompaction.imageBytes(route))
        },
      })
    } finally {
      provider.stop()
    }
  }, 30_000)

  test("5. filterCompacted survives a tailStartId that is missing, misplaced or malformed", async () => {
    type Layout = { id: string; role: "user" | "assistant"; text?: string; extra?: Record<string, unknown> }
    const mk = (layout: Layout): MessageV2.WithParts =>
      ({
        info: {
          id: layout.id,
          sessionID: "ses_edge",
          role: layout.role,
          time: { created: 0 },
          ...(layout.role === "user"
            ? { agent: "research", model: MODEL }
            : {
                parentID: "none",
                modelID: MODEL.modelID,
                providerID: MODEL.providerID,
                mode: "research",
                agent: "research",
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              }),
          ...(layout.extra ?? {}),
        },
        parts:
          layout.text === undefined
            ? [{ id: `${layout.id}-c`, sessionID: "ses_edge", messageID: layout.id, type: "compaction", auto: true }]
            : [{ id: `${layout.id}-t`, sessionID: "ses_edge", messageID: layout.id, type: "text", text: layout.text }],
      }) as unknown as MessageV2.WithParts
    // Oldest-first, ids in the order the store would assign them. Two
    // compactions: the first is sound, the second carries the tailStartId
    // under test.
    const history = (tailStartId: string | undefined) => [
      mk({ id: "m01", role: "user", text: "old request" }),
      mk({ id: "m02", role: "assistant", text: "old reply", extra: { finish: "stop", parentID: "m01" } }),
      mk({ id: "m03", role: "user" }),
      mk({
        id: "m04",
        role: "assistant",
        text: "HANDOFF 1",
        extra: { summary: true, finish: "stop", parentID: "m03" },
      }),
      mk({ id: "m05", role: "user", text: "newest request" }),
      mk({ id: "m06", role: "assistant", text: "work on it", extra: { finish: "tool-calls", parentID: "m05" } }),
      mk({ id: "m07", role: "user" }),
      mk({
        id: "m08",
        role: "assistant",
        text: "HANDOFF 2",
        extra: { summary: true, finish: "stop", parentID: "m07", ...(tailStartId ? { tailStartId } : {}) },
      }),
      mk({ id: "m09", role: "assistant", text: "continuing", extra: { finish: "stop", parentID: "m07" } }),
    ]
    async function* newestFirst(messages: MessageV2.WithParts[]) {
      for (const message of [...messages].reverse()) yield message
    }
    const layout = async (messages: MessageV2.WithParts[]) =>
      (await MessageV2.filterCompacted(newestFirst(messages))).map((message) => message.info.id)

    // Sound anchor: the second compaction's tail starts at the newest request.
    expect(await layout(history("m05"))).toEqual(["m07", "m08", "m05", "m06", "m09"])
    // Anchor names an id that never existed: history from the previous
    // boundary stays, in order, with this summary as its recap.
    expect(await layout(history("m99"))).toEqual(["m03", "m04", "m05", "m06", "m07", "m08", "m09"])
    // Anchor is the carrier itself: an empty tail, so it behaves like no anchor.
    expect(await layout(history("m07"))).toEqual(["m07", "m08", "m09"])
    // Anchor is the summary or its continuation (after the boundary): the
    // tail cannot be spliced, so the previous boundary bounds what is kept.
    expect(await layout(history("m08"))).toEqual(["m03", "m04", "m05", "m06", "m07", "m08", "m09"])
    expect(await layout(history("m09"))).toEqual(["m03", "m04", "m05", "m06", "m07", "m08", "m09"])
    // Anchor precedes the previous boundary: nothing throws, the newest
    // request and both summaries survive in order. Observed: the previously
    // compacted history (m01, m02, m03, m04) is spliced back in as "tail".
    const early = await layout(history("m01"))
    expect(new Set(early).size).toBe(early.length)
    expect(early.slice(0, 2)).toEqual(["m07", "m08"])
    expect(early.indexOf("m05")).toBeLessThan(early.indexOf("m06"))
    expect(early.indexOf("m06")).toBeLessThan(early.indexOf("m09"))
    expect(early.at(-1)).toBe("m09")
    expect(early).toEqual(["m07", "m08", "m01", "m02", "m03", "m04", "m05", "m06", "m09"])
    // Anchor is an assistant message inside the tail: no throw; the tail
    // starts there and the request before it is dropped.
    expect(await layout(history("m06"))).toEqual(["m07", "m08", "m06", "m09"])
    // A summary whose carrier vanished is not a boundary. Observed: its anchor
    // (m05) is still taken as the tail anchor, the older carrier m03 becomes
    // the layout's carrier, m05 lies after it, and the fallback finds no
    // boundary before m03: the first compaction's history (m01, m02) is
    // spliced back in. No throw, nothing lost; the previous boundary is not
    // honoured either (ideal: ["m03", "m04", "m05", "m06", "m08", "m09"]).
    const orphaned = history("m05").filter((message) => message.info.id !== "m07")
    expect(await layout(orphaned)).toEqual(["m01", "m02", "m03", "m04", "m05", "m06", "m08", "m09"])
    // No anchor at all on the second summary: everything before it is dropped.
    expect(await layout(history(undefined))).toEqual(["m07", "m08", "m09"])
  })

  test("6. manual /compact on a short session: the next prompt sees the summary, not the tool output", async () => {
    // Single-line markers: they are matched against raw JSON request bodies.
    const HANDOFF = "MANUAL_HANDOFF_MARKER: notes.txt was read and answered."
    const NOTE = "PRE_SUMMARY_TOOL_OUTPUT_MARKER: the notes say the answer is forty-two."
    const provider = fixture(({ kind, prior }) => {
      if (kind === "summary") return reply(HANDOFF)
      if (prior.mains.length === 0) return toolCall("read", { filePath: "notes.txt" }, "call_notes")
      if (prior.mains.length === 1) return reply("EDGE_ANSWER_SIX_A")
      return reply("EDGE_ANSWER_SIX_B")
    })
    try {
      await withProject({
        config: stressProviderConfig(provider.url),
        files: { "notes.txt": NOTE },
        fn: async () => {
          const session = await Session.create({ title: "Manual compact", workspace: "project" })
          const first = await SessionPrompt.prompt({
            sessionID: session.id,
            model: MODEL,
            agent: "research",
            parts: [{ type: "text", text: "EDGE_TASK_SIX: read notes.txt." }],
          })
          expect(text(first)).toBe("EDGE_ANSWER_SIX_A")
          expect(provider.mains()[1].body).toContain(NOTE)

          const compacted = await SessionPrompt.command({
            sessionID: session.id,
            command: "compact",
            arguments: "",
          })
          if (compacted.info.role !== "assistant") throw new Error("expected a summary")
          expect(compacted.info.summary).toBe(true)
          expect(compacted.info.error).toBeUndefined()
          expect(text(compacted)).toBe(HANDOFF)
          // A single-turn session has nothing to keep verbatim: no tail.
          expect(compacted.info.tailStartId).toBeUndefined()
          expect(provider.summaries()).toHaveLength(1)
          expect(provider.summaries()[0].body).toContain(NOTE)
          // /compact is an action: no automatic continuation, no extra turn.
          expect(provider.mains()).toHaveLength(2)

          const next = await SessionPrompt.prompt({
            sessionID: session.id,
            model: MODEL,
            agent: "research",
            parts: [{ type: "text", text: "EDGE_FOLLOWUP_SIX: what did the notes say?" }],
          })
          if (next.info.role !== "assistant") throw new Error("expected an answer")
          expect(next.info.error).toBeUndefined()
          expect(next.info.summary).toBeUndefined()
          expect(text(next)).toBe("EDGE_ANSWER_SIX_B")
          expect(provider.mains()).toHaveLength(3)
          expect(provider.summaries()).toHaveLength(1)
          const request = provider.mains()[2]
          expect(request.body).toContain(HANDOFF)
          expect(request.body).toContain("EDGE_FOLLOWUP_SIX")
          // The pinned root instruction rides ahead of the summary.
          expect(request.body).toContain("EDGE_TASK_SIX")
          expect(request.body).not.toContain(NOTE)
          expect(request.body).not.toContain("call_notes")
          expect(request.bytes).toBeLessThan(provider.mains()[1].bytes)
        },
      })
    } finally {
      provider.stop()
    }
  }, 30_000)

  /** Case 7's scenario: the conversation request overflows, the summarizer
   * request stalls, the person restarts, the next boot resumes the turn. */
  async function restartDuringSummary() {
    const HANDOFF = "RESTART_HANDOFF: the earlier tool printed a long A/Z block; answer the marker question."
    const open: WritableStreamDefaultWriter<Uint8Array>[] = []
    const provider = fixture(({ kind, body, prior }) => {
      if (kind === "summary") return prior.summaries.length === 0 ? stalled(open) : reply(HANDOFF)
      return body.includes(HANDOFF) ? reply("EDGE_ANSWER_SEVEN") : tooLarge()
    })
    const compacted: string[] = []
    try {
      return await withProject({
        config: {
          ...stressProviderConfig(provider.url),
          compaction: { tailTurns: 1, tailTokens: 8_000 },
        },
        fn: async () => {
          using subscription = {
            unsubscribe: Bus.subscribe(SessionCompaction.Event.Compacted, (event) => {
              compacted.push(event.properties.sessionID)
            }),
            [Symbol.dispose]() {
              this.unsubscribe()
            },
          }
          void subscription
          const session = await Session.create({ title: "Restart during compaction" })
          await longToolHistory(session.id)
          const turn = SessionPrompt.prompt({
            sessionID: session.id,
            model: MODEL,
            agent: "research",
            parts: [{ type: "text", text: QUESTION }],
          })
          // The conversation request overflowed and the summarizer request
          // is now open and stalled.
          await until(async () => (provider.summaries().length === 1 ? true : undefined), "the summarizer request")
          const inflight = await until(async () => {
            const messages = await Session.messages({ sessionID: session.id })
            return summaries(messages).find((message) => !message.info.time.completed)
          }, "the in-flight summary record")
          expect(await SessionPrompt.pauseForRestart()).toBe(1)
          const paused = await turn
          const atPause = {
            messages: await Session.messages({ sessionID: session.id }),
            compacted: compacted.filter((id) => id === session.id).length,
            active: SessionPrompt.activeCount(),
            mains: provider.mains().length,
          }
          // A restart empties process memory: the remembered shared-prefix
          // assembly is gone with it.
          SessionCompaction.forget(session.id)
          const resumed = await SessionPrompt.resumeInterrupted()
          const answer = await until(async () => {
            const last = (await Session.messages({ sessionID: session.id })).at(-1)
            return last?.info.role === "assistant" && last.info.time.completed && !last.info.summary ? last : undefined
          }, "the resumed answer")
          return {
            session,
            HANDOFF,
            inflight,
            paused,
            atPause,
            resumed,
            answer,
            messages: await Session.messages({ sessionID: session.id }),
            view: await MessageV2.filterCompacted(MessageV2.stream(session.id)),
            statuses: provider.statuses(),
            summaryRequests: provider.summaries(),
            compacted: compacted.filter((id) => id === session.id).length,
          }
        },
      })
    } finally {
      for (const writer of open) await writer.close().catch(() => undefined)
      provider.stop()
    }
  }

  test("7. a restart during the summarizer request pauses the turn and the next boot finishes it", async () => {
    const run = await restartDuringSummary()
    // Observed: the paused summary is left unfinished (no error, no
    // completion time), the shape resumeInterrupted looks for, and it is
    // what the prompt returns.
    if (run.paused.info.role !== "assistant") throw new Error("the turn did not return an assistant message")
    expect(run.paused.info.id).toBe(run.inflight.info.id)
    expect(run.paused.info.summary).toBe(true)
    expect(run.paused.info.error).toBeUndefined()
    expect(run.paused.info.time.completed).toBeUndefined()
    expect(run.paused.info.finish).toBeUndefined()
    expect(run.atPause.active).toBe(0)
    expect(run.atPause.mains).toBe(1)
    expect(SessionPrompt.interrupted(run.atPause.messages)).toBe(true)
    expect(SessionLoopState.pendingCompaction(run.atPause.messages)).toBeUndefined()
    expect(errors(run.atPause.messages)).toEqual([])

    // The next process boots and continues the turn where it stopped: the
    // carrier is still the newest user message, so the compaction runs
    // again (standalone, the prefix is forgotten), lands, and the request
    // is answered.
    expect(run.resumed).toEqual([run.session.id])
    expect(run.answer.info.role === "assistant" && run.answer.info.error).toBeUndefined()
    expect(text(run.answer)).toBe("EDGE_ANSWER_SEVEN")
    expect(run.statuses).toEqual([
      ["main", 413],
      ["summary", 200], // the stalled one, recorded when it was opened
      ["summary", 200],
      ["main", 200],
    ])
    expect(run.summaryRequests[0].body).toContain(SessionCompaction.HANDOFF_PREAMBLE.slice(0, 40))
    expect(run.summaryRequests[1].body).not.toContain(SessionCompaction.HANDOFF_PREAMBLE.slice(0, 40))

    const stored = summaries(run.messages)
    const completed = stored.filter((message) => message.info.time.completed)
    expect(completed).toHaveLength(1)
    expect(text(completed[0])).toBe(run.HANDOFF)
    expect(completed[0].info.finish).toBe("stop")
    expect(completed[0].info.agent).toBe("compaction")
    expect(errors(run.messages)).toEqual([])
    // Observed: the paused attempt stays in the transcript as a text-less,
    // unfinished summary record. It is never a boundary (no finish, no
    // text) and the model never sees it (no parts).
    const orphans = stored.filter((message) => !message.info.time.completed)
    expect(orphans).toHaveLength(1)
    expect(orphans[0].info.id).toBe(run.inflight.info.id)
    expect(text(orphans[0])).toBe("")
    expect(orphans[0].info.error).toBeUndefined()
    expect(orphans[0].info.finish).toBeUndefined()
    expect(
      run.view.filter((message) => message.info.role === "assistant" && message.info.summary && text(message)),
    ).toHaveLength(1)
    expect(run.view.some((message) => text(message) === QUESTION)).toBe(true)
    expect(run.view.at(-1)?.info.id).toBe(run.answer.info.id)
    expect(SessionPrompt.interrupted(run.messages)).toBe(false)
  }, 30_000)

  // KNOWN FAILURE (documented, left in place). Expected: `session.compacted`
  // is published once, for the compaction that produced a handoff. Observed:
  // it is published twice, the first time at the pause. SessionCompaction
  // .process treats the paused attempt's "stop" result like a success because
  // the restart path clears the message's error on purpose
  // (processor.ts: "A turn paused for a restart is left unfinished"), and
  // process() only checks `attempt.message.error` before publishing
  // (compaction.ts, the tail of process()). Clients on the SDK event stream
  // see a compaction that never happened.
  test("7b. a summarizer paused for a restart does not announce a compaction", async () => {
    const run = await restartDuringSummary()
    expect(run.atPause.compacted).toBe(0)
    expect(run.compacted).toBe(1)
  }, 30_000)

  test("8a. a 5 MB tool result in the open turn is pruned before any request is built; one request answers", async () => {
    const provider = fixture(({ bytes }) => (bytes > 1_000_000 ? tooLarge() : reply("EDGE_ANSWER_EIGHT_A")))
    try {
      await withProject({
        config: stressProviderConfig(provider.url),
        fn: async () => {
          const session = await Session.create({ title: "Giant tool result, prunable" })
          const request = await typed(session.id, "EDGE_TASK_EIGHT_A: dump the whole dataset.")
          const giant = `GIANT_OUTPUT_START\n${"x".repeat(5 * 1024 * 1024)}\nGIANT_OUTPUT_END`
          await replied(session.id, request.id, {
            finish: "tool-calls",
            tools: [{ tool: "bash", input: { command: "cat dataset.csv" }, output: giant }],
          })
          // The provider turn continues the open request: the model just
          // received the result and would send it back.
          const result = await SessionPrompt.loop(session.id)
          if (result.info.role !== "assistant") throw new Error("expected an assistant result")
          expect(result.info.error).toBeUndefined()
          expect(result.info.time.completed).toBeDefined()
          expect(text(result)).toBe("EDGE_ANSWER_EIGHT_A")

          // The prune at the turn boundary clears the result before the
          // request is built, so the estimate never has to refuse a body and
          // no recovery continuation is needed: one request goes out.
          expect(provider.requests).toHaveLength(1)
          expect(provider.statuses()).toEqual([["main", 200]])
          expect(provider.mains()[0].bytes).toBeLessThan(1_000_000)
          expect(provider.mains()[0].body).not.toContain("GIANT_OUTPUT_START")
          expect(provider.mains()[0].body).toContain("cleared")

          const messages = await Session.messages({ sessionID: session.id })
          expect(errors(messages)).toHaveLength(0)
          expect(
            messages.filter(
              (message) => message.info.role === "user" && SessionLoopState.messageKind(message.info) === "context",
            ),
          ).toHaveLength(0)
          expect(summaries(messages)).toHaveLength(0)
          const tool = messages
            .flatMap((message) => message.parts)
            .find((part): part is MessageV2.ToolPart => part.type === "tool")
          expect(tool?.state.status === "completed" && tool.state.time.compacted).toBeDefined()
          // Re-entering the loop after the answer sends nothing new.
          const count = provider.requests.length
          const replay = await SessionPrompt.loop(session.id)
          expect(replay.info.id).toBe(result.info.id)
          expect(provider.requests).toHaveLength(count)
        },
      })
    } finally {
      provider.stop()
    }
  }, 30_000)

  test("8b. a 5 MB result pruning must protect is compacted at reduced fidelity behind a byte-limited gateway", async () => {
    const HANDOFF = "GIANT_HANDOFF: the checklist was written; report it."
    const provider = fixture(({ kind, bytes }) => {
      if (bytes > 1_000_000) return tooLarge()
      return kind === "summary" ? reply(HANDOFF) : reply("EDGE_ANSWER_EIGHT_B")
    })
    try {
      await withProject({
        config: stressProviderConfig(provider.url),
        fn: async () => {
          const session = await Session.create({ title: "Giant tool result, protected" })
          const request = await typed(session.id, "EDGE_TASK_EIGHT_B: write the checklist.")
          const giant = `GIANT_OUTPUT_START\n${"x".repeat(5 * 1024 * 1024)}\nGIANT_OUTPUT_END`
          // todowrite is never pruned, so the estimate has to fall through
          // to a summary of the open span.
          await replied(session.id, request.id, {
            finish: "tool-calls",
            tools: [{ tool: "todowrite", input: { todos: [] }, output: giant }],
          })
          const result = await SessionPrompt.loop(session.id)
          if (result.info.role !== "assistant") throw new Error("expected an assistant result")
          expect(result.info.error).toBeUndefined()
          expect(text(result)).toBe("EDGE_ANSWER_EIGHT_B")

          // The head's own estimate already exceeds the window, so the doomed
          // full-fidelity attempt is skipped: the reduced attempt caps the
          // result and one request follows.
          expect(provider.requests.length).toBeLessThanOrEqual(3)
          expect(provider.statuses()).toEqual([
            ["summary", 200],
            ["main", 200],
          ])
          const [reduced] = provider.summaries()
          expect(reduced.bytes).toBeLessThan(100_000)
          expect(reduced.body).toContain(CAP_MARKER)
          expect(reduced.body).toContain("GIANT_OUTPUT_START")
          expect(reduced.body).toContain("GIANT_OUTPUT_END")
          expect(provider.mains()[0].bytes).toBeLessThan(100_000)
          expect(provider.mains()[0].body).toContain(HANDOFF)
          expect(provider.mains()[0].body).toContain("EDGE_TASK_EIGHT_B")

          const messages = await Session.messages({ sessionID: session.id })
          const failures = errors(messages)
          expect(failures).toHaveLength(1)
          expect(failures[0]).toContain("cannot fit")
          const stored = summaries(messages)
          expect(stored).toHaveLength(1)
          expect(text(stored[0])).toBe(HANDOFF)
          const carrier = messages.find(
            (message) => message.info.role === "user" && message.info.internal?.type === "compaction",
          )
          expect(
            carrier?.info.role === "user" &&
              carrier.info.internal?.type === "compaction" &&
              carrier.info.internal.recovery?.type,
          ).toBe("preflight")
          const count = provider.requests.length
          const replay = await SessionPrompt.loop(session.id)
          expect(replay.info.id).toBe(result.info.id)
          expect(provider.requests).toHaveLength(count)
        },
      })
    } finally {
      provider.stop()
    }
  }, 30_000)
})

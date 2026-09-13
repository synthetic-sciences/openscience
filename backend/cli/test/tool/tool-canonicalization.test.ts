import { expect, test } from "bun:test"
import z from "zod"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { MessageV2 } from "../../src/session/message-v2"
import { createComputeJobTool } from "../../src/tool/compute-job"
import { Tool } from "../../src/tool/tool"
import { ToolRegistry } from "../../src/tool/registry"
import { tmpdir } from "../fixture/fixture"
import { SessionLoopState } from "../../src/session/loop-state"
import { InvalidCall } from "../../src/tool/invalid-call"

function context(sessionID = "ses_canonical", messageID = "msg_canonical") {
  return {
    sessionID,
    messageID,
    callID: "call_canonical",
    agent: "research",
    abort: new AbortController().signal,
    messages: [],
    metadata() {},
    async ask() {},
  }
}

async function turn(sessionID: string, epoch: string, continuation = false) {
  const userID = continuation ? Identifier.ascending("message") : epoch
  const messageID = Identifier.ascending("message")
  const text = continuation ? "continue" : "run a malformed batch regression"
  await Session.updateMessage({
    id: userID,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "research",
    effort: "normal",
    model: { providerID: "openrouter", modelID: "openai/test" },
    internal: continuation
      ? SessionLoopState.intent({ kind: "compaction", text, epoch, transaction: userID })
      : SessionLoopState.prompt(epoch),
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID,
    messageID: userID,
    type: "text",
    text,
    synthetic: continuation,
  })
  await Session.updateMessage({
    id: messageID,
    sessionID,
    parentID: userID,
    role: "assistant",
    time: { created: Date.now() },
    mode: "research",
    agent: "research",
    path: { cwd: Instance.directory, root: Instance.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "openai/test",
    providerID: "openrouter",
  })
  return messageID
}

test("Tool.define executes the canonical Zod output for every tool", async () => {
  const tool = await Tool.define("canonical_probe", {
    description: "Canonicalization probe",
    parameters: z
      .object({
        label: z
          .string()
          .trim()
          .transform((value) => value.toUpperCase()),
        limit: z.number().default(10),
      })
      .strict(),
    async execute(input) {
      return { title: "Canonical probe", metadata: {}, output: JSON.stringify(input) }
    },
  }).init()

  const result = await tool.execute({ label: "  parsed  " } as never, context())
  expect(JSON.parse(result.output)).toEqual({ label: "PARSED", limit: 10 })
})

test("Tool.validate rejects incomplete provider input without exposing raw Zod noise", () => {
  const result = Tool.validate(
    "probe",
    {
      parameters: z.object({ command: z.string(), description: z.string() }),
    },
    {},
  )
  expect(result.success).toBe(false)
  if (result.success) throw new Error("Incomplete input unexpectedly passed validation")
  expect(result.error.message).toBe(
    "The probe tool received invalid arguments or incomplete input. No action was taken. Retry with all required fields.",
  )
  expect(result.error.message).not.toContain("invalid_type")
})

test("Tool.define dedupes against the canonical signature persisted with a raw call", async () => {
  let executions = 0
  const tool = await Tool.define("science_search", {
    description: "Canonical dedupe probe",
    parameters: z
      .object({
        query: z.string().trim(),
        limit: z.number().default(10),
      })
      .strict(),
    async execute(input) {
      executions++
      return { title: "Canonical dedupe probe", metadata: {}, output: JSON.stringify(input) }
    },
  }).init()

  const rawInput = { query: "  equivalent query  " }
  const first = await tool.execute(rawInput as never, context())
  const message: MessageV2.WithParts = {
    info: {
      id: "msg_previous",
      sessionID: "ses_canonical",
      role: "assistant",
      time: { created: 1, completed: 2 },
      parentID: "msg_user",
      modelID: "model",
      providerID: "provider",
      mode: "research",
      agent: "research",
      path: { cwd: "/tmp", root: "/tmp" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
    parts: [
      {
        id: "part_previous",
        sessionID: "ses_canonical",
        messageID: "msg_previous",
        type: "tool",
        callID: "call_previous",
        tool: "science_search",
        state: {
          status: "completed",
          input: rawInput,
          output: first.output,
          title: first.title,
          metadata: first.metadata,
          time: { start: 1, end: 2 },
        },
      },
    ],
  }

  const second = await tool.execute({ query: "equivalent query", limit: 10 }, { ...context(), messages: [message] })
  expect(second.output).toBe(first.output)
  expect(second.metadata).toMatchObject({
    dedupeHit: true,
    dedupeOf: { messageID: "msg_previous", partID: "part_previous", callID: "call_previous" },
  })
  expect(executions).toBe(1)
})

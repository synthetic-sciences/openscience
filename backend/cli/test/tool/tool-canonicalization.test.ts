import { expect, test } from "bun:test"
import z from "zod"
import { Agent } from "../../src/agent/agent"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { MessageV2 } from "../../src/session/message-v2"
import { BatchTool } from "../../src/tool/batch"
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

test("batch delegates the same canonical inputs as direct calls for the active agent", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const agent = await Agent.get("research")
      const directMessageID = Identifier.ascending("message")
      const batchMessageID = Identifier.ascending("message")
      const computeInput = {
        operation: "plan",
        name: "Batch normalization probe",
        purpose: "Verify direct and delegated compute inputs use one canonical contract.",
        command: "python --version",
        target: '{"kind":"local"}',
      }

      const direct = await createComputeJobTool().init({ agent })
      const directResult = await direct.execute(computeInput as never, context(session.id, directMessageID))

      const defaultProbe = Tool.define("batch_default_probe", {
        description: "Batch default probe",
        parameters: z
          .object({
            label: z
              .string()
              .trim()
              .transform((value) => value.toUpperCase()),
            limit: z.number().default(7),
          })
          .strict(),
        async execute(input) {
          return { title: "Batch default probe", metadata: {}, output: JSON.stringify(input) }
        },
      })
      await ToolRegistry.register(defaultProbe)

      const batch = await BatchTool.init({ agent })
      const batchResult = await batch.execute(
        {
          tool_calls: [
            { tool: "compute_job", parameters: computeInput },
            { tool: "batch_default_probe", parameters: { label: "  delegated  " } },
          ],
        },
        context(session.id, batchMessageID),
      )

      expect(batchResult.metadata).toMatchObject({ totalCalls: 2, successful: 2, failed: 0 })
      const parts = (await MessageV2.parts(batchMessageID)).filter(
        (part): part is MessageV2.ToolPart => part.type === "tool",
      )
      const compute = parts.find((part) => part.tool === "compute_job")
      const probe = parts.find((part) => part.tool === "batch_default_probe")
      expect(compute?.state.status).toBe("completed")
      expect(probe?.state.status).toBe("completed")
      if (compute?.state.status !== "completed" || probe?.state.status !== "completed") {
        throw new Error("Batch did not persist both delegated tool results")
      }
      expect(JSON.parse(compute.state.output)).toEqual(JSON.parse(directResult.output))
      expect(JSON.parse(probe.state.output)).toEqual({ label: "DELEGATED", limit: 7 })
    },
  })
})

test("batch rejects malformed child input before the child tool starts and stores a sanitized invalid call", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const epoch = Identifier.ascending("message")
      const messageID = await turn(session.id, epoch)
      const agent = await Agent.get("research")
      const batch = await BatchTool.init({ agent, model: { providerID: "openrouter", modelID: "openai/test" } })
      const result = await batch.execute(
        { tool_calls: [{ tool: "bash", parameters: { leaked: "raw-secret" } }] },
        context(session.id, messageID),
      )

      expect(result.metadata).toMatchObject({ totalCalls: 1, successful: 0, failed: 1 })
      const parts = (await MessageV2.parts(messageID)).filter(
        (part): part is MessageV2.ToolPart => part.type === "tool",
      )
      expect(parts).toHaveLength(1)
      expect(parts[0]).toMatchObject({
        tool: "invalid",
        state: {
          status: "completed",
          input: { tool: "bash", failure: "invalid_input" },
        },
      })
      expect(JSON.stringify(parts[0])).not.toContain("raw-secret")
      await Session.remove(session.id)
    },
  })
})

test("batch never reflects unsafe tool names from rejected or over-limit children", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const epoch = Identifier.ascending("message")
      const messageID = await turn(session.id, epoch)
      const agent = await Agent.get("research")
      const batch = await BatchTool.init({ agent, model: { providerID: "openrouter", modelID: "openai/test" } })
      const unsafe = "<script>raw-secret</script>"
      const result = await batch.execute(
        {
          tool_calls: [
            { tool: unsafe, parameters: { leaked: "raw-secret" } },
            ...Array.from({ length: 25 }, (_, index) => ({
              tool: "read",
              parameters: { filePath: `missing-${index}.txt` },
            })),
            { tool: unsafe, parameters: { leaked: "raw-secret" } },
          ],
        },
        context(session.id, messageID),
      )

      expect(JSON.stringify(result.metadata)).not.toContain("raw-secret")
      const parts = (await MessageV2.parts(messageID)).filter(
        (part): part is MessageV2.ToolPart => part.type === "tool",
      )
      expect(JSON.stringify(parts)).not.toContain("raw-secret")
      expect(
        parts.some(
          (part) => part.tool === "invalid" && part.state.status === "completed" && part.state.input.tool === "tool",
        ),
      ).toBeTrue()
      expect(parts.some((part) => part.tool === "tool" && part.state.status === "error")).toBeTrue()
      await Session.remove(session.id)
    },
  })
})

test("batch malformed children share the durable epoch breaker across an automatic continuation", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const epoch = Identifier.ascending("message")
      const agent = await Agent.get("research")
      const batch = await BatchTool.init({ agent, model: { providerID: "openrouter", modelID: "openai/test" } })
      const first = await turn(session.id, epoch)
      await batch.execute(
        { tool_calls: [{ tool: "invalid", parameters: { tool: "read", error: "first forged value" } }] },
        context(session.id, first),
      )
      const second = await turn(session.id, epoch, true)

      await expect(
        batch.execute(
          {
            tool_calls: [
              {
                tool: "invalid",
                parameters: { tool: "bash", failure: "unknown_tool", error: "forged raw-secret" },
              },
            ],
          },
          context(session.id, second),
        ),
      ).rejects.toBeInstanceOf(InvalidCall.RepeatedError)
      expect(
        (await MessageV2.parts(second)).filter((part) => part.type === "tool" && part.tool === "bash"),
      ).toHaveLength(0)
      await Session.remove(session.id)
    },
  })
})

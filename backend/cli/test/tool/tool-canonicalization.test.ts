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

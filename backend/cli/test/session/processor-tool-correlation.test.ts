import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionProcessor } from "../../src/session/processor"
import { ToolRetryGuard } from "../../src/session/tool-retry-guard"
import { BashTool } from "../../src/tool/bash"
import type { Tool } from "../../src/tool/tool"
import { executionSession, tmpdir } from "../fixture/fixture"

function running(callID: string, input: Record<string, unknown> = {}): MessageV2.ToolPart {
  return {
    id: `part_${callID}`,
    sessionID: "ses_tool_correlation",
    messageID: "msg_tool_correlation",
    type: "tool",
    callID,
    tool: "fixture",
    state: {
      status: "running",
      input,
      time: { start: 100 },
    },
  }
}

function fixture() {
  const updates: MessageV2.ToolPart[] = []
  const rejected: unknown[] = []
  const coordinator = SessionProcessor.createToolOutcomeCoordinator({
    abort: new AbortController().signal,
    async updatePart(part) {
      updates.push(part)
    },
    onRejected(error) {
      rejected.push(error)
    },
  })
  return { coordinator, updates, rejected }
}

describe("SessionProcessor tool outcome correlation", () => {
  test("persists native execution success that settles before tool-call and has no streamed tool-result", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const args = { query: "EGFR" }
        const output = { title: "Fetch target", output: "CHEMBL203", metadata: { count: 1 } }
        const coordinator = SessionProcessor.createToolOutcomeCoordinator({
          abort: new AbortController().signal,
          updatePart: Session.updatePart,
        })

        await expect(coordinator.execute("call_success", args, async () => output)).resolves.toEqual(output)
        const part = { ...running("call_success", args), sessionID: session.id }
        await coordinator.running(part)

        expect((await MessageV2.parts(part.messageID)).find((item) => item.id === part.id)).toMatchObject({
          type: "tool",
          callID: "call_success",
          state: {
            status: "completed",
            input: args,
            output: "CHEMBL203",
            title: "Fetch target",
            metadata: { count: 1 },
            time: { start: 100 },
          },
        })
        await Session.remove(session.id)
      },
    })
  })

  test("persists execution error that settles before tool-call and has no streamed tool-result", async () => {
    const { coordinator, updates, rejected } = fixture()
    const failure = new Error("connector rejected the query")

    await expect(
      coordinator.execute("call_error", { query: "bad" }, async () => {
        throw failure
      }),
    ).rejects.toThrow("connector rejected the query")
    expect(updates).toHaveLength(0)

    await coordinator.running(running("call_error", { query: "bad" }))

    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({
      callID: "call_error",
      state: {
        status: "error",
        input: { query: "bad" },
        error: "connector rejected the query",
        time: { start: 100 },
      },
    })
    expect(rejected).toEqual([failure])
  })

  test("persists retry state as error metadata without exposing internal markers", async () => {
    const { coordinator, updates } = fixture()
    const ctx = {
      sessionID: "session_retry_metadata",
      messageID: "message_retry_metadata",
      callID: "call_retry_metadata",
      agent: "research",
      abort: new AbortController().signal,
      messages: [],
      metadata() {},
      async ask() {},
    } as Tool.Context
    const failure = ToolRetryGuard.annotateKernelTimeout(
      ctx,
      { code: "import time\ntime.sleep(30)", environment: "custom", timeout: 120_000 },
      "python",
      "custom",
      new Error("Cell execution timed out after 120s"),
    )

    expect(failure.message).toBe("Cell execution timed out after 120s")
    expect(failure.message).not.toContain("[openscience-")
    await expect(
      coordinator.execute("call_retry_metadata", {}, async () => {
        throw failure
      }),
    ).rejects.toThrow("Cell execution timed out after 120s")
    await coordinator.running(running("call_retry_metadata"))

    expect(updates.at(-1)).toMatchObject({
      state: {
        status: "error",
        error: "Cell execution timed out after 120s",
        metadata: {
          openscienceRetryGuard: {
            version: 1,
            kind: "failure",
            failure: { code: "kernel_timeout", tool: "python", environment: "custom" },
          },
        },
      },
    })
    expect(JSON.stringify(updates.at(-1))).not.toContain("[openscience-")
  })

  test("drains an execute promise that settles just after the provider stream closes", async () => {
    const { coordinator, updates } = fixture()
    const gate = Promise.withResolvers<{ title: string; output: string; metadata: { source: string } }>()
    const execution = coordinator.execute("call_late", {}, () => gate.promise)
    await coordinator.running(running("call_late"))

    let drained = false
    const drain = coordinator.drain().then(() => {
      drained = true
    })
    await Bun.sleep(5)
    expect(drained).toBeFalse()

    gate.resolve({ title: "Late result", output: "retained", metadata: { source: "execute" } })
    await expect(execution).resolves.toMatchObject({ output: "retained" })
    await drain

    expect(drained).toBeTrue()
    expect(updates.at(-1)).toMatchObject({
      callID: "call_late",
      state: { status: "completed", output: "retained", metadata: { source: "execute" } },
    })
  })

  test("does not let a late duplicate stream event overwrite the execute outcome", async () => {
    const { coordinator, updates } = fixture()
    await coordinator.running(running("call_duplicate"))
    await coordinator.execute("call_duplicate", {}, async () => ({
      title: "Authoritative execute result",
      output: "kept",
      metadata: { source: "execute" },
    }))

    await coordinator.result(
      "call_duplicate",
      {},
      {
        title: "Late stream result",
        output: "must not replace",
        metadata: { source: "stream" },
      },
    )

    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({
      state: { title: "Authoritative execute result", output: "kept", metadata: { source: "execute" } },
    })
  })

  test("serializes a delayed progress update before a successful terminal result", async () => {
    const updates: MessageV2.ToolPart[] = []
    const metadataGate = Promise.withResolvers<void>()
    const metadataStarted = Promise.withResolvers<void>()
    const coordinator = SessionProcessor.createToolOutcomeCoordinator({
      abort: new AbortController().signal,
      async updatePart(part) {
        if (part.state.status === "running" && part.state.metadata?.source === "progress") {
          metadataStarted.resolve()
          await metadataGate.promise
        }
        updates.push(part)
      },
    })
    await coordinator.running(running("call_metadata_success", { command: "unzip -l data.zip" }))
    coordinator.metadata(
      "call_metadata_success",
      { command: "unzip -l data.zip" },
      {
        title: "Listing archive",
        metadata: { source: "progress" },
      },
    )
    await metadataStarted.promise

    const execution = coordinator.execute("call_metadata_success", {}, async () => ({
      title: "Listed archive",
      output: "Archive: data.zip",
      metadata: { exit: 0, truncated: false },
    }))
    let completed = false
    void execution.then(() => {
      completed = true
    })
    await Bun.sleep(5)
    expect(completed).toBeFalse()

    metadataGate.resolve()
    await execution
    await coordinator.drain()

    expect(updates.at(-1)).toMatchObject({
      callID: "call_metadata_success",
      state: {
        status: "completed",
        output: "Archive: data.zip",
        metadata: { exit: 0, truncated: false },
      },
    })
    expect(await coordinator.reconcile(running("call_metadata_success"))).toBeTrue()
    expect(updates.at(-1)?.state.status).toBe("completed")
  })

  test("keeps a nonzero shell result terminal after delayed progress metadata", async () => {
    const { coordinator, updates } = fixture()
    await coordinator.running(running("call_metadata_nonzero", { command: "python -V" }))
    coordinator.metadata(
      "call_metadata_nonzero",
      { command: "python -V" },
      {
        title: "Running command",
        metadata: { output: "", provenanceID: "prov_1" },
      },
    )
    await coordinator.execute("call_metadata_nonzero", {}, async () => ({
      title: "Runs command",
      output: "python: command not found",
      metadata: { exit: 127, truncated: false },
    }))
    await coordinator.drain()

    expect(updates.at(-1)).toMatchObject({
      state: {
        status: "completed",
        output: "python: command not found",
        metadata: { exit: 127, truncated: false },
      },
    })
  })

  test("keeps real Bash exit 0 and exit 127 results durable when the stream closes during metadata writes", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const bash = await BashTool.init()

        const run = async (input: {
          callID: string
          command: string
          description: string
          output: string
          exit: number
        }) => {
          const messageID = Identifier.ascending("message")
          const part: MessageV2.ToolPart = {
            id: Identifier.ascending("part"),
            sessionID: session.id,
            messageID,
            type: "tool",
            callID: input.callID,
            tool: "bash",
            state: {
              status: "running",
              input: { command: input.command, description: input.description },
              time: { start: Date.now() },
            },
          }
          await Session.updatePart(part)

          const metadataStarted = Promise.withResolvers<void>()
          const releaseMetadata = Promise.withResolvers<void>()
          const abort = new AbortController()
          let delayedMetadata = false
          const coordinator = SessionProcessor.createToolOutcomeCoordinator({
            abort: abort.signal,
            async updatePart(next) {
              if (!delayedMetadata && next.state.status === "running" && next.state.metadata) {
                delayedMetadata = true
                metadataStarted.resolve()
                await releaseMetadata.promise
              }
              await Session.updatePart(next)
            },
          })
          await coordinator.running(part)

          const args = { command: input.command, description: input.description }
          const execution = coordinator.execute(input.callID, args, () =>
            bash.execute(args, {
              sessionID: session.id,
              messageID,
              callID: input.callID,
              agent: "research",
              abort: abort.signal,
              messages: [],
              metadata(value) {
                coordinator.metadata(input.callID, args, value)
              },
              async ask() {},
            }),
          )

          await metadataStarted.promise
          let drained = false
          const drain = coordinator.drain().then(() => {
            drained = true
          })
          await Bun.sleep(5)
          expect(drained).toBeFalse()
          releaseMetadata.resolve()

          await drain
          await execution

          const stored = (await MessageV2.parts(messageID)).find(
            (candidate) => candidate.type === "tool" && candidate.callID === input.callID,
          )
          expect(stored).toMatchObject({
            type: "tool",
            callID: input.callID,
            state: {
              status: "completed",
              output: expect.stringContaining(input.output),
              metadata: {
                output: expect.stringContaining(input.output),
                exit: input.exit,
                provenanceID: expect.any(String),
              },
              time: {
                start: expect.any(Number),
                end: expect.any(Number),
              },
            },
          })
          expect(JSON.stringify(stored)).not.toContain("Tool execution aborted")
        }

        await run({
          callID: "call_bash_exit_0",
          command: "printf 'archive listing retained\\n'",
          description: "Lists archive contents",
          output: "archive listing retained",
          exit: 0,
        })
        await run({
          callID: "call_bash_exit_127",
          command: "printf 'command not found retained\\n' >&2; exit 127",
          description: "Runs unavailable command",
          output: "command not found retained",
          exit: 127,
        })

        await Session.remove(session.id)
      },
    })
  }, 30_000)

  test("routes both native and MCP execute promises through the same tracked processor path", async () => {
    const source = await Bun.file(new URL("../../src/session/prompt.ts", import.meta.url)).text()
    expect(source.match(/input\.processor\.executeTool\(/g)).toHaveLength(2)
  })
})

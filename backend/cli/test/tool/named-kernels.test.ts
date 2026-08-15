import { expect, test } from "bun:test"
import z from "zod"
import { Instance } from "../../src/project/instance"
import { KernelRuntime, type KernelIdentity } from "../../src/science/kernel/registry"
import { NotebookTool, PythonTool } from "../../src/tool/notebook"
import { RKernelTool, RTool } from "../../src/tool/rkernel"
import { executionSession, sandboxedExecution, tmpdir } from "../fixture/fixture"
import { ToolRetryGuard } from "../../src/session/tool-retry-guard"

async function captureError(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
  throw new Error("Expected operation to fail")
}

const context = (sessionID: string, callID: string, messages: ToolMessages = []) => ({
  sessionID,
  messageID: "message_managed_runtimes",
  callID,
  agent: "research",
  abort: new AbortController().signal,
  messages,
  metadata() {},
  async ask() {},
})

type ToolMessages = import("../../src/tool/tool").Tool.Context["messages"]

function messageHistory(input: {
  sessionID: string
  tool: "python" | "r"
  callID: string
  args: Record<string, unknown>
  error: string
}) {
  return [
    {
      info: { id: "message_timeout_history", sessionID: input.sessionID, role: "assistant" },
      parts: [
        {
          id: "part_timeout_history",
          sessionID: input.sessionID,
          messageID: "message_timeout_history",
          type: "tool",
          tool: input.tool,
          callID: input.callID,
          state: { status: "error", input: input.args, error: input.error, time: { start: 1, end: 2 } },
        },
      ],
    },
  ] as unknown as import("../../src/tool/tool").Tool.Context["messages"]
}

test("canonical Python and R expose one fixed runtime per conversation and environment", async () => {
  const python = await PythonTool.init()
  const r = await RTool.init()
  const pythonSchema = JSON.stringify(z.toJSONSchema(python.parameters))
  const rSchema = JSON.stringify(z.toJSONSchema(r.parameters))

  expect(python.description).toContain("one long-lived managed process per conversation and selected environment")
  expect(python.description).toContain("child conversations and other environments are isolated")
  expect(python.description).toContain("automatically restart this environment after success")
  expect(r.description).toContain("one long-lived managed process per conversation")
  expect(r.description).toContain("automatically restart R after success")
  expect(python.parameters.parse({ code: "1 + 1", environment: "nbody" }).environment).toBe("nbody")
  expect(() => python.parameters.parse({ code: "1 + 1", environment: "../nbody" })).toThrow("path separators")
  expect(() => python.parameters.parse({ code: "1 + 1", kernel: "alternate" })).toThrow("Unrecognized key")
  expect(() => r.parameters.parse({ code: "1 + 1", kernel: "alternate" })).toThrow("Unrecognized key")
  expect(pythonSchema).not.toContain('"kernel"')
  expect(rSchema).not.toContain('"kernel"')
  expect(python.description).not.toMatch(/notebook|cell|Jupyter|magic/i)
  expect(r.description).not.toMatch(/notebook|cell|Jupyter|magic/i)
  expect(pythonSchema).not.toMatch(/notebook|cell|Jupyter|magic/i)
  expect(rSchema).not.toMatch(/notebook|cell|Jupyter|magic/i)
})

test("hidden compatibility aliases alone retain named-runtime input", async () => {
  const notebook = await NotebookTool.init()
  const rkernel = await RKernelTool.init()

  expect(notebook.parameters.parse({ code: "1 + 1", kernel: "legacy-python" }).kernel).toBe("legacy-python")
  expect(rkernel.parameters.parse({ code: "1 + 1", kernel: "legacy-r" }).kernel).toBe("legacy-r")
  expect(() => notebook.parameters.parse({ code: "1 + 1", kernel: "invalid name" })).toThrow()
})

test("same conversation and environment reuses one Python process while child conversations isolate state", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = await executionSession()
      const child = await executionSession()
      const tool = await PythonTool.init()
      const identity = (sessionID: string): KernelIdentity => ({
        projectID: Instance.project.id,
        sessionID,
        name: "python",
        language: "python",
      })

      try {
        const first = await tool.execute(
          { code: "state_value = 41\nprint(state_value)", timeout: 30_000 },
          context(parent.id, "call_parent_first"),
        )
        const parentPID = KernelRuntime.status(identity(parent.id)).process_id
        const second = await tool.execute(
          { code: "state_value += 1\nprint(state_value)", timeout: 30_000 },
          context(parent.id, "call_parent_second"),
        )
        const childResult = await tool.execute(
          { code: "print('state_value' in globals())", timeout: 30_000 },
          context(child.id, "call_child"),
        )

        expect(first.output.trim()).toBe("41")
        expect(second.output.trim()).toBe("42")
        expect(KernelRuntime.status(identity(parent.id)).process_id).toBe(parentPID)
        expect(childResult.output.trim()).toBe("False")
        expect(KernelRuntime.status(identity(child.id)).process_id).not.toBe(parentPID)
      } finally {
        await Promise.all([KernelRuntime.release(identity(parent.id)), KernelRuntime.release(identity(child.id))])
      }
    },
  })
}, 60_000)

test("a timed-out Python cell fully retires its process before the next call starts clean", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await executionSession()
      const tool = await PythonTool.init()
      const identity: KernelIdentity = {
        projectID: Instance.project.id,
        sessionID: session.id,
        name: "python",
        language: "python",
      }

      try {
        const timeoutArgs = { code: "import time\ntime.sleep(30)", timeout: 5_000 }
        const timedOut = tool.execute(timeoutArgs, context(session.id, "call_timeout"))
        const timeoutError = await captureError(timedOut)
        expect(timeoutError.message).toContain("Cell execution timed out after 5s")
        expect(ToolRetryGuard.errorMetadata(timeoutError)).toMatchObject({
          openscienceRetryGuard: {
            kind: "failure",
            failure: { code: "kernel_timeout", tool: "python", timeout_ms: 5_000 },
          },
        })
        expect(KernelRuntime.status(identity)).toMatchObject({ active: false, state: "stopped", process_id: null })

        const recovered = await tool.execute(
          { code: "print('fresh-after-timeout')", timeout: 30_000 },
          context(session.id, "call_after_timeout"),
        )
        expect(recovered.output.trim()).toBe("fresh-after-timeout")
        expect(KernelRuntime.status(identity)).toMatchObject({
          active: true,
          state: "idle",
          execution_count: 1,
          incarnation: 2,
        })

        const recoveredPID = KernelRuntime.status(identity).process_id
        const blockedAt = Date.now()
        await expect(
          tool.execute(
            { code: "import time\n\n# cosmetic retry\ntime.sleep(30)", timeout: 120_000 },
            context(
              session.id,
              "call_repeated_timeout",
              messageHistory({
                sessionID: session.id,
                tool: "python",
                callID: "call_timeout",
                args: timeoutArgs,
                error: timeoutError.message,
              }),
            ),
          ),
        ).rejects.toThrow("stopped before starting a new kernel")
        expect(Date.now() - blockedAt).toBeLessThan(1_000)
        expect(KernelRuntime.status(identity)).toMatchObject({
          active: true,
          state: "idle",
          process_id: recoveredPID,
          execution_count: 1,
        })
      } finally {
        await KernelRuntime.release(identity)
      }
    },
  })
}, 60_000)

test.skipIf(!Bun.which("Rscript"))(
  "a timed-out R cell fully retires its process before the next call starts clean",
  async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const tool = await RTool.init()
        const identity: KernelIdentity = {
          projectID: Instance.project.id,
          sessionID: session.id,
          name: "r",
          language: "r",
        }

        try {
          const timedOut = tool.execute(
            { code: "Sys.sleep(30)", timeout: 5_000 },
            context(session.id, "call_r_timeout"),
          )
          await expect(timedOut).rejects.toThrow("Cell execution timed out after 5s")
          expect(KernelRuntime.status(identity)).toMatchObject({
            active: false,
            state: "stopped",
            process_id: null,
          })

          const recovered = await tool.execute(
            { code: "cat('fresh-after-timeout')", timeout: 30_000 },
            context(session.id, "call_r_after_timeout"),
          )
          expect(recovered.output.trim()).toBe("fresh-after-timeout")
          expect(KernelRuntime.status(identity)).toMatchObject({
            active: true,
            state: "idle",
            execution_count: 1,
            incarnation: 2,
          })
        } finally {
          await KernelRuntime.release(identity)
        }
      },
    })
  },
  60_000,
)

test("an interrupt requested during durable start waits for Python to arm SIGINT and preserves state", async () => {
  await using _sandbox = await sandboxedExecution()
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await executionSession()
      const identity: KernelIdentity = {
        projectID: Instance.project.id,
        sessionID: session.id,
        name: "python",
        language: "python",
      }
      try {
        await KernelRuntime.execute(identity, "retained_value = 41", { timeout: 30_000 })
        const running = KernelRuntime.execute(identity, "__import__('time').sleep(10)", {
          timeout: 30_000,
          // Keep the registry in its durable-running / pre-submission window.
          onStart: () => Bun.sleep(500),
        })
        const waitForRunning = async (attempt = 0): Promise<void> => {
          if (KernelRuntime.status(identity).state === "running") return
          if (attempt >= 100) throw new Error("Python execution did not enter its durable running state")
          await Bun.sleep(10)
          return waitForRunning(attempt + 1)
        }
        await waitForRunning()

        const interrupted = await KernelRuntime.interrupt(identity)
        const result = await running
        const resumed = await KernelRuntime.execute(identity, "retained_value + 1", { timeout: 30_000 })

        expect(interrupted).toMatchObject({ active: true, state: "idle", state_preserved: true, incarnation: 1 })
        expect(result.ok).toBe(false)
        expect(result.outputs).toContainEqual(
          expect.objectContaining({ type: "error", error: expect.objectContaining({ name: "KeyboardInterrupt" }) }),
        )
        expect(resumed.outputs).toContainEqual(
          expect.objectContaining({ type: "result", data: { "text/plain": "42" } }),
        )
      } finally {
        await KernelRuntime.release(identity)
      }
    },
  })
}, 60_000)

import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { ApplyPatchTool } from "../../src/tool/apply_patch"
import { ArtifactTool } from "../../src/tool/artifact"
import { AtlasTool } from "../../src/tool/atlas"
import { AtlasRecordTool } from "../../src/tool/atlas-record"
import { BashTool } from "../../src/tool/bash"
import { BatchTool } from "../../src/tool/batch"
import { NotebookTool } from "../../src/tool/notebook"
import { PlanExitTool } from "../../src/tool/plan"
import { PlanMode } from "../../src/tool/plan-mode"
import { PlanWriteTool } from "../../src/tool/planwrite"
import { RKernelTool } from "../../src/tool/rkernel"
import { ReadTool } from "../../src/tool/read"
import { TaskTool } from "../../src/tool/task"
import { TodoReadTool, TodoWriteTool } from "../../src/tool/todo"
import { ToolRegistry } from "../../src/tool/registry"
import { WriteTool } from "../../src/tool/write"
import { executionSession, tmpdir } from "../fixture/fixture"

function context(agent: string, sessionID = "test") {
  return {
    sessionID,
    messageID: "message",
    callID: "call",
    agent,
    abort: new AbortController().signal,
    messages: [],
    metadata() {},
    async ask() {},
  }
}

async function denied(run: () => Promise<unknown>) {
  const error = await run().then(
    () => undefined,
    (cause) => cause,
  )
  expect(error).toBeInstanceOf(PlanMode.DeniedError)
  expect(JSON.parse(error.message)).toEqual({
    code: "PLAN_MODE_SIDE_EFFECT_DENIED",
    mode: "plan",
    tool: error.tool,
    reason: "Plan mode is read-only and cannot execute, write, start jobs, upload, spend, or mutate state.",
    action: "Switch to Act/build mode, then retry the tool and approve any required permission.",
  })
  return error as PlanMode.DeniedError
}

describe("tool.plan-mode", () => {
  test("blocks the complete dispatch envelope before hooks can run", async () => {
    await using tmp = await tmpdir()
    const marker = path.join(tmp.path, "hook-owned")
    const error = await denied(async () =>
      PlanMode.run("unsafe", "plan", async () => {
        await Bun.write(marker, "hook")
      }),
    )
    expect(error.tool).toBe("unsafe")
    expect(await Bun.file(marker).exists()).toBe(false)
  })

  test("blocks adversarial direct execution before any side effect", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const marker = path.join(tmp.path, "owned")
        const patch = "*** Begin Patch\n*** Add File: owned\n+patch\n*** End Patch"
        const calls = [
          async () =>
            (await BashTool.init()).execute(
              { command: "printf shell > owned", description: "Writes an adversarial marker" },
              context("plan"),
            ),
          async () => (await WriteTool.init()).execute({ filePath: marker, content: "write" }, context("plan")),
          async () => (await ApplyPatchTool.init()).execute({ patchText: patch }, context("plan")),
          async () =>
            (await NotebookTool.init()).execute(
              { code: `open(${JSON.stringify(marker)}, "w").write("python")`, timeout: 120_000 },
              context("plan"),
            ),
          async () =>
            (await RKernelTool.init()).execute(
              { code: `write("r", ${JSON.stringify(marker)})`, timeout: 120_000 },
              context("plan"),
            ),
          async () =>
            (await BatchTool.init()).execute(
              {
                tool_calls: [
                  {
                    tool: "bash",
                    parameters: { command: "printf batch > owned", description: "Writes through a batch" },
                  },
                ],
              },
              context("plan"),
            ),
          async () =>
            (await TaskTool.init()).execute(
              {
                description: "Bypass plan gate",
                prompt: "Write the marker file.",
                subagent_type: "research",
              },
              context("plan"),
            ),
          async () =>
            (await AtlasTool.init()).execute(
              { operation: "search", query: "This request must not reach a paid service." },
              context("plan"),
            ),
          async () =>
            (await AtlasRecordTool.init()).execute(
              { project: "project", provenance_id: "provenance" },
              context("plan"),
            ),
          async () =>
            (await ArtifactTool.init()).execute(
              { action: "register", type: "text", content: "must not persist" },
              context("plan"),
            ),
          async () => (await PlanExitTool.init()).execute({}, context("plan")),
        ]

        const errors = []
        for (const call of calls) errors.push(await denied(call))

        expect(errors.map((error) => error.tool)).toEqual([
          "bash",
          "write",
          "apply_patch",
          "notebook",
          "rkernel",
          "batch",
          "task",
          "atlas",
          "atlas_record",
          "artifact",
          "plan_exit",
        ])
        expect(await Bun.file(marker).exists()).toBe(false)
      },
    })
  })

  test("fails closed for project-defined tools", async () => {
    await using tmp = await tmpdir({
      git: true,
      init: async (dir) => {
        const root = path.join(dir, ".openscience", "tool")
        const marker = path.join(dir, "custom-owned")
        await fs.mkdir(root, { recursive: true })
        await Bun.write(
          path.join(root, "unsafe.ts"),
          [
            "export default {",
            "  description: 'unsafe custom tool',",
            "  args: {},",
            "  execute: async () => {",
            `    await Bun.write(${JSON.stringify(marker)}, "custom")`,
            "    return 'custom tool executed'",
            "  },",
            "}",
            "",
          ].join("\n"),
        )
        return marker
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const tools = await ToolRegistry.tools({ modelID: "", providerID: "" })
        const tool = tools.find((item) => item.id === "unsafe")
        expect(tool).toBeDefined()
        const error = await denied(() => tool!.execute({}, context("plan")))
        expect(error.tool).toBe("unsafe")
        expect(await Bun.file(tmp.extra).exists()).toBe(false)
      },
    })
  })

  test("allows granted reads and planning state updates", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = path.join(tmp.path, "input.txt")
        await Bun.write(file, "already granted")
        const session = await Session.create({})
        const ctx = context("plan", session.id)

        const read = await (await ReadTool.init()).execute({ filePath: file }, ctx)
        expect(read.output).toContain("already granted")

        await (
          await PlanWriteTool.init()
        ).execute(
          {
            todos: [{ id: "step-1", content: "Inspect the input", status: "pending", priority: "high" }],
          },
          ctx,
        )
        await (
          await TodoWriteTool.init()
        ).execute(
          {
            todos: [{ id: "step-1", content: "Inspect the input", status: "in_progress", priority: "high" }],
          },
          ctx,
        )
        const todos = await (await TodoReadTool.init()).execute({}, ctx)
        expect(todos.metadata.todos).toEqual([
          { id: "step-1", content: "Inspect the input", status: "in_progress", priority: "high" },
        ])

        await Session.remove(session.id)
      },
    })
  })

  test("keeps Act mode execution unchanged", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await executionSession()
        const marker = path.join(tmp.path, "acted")
        const result = await (
          await BashTool.init()
        ).execute(
          { command: "printf acted > acted", description: "Writes an Act mode marker" },
          context("research", session.id),
        )

        expect(result.metadata.exit).toBe(0)
        expect(await Bun.file(marker).text()).toBe("acted")
        await Session.remove(session.id)
      },
    })
  })
})

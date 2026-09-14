import { describe, expect, test } from "bun:test"
import { availableParallelism } from "node:os"
import path from "node:path"
import { Config } from "../../src/config/config"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { SystemPrompt } from "../../src/session/system"
import type { MessageV2 } from "../../src/session/message-v2"
import { TaskAttempt } from "../../src/tool/task-attempt"
import { childPermissionRules, renderTaskOutput, TaskTool } from "../../src/tool/task"
import { Agent } from "../../src/agent/agent"
import { tmpdir } from "../fixture/fixture"

const model = { providerID: "offline-fixture", modelID: "no-provider-called" }

function assistant(sessionID: string, parentID: string, id: string, created: number) {
  return {
    id,
    sessionID,
    parentID,
    role: "assistant" as const,
    modelID: model.modelID,
    providerID: model.providerID,
    mode: "research",
    agent: "research",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created },
  }
}

/** A parent with one reserved Task call, and a child whose turn already
 * finished with `text` (or a provider error), so no model is ever called. */
async function seeded(input: {
  parent: Session.Info
  child?: Session.Info
  text?: string
  error?: MessageV2.Assistant["error"]
  params: { description: string; prompt: string; subagent_type: string; task_id?: string; background?: boolean }
}) {
  const userID = Identifier.ascending("message")
  const messageID = Identifier.ascending("message")
  const callID = `call_${crypto.randomUUID()}`
  await Session.updateMessage({
    id: userID,
    sessionID: input.parent.id,
    role: "user",
    agent: "research",
    effort: "normal",
    model,
    time: { created: 1 },
  })
  await Session.updateMessage(assistant(input.parent.id, userID, messageID, 2))
  const identity = {
    projectID: Instance.project.id,
    parentSessionID: input.parent.id,
    parentMessageID: messageID,
    parentUserMessageID: userID,
    callID,
  }
  const child = input.child ?? (await Session.create({ parentID: input.parent.id }))
  const attempt = await TaskAttempt.reserve({
    ...identity,
    fingerprint: TaskAttempt.fingerprint({ ...input.params, task_id: input.params.task_id }),
    childSessionID: child.id,
  })
  const previous = (await Session.messages({ sessionID: child.id })).map((message) => message.info.id)
  await TaskAttempt.bind({ ...identity, previousMessageIDs: previous })
  await Session.updateMessage({
    id: attempt.childMessageID,
    sessionID: child.id,
    role: "user",
    agent: input.params.subagent_type,
    effort: "normal",
    model,
    time: { created: 3 },
  })
  const finalID = Identifier.ascending("message")
  await Session.updateMessage({
    ...assistant(child.id, attempt.childMessageID, finalID, 4),
    finish: "stop",
    ...(input.error && { error: input.error }),
    time: { created: 4, completed: 5 },
  })
  if (input.text) {
    await Session.updatePart({
      id: Identifier.ascending("part"),
      sessionID: child.id,
      messageID: finalID,
      type: "text",
      text: input.text,
      time: { start: 4, end: 5 },
    })
  }
  await Session.flushPendingParts(child.id)
  const ctx = {
    sessionID: input.parent.id,
    messageID,
    callID,
    agent: "research",
    abort: new AbortController().signal,
    messages: [] as MessageV2.WithParts[],
    metadata: () => {},
    ask: async () => {},
    extra: { effort: "normal", bypassAgentCheck: true },
  }
  return { child, ctx, identity }
}

describe("Task tool contract", () => {
  test("returns the child's final text inside a <task_result> envelope with a reusable task_id", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})
        const params = { description: "Compare sources", prompt: "Compare the two sources.", subagent_type: "explore" }
        const { child, ctx } = await seeded({ parent, params, text: "## Outcome\nSources agree." })
        const task = await TaskTool.init()
        const result = await task.execute(params, ctx)
        expect(result.output.startsWith(`<task id="${child.id}" state="completed">`)).toBe(true)
        expect(result.output).toContain("<task_result>")
        expect(result.output).toContain("Sources agree.")
        expect(result.output).toContain(`task_id: ${child.id}`)
        expect(result.output.trimEnd().endsWith("</task>")).toBe(true)
        expect(result.metadata).toMatchObject({ sessionId: child.id, outcome: "completed" })
        // The description lists every subagent by name for the model.
        expect(task.description).toContain("- explore:")
        expect(task.description).toContain("- data:")
        expect(task.description).not.toContain("- research:")
      },
    })
  })

  test("a child provider error returns state=error with the partial text instead of failing the call", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})
        const params = { description: "Fit the model", prompt: "Fit and report.", subagent_type: "data" }
        const { child, ctx } = await seeded({
          parent,
          params,
          error: { name: "UnknownError", data: { message: "Provider disconnected" } },
        })
        const result = await (await TaskTool.init()).execute(params, ctx)
        expect(result.output).toContain(`<task id="${child.id}" state="error">`)
        expect(result.output).toContain("<task_error>")
        expect(result.metadata).toMatchObject({ outcome: "error", stopReason: "provider_error" })
      },
    })
  })

  test("task_id resumes the same child session and a foreign id is refused before dispatch", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})
        const first = await Session.create({ parentID: parent.id })
        const params = {
          description: "Continue the review",
          prompt: "Finish the remaining section.",
          subagent_type: "explore",
          task_id: first.id,
        }
        const { child, ctx } = await seeded({ parent, child: first, params, text: "Section finished." })
        expect(child.id).toBe(first.id)
        const result = await (await TaskTool.init()).execute(params, ctx)
        expect(result.metadata.sessionId).toBe(first.id)

        const stranger = await Session.create({})
        await expect(
          (await TaskTool.init()).execute({ ...params, task_id: stranger.id }, { ...ctx, callID: "call_other" }),
        ).rejects.toThrow(/No child session .* exists for this session/)
      },
    })
  })

  test("the depth limit refuses a worker's worker and names the config key", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const lead = await Session.create({})
        const worker = await Session.create({ parentID: lead.id })
        const params = { description: "Nested", prompt: "Delegate again.", subagent_type: "explore" }
        const { ctx } = await seeded({ parent: worker, params, text: "unused" })
        await expect((await TaskTool.init()).execute(params, ctx)).rejects.toThrow(/subagent_depth/)
        expect((await Config.get()).subagent_depth ?? 1).toBe(1)
      },
    })
  })

  test("primaries and unknown names are rejected as subagent types", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})
        for (const name of ["research", "plan", "nonexistent"]) {
          const params = { description: "Bad type", prompt: "x", subagent_type: name }
          const { ctx } = await seeded({ parent, params, text: "unused" })
          await expect((await TaskTool.init()).execute(params, ctx)).rejects.toThrow(/not a valid subagent/)
        }
      },
    })
  })

  test("children work in the parent's directory and inherit denies for todowrite, task and question", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})
        const child = await Session.create({ parentID: parent.id })
        await SessionFilesystem.shareWorkingDirectory({ parentSessionID: parent.id, childSessionID: child.id })
        expect(await SessionFilesystem.toolDirectory(child.id)).toBe(await SessionFilesystem.toolDirectory(parent.id))
        const explore = await Agent.get("explore")
        const rules = childPermissionRules(explore!)
        expect(rules.map((rule) => rule.permission).sort()).toEqual(["question", "task", "todowrite"])
        // An agent whose own ruleset allows todowrite keeps it.
        const allowed = childPermissionRules({
          ...explore!,
          permission: [...explore!.permission, { permission: "todowrite", pattern: "*", action: "allow" }],
        })
        expect(allowed.map((rule) => rule.permission).sort()).toEqual(["question", "task"])
      },
    })
  })

  test("a child of an isolated lead can read and write in the lead's scratch, and nowhere else across the boundary", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ workspace: "isolated" })
        const stranger = await Session.create({ workspace: "isolated" })
        const child = await Session.create({ parentID: parent.id, workspace: "isolated" })
        await SessionFilesystem.shareWorkingDirectory({ parentSessionID: parent.id, childSessionID: child.id })
        const lead = await SessionFilesystem.toolDirectory(parent.id)
        expect(await SessionFilesystem.toolDirectory(child.id)).toBe(lead)
        // The lead's scratch is another session's private workspace; the
        // parent grant is what lets the worker's deliverables land there.
        const deliverable = path.join(lead, "results", "table.csv")
        expect(await SessionFilesystem.allows({ sessionID: child.id, path: deliverable, access: "write" })).toBe(true)
        expect(await SessionFilesystem.allows({ sessionID: child.id, path: deliverable, access: "read" })).toBe(true)
        const elsewhere = path.join(await SessionFilesystem.toolDirectory(stranger.id), "notes.md")
        await expect(
          SessionFilesystem.allows({ sessionID: child.id, path: elsewhere, access: "read" }),
        ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
        // The worker is told whose directory it works in.
        const env = await SystemPrompt.environment({ api: { id: "fixture" }, providerID: "fixture" }, child.id)
        expect(env.join("\n")).toContain(`Working folder: ${lead} (the lead session's working directory`)
      },
    })
  })

  test("many children dispatch at once: there is no concurrency cap", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})
        const count = availableParallelism() * 3
        const runs = await Promise.all(
          Array.from({ length: count }, async (_, index) => {
            const params = { description: `Branch ${index}`, prompt: `Do branch ${index}.`, subagent_type: "explore" }
            const { ctx } = await seeded({ parent, params, text: `branch ${index} done` })
            return { params, ctx }
          }),
        )
        const task = await TaskTool.init()
        const results = await Promise.all(runs.map((run) => task.execute(run.params, run.ctx)))
        expect(results).toHaveLength(count)
        for (const [index, result] of results.entries()) expect(result.output).toContain(`branch ${index} done`)
      },
    })
  })

  test("background dispatch returns state=running and later wakes the parent with the envelope", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})
        const params = {
          description: "Long scan",
          prompt: "Scan everything.",
          subagent_type: "explore",
          background: true,
        }
        const { child, ctx } = await seeded({ parent, params, text: "Scan complete: 12 files." })
        const result = await (await TaskTool.init()).execute(params, ctx)
        expect(result.output).toContain(`<task id="${child.id}" state="running">`)
        expect(result.output).toContain("Do not sleep, poll")
        expect(result.metadata).toMatchObject({ background: true, jobId: child.id })
        // The completion arrives as a synthetic user message in the parent.
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline) {
          const messages = await Session.messages({ sessionID: parent.id })
          const injected = messages
            .flatMap((message) => message.parts)
            .find((part) => part.type === "text" && part.synthetic && part.text.includes("Scan complete: 12 files."))
          if (injected) {
            expect(injected.type === "text" && injected.text).toContain(`<task id="${child.id}" state="completed">`)
            return
          }
          await Bun.sleep(50)
        }
        throw new Error("background completion never reached the parent session")
      },
    })
  })

  test("renderTaskOutput emits OpenCode's envelope for every state", () => {
    expect(renderTaskOutput({ sessionID: "ses_x", state: "completed", text: "done" })).toBe(
      '<task id="ses_x" state="completed">\n<task_result>\ndone\n</task_result>\n</task>',
    )
    expect(renderTaskOutput({ sessionID: "ses_x", state: "error", summary: "boom", text: "partial" })).toBe(
      '<task id="ses_x" state="error">\n<summary>boom</summary>\n<task_error>\npartial\n</task_error>\n</task>',
    )
  })
})

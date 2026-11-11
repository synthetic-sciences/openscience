import { PayloadIntegrity } from "../../src/tool/payload-integrity"
import { describe, expect, test } from "bun:test"
import { availableParallelism } from "node:os"
import path from "node:path"
import { Config } from "../../src/config/config"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionFilesystem } from "../../src/session/filesystem"
import { SystemPrompt } from "../../src/session/system"
import { MessageV2 } from "../../src/session/message-v2"
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
  user?: Partial<MessageV2.User>
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
    ...input.user,
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
  test("a stopped worker passes command stdout to the parent and into compaction", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})
        const params = { description: "Saved command proof", prompt: "Print a marker.", subagent_type: "explore" }
        const { child, ctx } = await seeded({
          parent,
          params,
          error: { name: "MessageAbortedError", data: { message: "Stopped" } },
        })
        const final = (await Session.messages({ sessionID: child.id })).findLast(
          (message) => message.info.role === "assistant",
        )!
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: child.id,
          messageID: final.info.id,
          type: "tool",
          tool: "bash",
          callID: "saved_command_proof",
          state: {
            status: "completed",
            input: { command: "printf TASK_MARKER_46" },
            title: "Print marker",
            output: "TASK_MARKER_46",
            metadata: { exit: 0 },
            time: { start: 4, end: 5 },
          },
        })
        const task = await TaskTool.init()
        const result = await task.execute(params, ctx)
        expect(result.metadata).toMatchObject({ outcome: "partial", stopReason: "cancelled" })
        expect(result.output).toContain('output excerpt="TASK_MARKER_46"')
        const compacted = MessageV2.toolSummary("task", {
          status: "completed",
          title: result.title,
          input: {},
          output: result.output,
          metadata: result.metadata,
          time: { start: 0, end: 1 },
        })
        expect(compacted).toContain('output excerpt="TASK_MARKER_46"')
        expect(compacted).toContain("saved_command_proof")
        expect((await task.execute(params, ctx)).output).toBe(result.output)
      },
    })
  })

  for (const input of [
    {
      name: "normal exit",
      text: "Outcome: Complete\nFindings: fixture report.",
      outcome: "completed",
      reason: "completed",
    },
    {
      name: "explicit incomplete",
      text: "Outcome: Incomplete\nRemaining: fixture checks.",
      outcome: "partial",
      reason: "reported_incomplete",
    },
    { name: "missing report", text: "", outcome: "error", reason: "empty_handoff" },
    {
      name: "provider error",
      text: "Saved partial evidence.",
      error: { name: "UnknownError" as const, data: { message: "Fixture disconnected" } },
      outcome: "partial",
      reason: "provider_error",
    },
    {
      name: "cancelled",
      text: "Saved partial evidence.",
      error: { name: "MessageAbortedError" as const, data: { message: "Fixture stopped" } },
      outcome: "partial",
      reason: "cancelled",
    },
  ]) {
    test(`requires main-agent assessment after ${input.name}, including compacted results`, async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const parent = await Session.create({})
          const params = {
            description: "Assess fixture",
            prompt: "Return evidence for this objective.",
            subagent_type: "explore",
          }
          const { ctx } = await seeded({ parent, params, text: input.text, error: input.error })
          const result = await (await TaskTool.init()).execute(params, ctx)
          expect(result.metadata).toMatchObject({ outcome: input.outcome, stopReason: input.reason })
          expect(result.output).toContain(`Runtime execution: ${input.outcome}`)
          expect(result.output).toContain("Task completion: unverified.")
          expect(result.output).toContain("expected output")
          const compacted = MessageV2.toolSummary("task", {
            status: "completed",
            title: result.title,
            input: {},
            output: result.output,
            metadata: result.metadata,
            time: { start: 0, end: 1 },
          })
          expect(compacted).toContain(`Runtime execution: ${input.outcome}`)
          expect(compacted).toContain(input.reason)
          expect(compacted).toContain("Task completion: unverified.")
        },
      })
    })
  }

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
        // The lead's own denials and directory gates travel to the worker;
        // its allows do not widen the worker.
        const inherited = childPermissionRules(
          explore!,
          [],
          [
            { permission: "bash", pattern: "rm *", action: "deny" },
            { permission: "external_directory", pattern: "/data/*", action: "ask" },
            { permission: "webfetch", pattern: "*", action: "allow" },
          ],
        )
        expect(inherited.slice(0, 2)).toEqual([
          { permission: "bash", pattern: "rm *", action: "deny" },
          { permission: "external_directory", pattern: "/data/*", action: "ask" },
        ])
        expect(inherited.some((rule) => rule.permission === "webfetch")).toBe(false)
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

  test("the lead reads its worker's own scratch, so a report's side outputs open from the lead's transcript", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({ workspace: "isolated" })
        const stranger = await Session.create({ workspace: "isolated" })
        const child = await Session.create({ parentID: parent.id, workspace: "isolated" })
        await SessionFilesystem.shareWorkingDirectory({ parentSessionID: parent.id, childSessionID: child.id })
        await SessionFilesystem.shareWorkerScratch({ parentSessionID: parent.id, childSessionID: child.id })
        const workerScratch = (await SessionFilesystem.list(child.id)).find(
          (grant) => grant.source === "workspace",
        )!.path
        const side = path.join(workerScratch, "figures", "page-1.png")
        expect(await SessionFilesystem.allows({ sessionID: parent.id, path: side, access: "read" })).toBe(true)
        await expect(
          SessionFilesystem.allows({ sessionID: parent.id, path: side, access: "write" }),
        ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
        // Only a direct child's scratch; another session's stays private.
        const other = (await SessionFilesystem.list(stranger.id)).find((grant) => grant.source === "workspace")!.path
        await expect(
          SessionFilesystem.allows({ sessionID: parent.id, path: path.join(other, "notes.md"), access: "read" }),
        ).rejects.toBeInstanceOf(SessionFilesystem.DeniedError)
        // Granting twice keeps one grant.
        await SessionFilesystem.shareWorkerScratch({ parentSessionID: parent.id, childSessionID: child.id })
        const handoffs = (await SessionFilesystem.list(parent.id)).filter(
          (grant) => grant.source === "handoff" && grant.path === workerScratch,
        )
        expect(handoffs).toHaveLength(1)
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

  test("background pre-dispatch failures carry runtime facts and require parent assessment", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = await Session.create({})
        const original = "Preserve this complete historical argument. ".repeat(30)
        const params = {
          description: "Guarded background task",
          prompt: PayloadIntegrity.legacyPreview(original),
          subagent_type: "explore",
          background: true,
        }
        const { child, ctx } = await seeded({ parent, params, text: "A historical report must not run." })
        await Session.updatePart({
          id: Identifier.ascending("part"),
          sessionID: parent.id,
          messageID: ctx.messageID,
          type: "tool",
          tool: "write",
          callID: "historical_write",
          state: {
            status: "completed",
            input: { content: original },
            title: "Saved historical content",
            output: "Saved",
            metadata: {},
            time: { start: 1, end: 2 },
          },
        })
        ctx.messages.push(...(await Session.messages({ sessionID: parent.id })))
        const before = await Session.messages({ sessionID: child.id })
        const result = await (await TaskTool.init()).execute(params, ctx)
        expect(result.output).toContain('state="running"')
        const deadline = Date.now() + 10000
        while (Date.now() < deadline) {
          const messages = await Session.messages({ sessionID: parent.id })
          const injected = messages
            .flatMap((message) => message.parts)
            .find(
              (part) => part.type === "text" && part.synthetic && part.text.includes("shortened historical argument"),
            )
          if (injected?.type === "text") {
            expect(injected.text).toContain("Runtime execution: error")
            expect(injected.text).toContain("provider_error")
            expect(injected.text).toContain("Task completion: unverified.")
            expect(await Session.messages({ sessionID: child.id })).toEqual(before)
            return
          }
          await Bun.sleep(20)
        }
        throw new Error("Background failure did not reach its parent")
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

  test("a background worker's report carries the turn's settings into the parent", async () => {
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
        const delegationSettings = {
          level: "standard" as const,
          autonomy: "autonomous" as const,
          workerModel: { providerID: "offline-fixture", modelID: "worker-model" },
        }
        const { ctx } = await seeded({
          parent,
          params,
          text: "Scan complete: 3 files.",
          user: { effort: "ultra", delegationSettings, system: "Project context.", deadline: 4_102_444_800_000 },
        })
        await (await TaskTool.init()).execute(params, ctx)
        const deadline = Date.now() + 10_000
        while (Date.now() < deadline) {
          const messages = await Session.messages({ sessionID: parent.id })
          const wake = messages.find((message) =>
            message.parts.some((part) => part.type === "text" && part.synthetic && part.text.includes("Scan complete")),
          )
          if (wake && wake.info.role === "user") {
            // The report continues the same turn: the loop resolves autonomy,
            // the worker model and the posture from the newest user message,
            // so a wake with defaults would silently change all three.
            expect(wake.info.delegationSettings).toEqual(delegationSettings)
            expect(wake.info.effort).toBe("ultra")
            expect(wake.info.system).toBe("Project context.")
            // The budget unit anchors the time budget to the message that set
            // the deadline; a wake carrying it would restart the clock.
            expect(wake.info.deadline).toBeUndefined()
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

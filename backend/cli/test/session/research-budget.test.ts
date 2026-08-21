import { expect, test } from "bun:test"
import path from "node:path"
import { Global } from "../../src/global"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import type { MessageV2 } from "../../src/session/message-v2"
import { SessionResearch } from "../../src/session/research"
import { SessionTraceStore } from "../../src/session/trace-store"
import { JsonStore } from "../../src/util/jsonstore"
import { tmpdir } from "../fixture/fixture"

function assistant(sessionID: string, id: string, tokens = 100): MessageV2.Assistant {
  const now = Date.now()
  return {
    id,
    sessionID,
    role: "assistant",
    parentID: `msg_user_${id}`,
    modelID: "test-model",
    providerID: "test-provider",
    mode: "research",
    agent: "research",
    path: { cwd: Instance.directory, root: Instance.worktree },
    cost: 0.1,
    tokens: { input: tokens, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    time: { created: now - 10, completed: now },
    finish: "stop",
  }
}

test("runtime limits count the complete session tree and preserve two finalization calls", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const root = await Session.create({ title: "bounded research" })
      const child = await Session.create({ title: "bounded child", parentID: root.id })
      try {
        await SessionResearch.define(root.id, {
          objective: "Bound the complete run",
          domain: "general",
          template: "minimal",
          limits: { modelCalls: 5, toolCalls: 20, tokens: 10_000, wallClockMs: 60_000, costUsd: 10 },
        })
        await SessionResearch.define(root.id, {
          objective: "Cannot reset the bound",
          domain: "general",
          template: "minimal",
          limits: { modelCalls: 40, toolCalls: 10 },
        })
        expect((await SessionResearch.read(root.id))?.budget.limits).toMatchObject({ modelCalls: 5, toolCalls: 10 })
        expect((await SessionResearch.runtimePreflight(child.id)).decision).toBe("allow")

        await Promise.all([
          Session.updateMessage(assistant(root.id, "msg_assistant_root")),
          Session.updateMessage(assistant(child.id, "msg_assistant_child")),
        ])
        await SessionTraceStore.recordRetry({
          sessionID: child.id,
          messageID: "msg_assistant_child",
          attempt: 1,
          message: "retryable provider failure",
          delayMs: 1,
        })
        const first = await SessionResearch.runtimePreflight(root.id)
        const usage = first.usage
        if (!usage) throw new Error("Expected finalization usage")
        expect(usage.wallClockMs).toBeGreaterThanOrEqual(0)
        expect(usage.wallClockMs).toBeLessThan(20)
        expect(first).toMatchObject({
          decision: "finalize",
          finalizationCall: 1,
          usage: { modelCalls: 4, tokens: 200, costUsd: 0.2 },
        })
        expect(first.reason).toContain("model-call limit")
        expect(await SessionResearch.runtimePreflight(root.id)).toMatchObject({
          decision: "finalize",
          finalizationCall: 2,
        })
        expect(await SessionResearch.runtimePreflight(root.id)).toMatchObject({
          decision: "block",
          boundary: "hard",
        })
        expect((await SessionResearch.read(root.id))?.budget).toMatchObject({
          runtimeFinalizationCalls: 2,
          runtimeModelCalls: 5,
          runtimeFinalizing: false,
          runtimeExhausted: true,
        })
      } finally {
        await SessionResearch.remove(root.id)
        await Session.remove(root.id)
      }
    },
  })
})

test("ordinary sessions without a research contract are never budget-gated", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ title: "ordinary chat" })
      try {
        expect(await SessionResearch.runtimePreflight(session.id)).toEqual({ decision: "allow" })
      } finally {
        await Session.remove(session.id)
      }
    },
  })
})

test("a contract starts a fresh usage epoch instead of charging earlier session history", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ title: "late bounded research" })
      try {
        await Session.updateMessage(assistant(session.id, "msg_assistant_history", 9_000))
        const contract = await SessionResearch.define(session.id, {
          objective: "Bound only the new work",
          domain: "general",
          template: "minimal",
          limits: { modelCalls: 100, tokens: 1_000 },
        })
        expect(contract.budget.runtimeBaseline).toMatchObject({ modelCalls: 1, tokens: 9_000 })
        expect(await SessionResearch.runtimePreflight(session.id)).toMatchObject({
          decision: "allow",
          usage: { modelCalls: 1, tokens: 0 },
        })

        await Session.updateMessage(assistant(session.id, "msg_assistant_epoch", 900))
        expect(await SessionResearch.runtimePreflight(session.id)).toMatchObject({
          decision: "finalize",
          usage: { tokens: 900 },
        })
      } finally {
        await SessionResearch.remove(session.id)
        await Session.remove(session.id)
      }
    },
  })
})

test("legacy contracts discard lifetime reservations when reconstructing their creation-time baseline", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ title: "legacy bounded research" })
      try {
        await Session.updateMessage(assistant(session.id, "msg_assistant_legacy_history", 9_000))
        await SessionResearch.define(session.id, {
          objective: "Migrate the bounded run",
          domain: "general",
          template: "minimal",
          limits: { modelCalls: 10, tokens: 1_000 },
        })
        const file = path.join(Global.Path.data, "research", `${encodeURIComponent(session.id)}.json`)
        await JsonStore.update(file, (data) => {
          const budget = data.budget as Record<string, unknown>
          delete budget.runtimeBaseline
          budget.runtimeModelCalls = 9
          budget.runtimeFinalizationCalls = 2
          budget.runtimeFinalizing = true
          budget.runtimeExhausted = true
        })

        expect(await SessionResearch.runtimePreflight(session.id)).toMatchObject({
          decision: "allow",
          usage: { modelCalls: 1, tokens: 0 },
        })
        expect((await SessionResearch.read(session.id))?.budget).toMatchObject({
          runtimeModelCalls: 1,
          runtimeFinalizationCalls: 0,
          runtimeFinalizing: false,
          runtimeExhausted: false,
          runtimeBaseline: { modelCalls: 1, tokens: 9_000 },
        })
      } finally {
        await SessionResearch.remove(session.id)
        await Session.remove(session.id)
      }
    },
  })
})

test("an explicit continuation starts a new bounded epoch without resetting contract progress", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ title: "resumable bounded research" })
      try {
        const contract = await SessionResearch.define(session.id, {
          objective: "Preserve the scientific state",
          domain: "general",
          template: "minimal",
          limits: { modelCalls: 100, tokens: 1_000 },
        })
        await Session.updateMessage(assistant(session.id, "msg_assistant_soft_boundary", 900))
        expect((await SessionResearch.runtimePreflight(session.id)).decision).toBe("finalize")
        expect((await SessionResearch.runtimePreflight(session.id)).finalizationCall).toBe(2)
        expect((await SessionResearch.read(session.id))?.budget).toMatchObject({
          runtimeFinalizing: true,
          runtimeFinalizationCalls: 2,
          runtimeExhausted: false,
        })

        const resumed = await SessionResearch.resume(session.id)
        expect(resumed).toMatchObject({ resumed: true, epoch: 2, sessionID: session.id })
        const next = (await SessionResearch.read(session.id))!
        expect(next.objective).toBe(contract.objective)
        expect(next.stages).toEqual(contract.stages)
        expect(next.checks).toEqual(contract.checks)
        expect(next.budget).toMatchObject({
          runtimeEpoch: 2,
          runtimeFinalizationCalls: 0,
          runtimeModelCalls: 0,
          runtimeFinalizing: false,
          runtimeExhausted: false,
          lastUsage: { modelCalls: 0, toolCalls: 0, tokens: 0, wallClockMs: 0, costUsd: 0 },
        })
        expect(await SessionResearch.runtimePreflight(session.id)).toMatchObject({
          decision: "allow",
          usage: { modelCalls: 1, tokens: 0 },
        })
      } finally {
        await SessionResearch.remove(session.id)
        await Session.remove(session.id)
      }
    },
  })
})

test("only an unambiguous continuation reply authorizes a fresh runtime epoch", () => {
  expect(SessionResearch.resumeIntent([{ type: "text", text: "continue" }])).toBe(true)
  expect(SessionResearch.resumeIntent([{ type: "text", text: "Please resume!" }])).toBe(true)
  expect(SessionResearch.resumeIntent([{ type: "text", text: "contine" }])).toBe(true)
  expect(SessionResearch.resumeIntent([{ type: "text", text: "??" }])).toBe(false)
  expect(SessionResearch.resumeIntent([{ type: "text", text: "continue", synthetic: true }])).toBe(false)
  expect(SessionResearch.resumeIntent([{ type: "text", text: "continue" }, { type: "file" }])).toBe(false)
})

test("parallel child preflights reserve model calls atomically against the parent contract", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const root = await Session.create({ title: "parallel bounded research" })
      const child = await Session.create({ title: "parallel bounded child", parentID: root.id })
      try {
        await SessionResearch.define(root.id, {
          objective: "Bound parallel work",
          domain: "general",
          template: "minimal",
          limits: { modelCalls: 4 },
        })
        await SessionResearch.define(child.id, {
          objective: "A child contract cannot bypass its parent",
          domain: "general",
          template: "minimal",
          limits: { modelCalls: 100 },
        })
        const decisions = await Promise.all(Array.from({ length: 8 }, () => SessionResearch.runtimePreflight(child.id)))
        expect(decisions.filter((item) => item.decision === "allow")).toHaveLength(2)
        expect(decisions.filter((item) => item.decision === "finalize")).toHaveLength(2)
        expect(decisions.filter((item) => item.decision === "block")).toHaveLength(4)
        expect((await SessionResearch.read(root.id))?.budget).toMatchObject({
          runtimeModelCalls: 4,
          runtimeFinalizationCalls: 2,
          runtimeExhausted: true,
        })
      } finally {
        await SessionResearch.remove(child.id)
        await SessionResearch.remove(root.id)
        await Session.remove(root.id)
      }
    },
  })
})

import { expect, test } from "bun:test"
import { CallAudit } from "../../src/session/call-audit"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { UsageLogging } from "../../src/session/usage-logging"
import { SessionTraceStore } from "../../src/session/trace-store"
import { tmpdir } from "../fixture/fixture"

async function step(sessionID: string, messageID: string, input: { route: "byok" | "chatgpt"; call: string }) {
  await Session.updateMessage({
    id: messageID,
    sessionID,
    role: "assistant",
    parentID: "msg_user",
    mode: "research",
    agent: "research",
    path: { cwd: Instance.directory, root: Instance.worktree },
    cost: 0,
    tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 0 } },
    modelID: "fixture-model",
    providerID: input.route === "chatgpt" ? "openai-codex" : "openai",
    time: { created: 1, completed: 2 },
  })
  await Session.updatePart({
    id: `prt_${input.call}`,
    sessionID,
    messageID,
    type: "step-finish",
    reason: "stop",
    cost: 0,
    tokens: { input: 10, output: 2, reasoning: 1, cache: { read: 3, write: 0 } },
    usage: {
      route: input.route,
      provider: input.route === "chatgpt" ? "openai-codex" : "openai",
      model: "fixture-model",
      time: 1_750_000_000_000,
      call: input.call,
      providerRequest: `resp_${input.call}`,
    },
  })
}

test("a session audit includes BYOK and ChatGPT calls from child sessions without content", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const lead = await Session.create({ title: "Private research title" })
      const worker = await Session.create({ parentID: lead.id, title: "Private worker title" })
      await SessionTraceStore.recordModelCall({
        id: "call-summary",
        sessionID: lead.id,
        messageID: "summary:msg_byok",
        route: "chatgpt",
        provider: "openai-codex",
        model: "fixture-model",
        occurredAt: 1_749_999_999_000,
        providerRequest: "resp_call-summary",
      })
      await SessionTraceStore.recordModelCall({
        id: "call-byok",
        sessionID: lead.id,
        messageID: "msg_byok",
        route: "byok",
        provider: "openai",
        model: "fixture-model",
        occurredAt: 1_750_000_000_000,
        providerRequest: "resp_call-byok",
      })
      await step(lead.id, "msg_byok", { route: "byok", call: "call-byok" })
      await step(worker.id, "msg_chatgpt", { route: "chatgpt", call: "call-chatgpt" })

      const report = await CallAudit.report(lead.id)

      expect(report.sessions).toHaveLength(2)
      expect(report.sessions.every((session) => /^[0-9a-f]{64}$/.test(session.telemetrySessionID))).toBe(true)
      expect(report.sessions[0].telemetrySessionID).toBe(await UsageLogging.telemetrySessionID(lead.id))
      expect(report.sessions[1].telemetrySessionID).toBe(await UsageLogging.telemetrySessionID(worker.id))
      expect(report.calls.map((call) => call.route)).toEqual(["chatgpt", "byok", "chatgpt"])
      expect(report.calls.map((call) => call.providerRequest)).toEqual([
        "resp_call-summary",
        "resp_call-byok",
        "resp_call-chatgpt",
      ])
      expect(report.calls.find((call) => call.httpCall === "call-summary")?.stepID).toBeUndefined()
      expect(report.calls.filter((call) => call.httpCall === "call-byok")).toHaveLength(1)
      expect(report.calls.find((call) => call.httpCall === "call-summary")?.cost).toEqual({
        source: "subscription",
        amountUSD: null,
      })
      expect(report.calls.find((call) => call.httpCall === "call-chatgpt")?.cost).toEqual({
        source: "subscription",
        amountUSD: null,
      })
      expect(report.calls.find((call) => call.httpCall === "call-byok")?.cost).toEqual({
        source: "recorded_unclassified",
        amountUSD: 0,
      })
      expect(JSON.stringify(report)).not.toContain("Private research title")
      expect(JSON.stringify(report)).not.toContain("Private worker title")
    },
  })
})

test("audit separates provider-reported zero and positive costs from unknown and legacy accounting", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      for (const receipt of [
        { id: "zero", cost: 0 },
        { id: "paid", cost: 0.0123 },
        { id: "unknown", cost: null },
        { id: "legacy", cost: undefined },
      ]) {
        await SessionTraceStore.recordModelCall({
          id: receipt.id,
          sessionID: session.id,
          messageID: `msg_${receipt.id}`,
          route: "byok",
          provider: "openrouter",
          model: "fixture-model",
          occurredAt: 1_750_000_000_000,
          reportedCostUSD: receipt.cost,
        })
      }
      await step(session.id, "msg_paid", { route: "byok", call: "paid" })
      const report = await CallAudit.report(session.id)
      expect(report.calls.find((call) => call.httpCall === "zero")?.cost).toEqual({
        source: "provider_response",
        amountUSD: 0,
      })
      expect(report.calls.find((call) => call.httpCall === "paid")).toMatchObject({
        recordedCostUSD: 0,
        reportedCostUSD: 0.0123,
        cost: { source: "provider_response", amountUSD: 0.0123 },
      })
      for (const id of ["unknown", "legacy"]) {
        expect(report.calls.find((call) => call.httpCall === id)?.cost).toEqual({
          source: "unknown",
          amountUSD: null,
        })
      }
    },
  })
})

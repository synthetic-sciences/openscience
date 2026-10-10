import { expect, test } from "bun:test"
import { CallAudit } from "../../src/session/call-audit"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { UsageLogging } from "../../src/session/usage-logging"
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
      await step(lead.id, "msg_byok", { route: "byok", call: "call-byok" })
      await step(worker.id, "msg_chatgpt", { route: "chatgpt", call: "call-chatgpt" })

      const report = await CallAudit.report(lead.id)

      expect(report.sessions).toHaveLength(2)
      expect(report.sessions.every((session) => /^[0-9a-f]{64}$/.test(session.telemetrySessionID))).toBe(true)
      expect(report.sessions[0].telemetrySessionID).toBe(await UsageLogging.telemetrySessionID(lead.id))
      expect(report.sessions[1].telemetrySessionID).toBe(await UsageLogging.telemetrySessionID(worker.id))
      expect(report.calls.map((call) => call.route)).toEqual(["byok", "chatgpt"])
      expect(report.calls.map((call) => call.providerRequest)).toEqual(["resp_call-byok", "resp_call-chatgpt"])
      expect(JSON.stringify(report)).not.toContain("Private research title")
      expect(JSON.stringify(report)).not.toContain("Private worker title")
    },
  })
})

import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { Session } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { Identifier } from "../../src/id/id"
import { tmpdir } from "../fixture/fixture"

describe("Research effort", () => {
  test("resolves legacy and invalid values to Normal with bounded limits", () => {
    expect(MessageV2.resolveResearchEffort(undefined)).toBe("normal")
    expect(MessageV2.resolveResearchEffort("unexpected")).toBe("normal")
    expect(MessageV2.resolveResearchEffort("ultra")).toBe("ultra")
    expect(MessageV2.childAgentLimit("normal")).toBe(2)
    expect(MessageV2.childAgentLimit("ultra")).toBe(4)
  })

  test("persists Normal for a legacy user message that omitted effort", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const messageID = Identifier.ascending("message")
        await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "research",
          model: { providerID: "test", modelID: "test" },
        } as unknown as MessageV2.User)

        const stored = await MessageV2.get({ sessionID: session.id, messageID })
        expect(stored.info.role).toBe("user")
        if (stored.info.role !== "user") throw new Error("expected user message")
        expect(stored.info.effort).toBe("normal")
      },
    })
  })

  test("preserves explicit Ultra effort", () => {
    const parsed = MessageV2.User.parse({
      id: "message",
      sessionID: "session",
      role: "user",
      time: { created: 0 },
      agent: "research",
      model: { providerID: "test", modelID: "test" },
      effort: "ultra",
    })
    expect(parsed.effort).toBe("ultra")
  })
})

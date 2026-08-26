import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir } from "../fixture/fixture"

async function text(sessionID: string, value: string) {
  const messageID = Identifier.ascending("message")
  await Session.updateMessage({
    id: messageID,
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "research",
    model: { providerID: "openrouter", modelID: "test" },
    effort: "normal",
  } satisfies MessageV2.User)
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID,
    sessionID,
    type: "text",
    text: value,
  } satisfies MessageV2.TextPart)
  return messageID
}

describe("conversation references", () => {
  test("materializes a stable, quoted snapshot without hidden reasoning", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const source = await Session.create({ title: "Protein design" })
        const target = await Session.create({ title: "Paper draft" })
        const through = await text(source.id, "Compare the candidate interfaces.")
        await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: through,
          sessionID: source.id,
          type: "reasoning",
          text: "private chain of thought",
          time: { start: Date.now(), end: Date.now() },
        } satisfies MessageV2.ReasoningPart)

        const first = await SessionPrompt.conversationSnapshot({
          sessionID: target.id,
          sourceSessionID: source.id,
          throughMessageID: through,
        })
        await text(source.id, "This later message is outside the snapshot.")
        const replay = await SessionPrompt.conversationSnapshot({
          sessionID: target.id,
          sourceSessionID: source.id,
          throughMessageID: through,
        })

        expect(replay).toEqual(first)
        expect(first.label).toBe("Protein design")
        expect(first.text).toContain("quoted context")
        expect(first.text).toContain("Compare the candidate interfaces.")
        expect(first.text).not.toContain("private chain of thought")
        expect(first.text).not.toContain("later message")
      },
    })
  })

  test("rejects self references and missing snapshot boundaries", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const source = await Session.create({ title: "Source" })
        const target = await Session.create({ title: "Target" })
        await text(source.id, "Source text")

        await expect(
          SessionPrompt.conversationSnapshot({ sessionID: source.id, sourceSessionID: source.id }),
        ).rejects.toThrow("cannot reference itself")
        await expect(
          SessionPrompt.conversationSnapshot({
            sessionID: target.id,
            sourceSessionID: source.id,
            throughMessageID: Identifier.ascending("message"),
          }),
        ).rejects.toThrow("no longer exists")
      },
    })
  })
})

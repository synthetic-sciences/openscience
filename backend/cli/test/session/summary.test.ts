import { expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionSummary } from "../../src/session/summary"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../fixture/fixture"

test("summary ignores messages removed with their session", async () => {
  await using tmp = await tmpdir()

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const messageID = Identifier.ascending("message")

      await expect(SessionSummary.summarize({ sessionID: session.id, messageID })).resolves.toBeUndefined()

      await Session.remove(session.id)
      await expect(SessionSummary.summarize({ sessionID: session.id, messageID })).resolves.toBeUndefined()
    },
  })
})

test("a stale summary update cannot recreate a removed user message", async () => {
  await using tmp = await tmpdir()

  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const messageID = Identifier.ascending("message")
      await Session.updateMessage({
        id: messageID,
        role: "user",
        sessionID: session.id,
        effort: "normal",
        agent: "default",
        model: { providerID: "openai", modelID: "gpt-4" },
        time: { created: Date.now() },
      })

      const key = ["message", session.id, messageID]
      try {
        await Storage.remove(key)
        const updating = Storage.update<MessageV2.User>(key, (draft) => {
          draft.summary = { diffs: [] }
        })

        await expect(updating).rejects.toBeInstanceOf(Storage.NotFoundError)
        await expect(Storage.read(key)).rejects.toBeInstanceOf(Storage.NotFoundError)
      } finally {
        await Session.remove(session.id)
      }
    },
  })
})

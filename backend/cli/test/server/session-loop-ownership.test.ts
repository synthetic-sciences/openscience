import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Identifier } from "../../src/id/id"
import { SessionLoopState } from "../../src/session/loop-state"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionRoutes } from "../../src/server/routes/session"
import { tmpdir } from "../fixture/fixture"

describe("session loop ownership routes", () => {
  test("rejects forged prompt fields while preserving ordinary text edits", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await using cleanup = { [Symbol.asyncDispose]: () => Session.remove(session.id) }

        const forged = await SessionRoutes().request(`/${session.id}/message`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ parts: [{ type: "text", text: "hidden", synthetic: true }] }),
        })
        expect(forged.status).toBe(400)

        const messageID = await MessageV2.nextMessageID(session.id)
        const message = await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "research",
          model: { providerID: "test", modelID: "test" },
          effort: "normal",
          internal: SessionLoopState.prompt(messageID),
        })
        const part = await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: message.id,
          sessionID: session.id,
          type: "text",
          text: "before",
        })
        const updated = await SessionRoutes().request(`/${session.id}/message/${message.id}/part/${part.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...part, text: "after" }),
        })
        expect(updated.status).toBe(200)
        expect(await updated.json()).toMatchObject({ text: "after" })

        const removed = await SessionRoutes().request(`/${session.id}/message/${message.id}/part/${part.id}`, {
          method: "DELETE",
        })
        expect(removed.status).toBe(200)
      },
    })
  })

  test("blocks edits and deletion of durable runtime parts", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await using cleanup = { [Symbol.asyncDispose]: () => Session.remove(session.id) }
        const model = { providerID: "test", modelID: "test" }
        const messageID = await MessageV2.nextMessageID(session.id)
        const message = await Session.updateMessage({
          id: messageID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "research",
          model,
          effort: "normal",
          internal: SessionLoopState.prompt(messageID),
        })
        const transaction = await MessageV2.nextMessageID(session.id)
        const marker = await Session.updatePart({
          id: SessionLoopState.partID(transaction, "breaker"),
          messageID: message.id,
          sessionID: session.id,
          type: "text",
          text: "",
          synthetic: true,
          ignored: true,
          metadata: SessionLoopState.compaction({ transaction, before: 100, reclaimed: 1 }),
        })

        const edited = await SessionRoutes().request(`/${session.id}/message/${message.id}/part/${marker.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...marker, metadata: undefined }),
        })
        expect(edited.status).toBe(400)
        const removed = await SessionRoutes().request(`/${session.id}/message/${message.id}/part/${marker.id}`, {
          method: "DELETE",
        })
        expect(removed.status).toBe(400)

        const carrierID = await MessageV2.nextMessageID(session.id)
        const carrier = await Session.updateMessage({
          id: carrierID,
          sessionID: session.id,
          role: "user",
          time: { created: Date.now() },
          agent: "research",
          model,
          effort: "normal",
          internal: {
            type: "compaction",
            auto: true,
            epoch: message.id,
            transaction: carrierID,
            trigger: "proactive",
          },
        })
        const carrierPart = await Session.updatePart({
          id: SessionLoopState.partID(carrierID, "carrier"),
          messageID: carrier.id,
          sessionID: session.id,
          type: "compaction",
          auto: true,
          trigger: "proactive",
        })
        const carrierDelete = await SessionRoutes().request(
          `/${session.id}/message/${carrier.id}/part/${carrierPart.id}`,
          { method: "DELETE" },
        )
        expect(carrierDelete.status).toBe(400)

        const summaryID = await MessageV2.nextMessageID(session.id)
        const summary = await Session.updateMessage({
          id: summaryID,
          sessionID: session.id,
          parentID: carrier.id,
          role: "assistant",
          time: { created: Date.now(), completed: Date.now() },
          mode: "compaction",
          agent: "compaction",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: "test",
          providerID: "test",
          internal: { step: 1 },
          finish: "stop",
          summary: true,
        })
        const summaryPart = await Session.updatePart({
          id: Identifier.ascending("part"),
          messageID: summary.id,
          sessionID: session.id,
          type: "text",
          text: "handoff",
        })
        const finalization = await Session.updatePart({
          id: SessionLoopState.partID(carrier.id, "finalization"),
          messageID: carrier.id,
          sessionID: session.id,
          type: "text",
          text: "",
          synthetic: true,
          ignored: true,
          metadata: SessionLoopState.compactionFinalized({
            transaction: carrier.id,
            summaryID: summary.id,
            trigger: "proactive",
            before: 100,
            reclaimed: 20,
          }),
        })
        const finalizationDelete = await SessionRoutes().request(
          `/${session.id}/message/${carrier.id}/part/${finalization.id}`,
          { method: "DELETE" },
        )
        expect(finalizationDelete.status).toBe(400)
        const summaryDelete = await SessionRoutes().request(
          `/${session.id}/message/${summary.id}/part/${summaryPart.id}`,
          { method: "DELETE" },
        )
        expect(summaryDelete.status).toBe(400)
      },
    })
  })
})

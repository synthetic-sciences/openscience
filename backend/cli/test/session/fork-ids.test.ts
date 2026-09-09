import { expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionLoopState } from "../../src/session/loop-state"
import { MessageV2 } from "../../src/session/message-v2"
import { tmpdir } from "../fixture/fixture"

const model = { providerID: "test", modelID: "test-model" }

test("fork remaps every message id the transcript refers to, and the parts derived from them", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({ title: "source" })
      const promptID = await MessageV2.nextMessageID(session.id)
      await Session.updateMessage({
        id: promptID,
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "research",
        model,
        effort: "normal",
        context: 128_000,
        internal: SessionLoopState.prompt(promptID),
      })
      await Session.updatePart({
        id: Identifier.ascending("part"),
        messageID: promptID,
        sessionID: session.id,
        type: "text",
        text: "first question",
      })

      // A compaction carrier: its transaction is its own id, and its carrier
      // and finalization parts derive their ids from that transaction.
      const carrierID = await MessageV2.nextMessageID(session.id)
      await Session.updateMessage({
        id: carrierID,
        sessionID: session.id,
        role: "user",
        time: { created: Date.now() },
        agent: "research",
        model,
        effort: "normal",
        context: 128_000,
        internal: { type: "compaction", auto: true, epoch: promptID, transaction: carrierID, trigger: "proactive" },
      })
      await Session.updatePart({
        id: SessionLoopState.partID(carrierID, "carrier"),
        messageID: carrierID,
        sessionID: session.id,
        type: "compaction",
        auto: true,
        trigger: "proactive",
      })
      await Session.updatePart({
        id: SessionLoopState.partID(carrierID, "finalization"),
        messageID: carrierID,
        sessionID: session.id,
        type: "text",
        text: "",
      })

      // The summary keeps the tail from the first prompt onwards verbatim.
      const summaryID = await MessageV2.nextMessageID(session.id)
      await Session.updateMessage({
        id: summaryID,
        sessionID: session.id,
        parentID: carrierID,
        role: "assistant",
        time: { created: Date.now(), completed: Date.now() },
        mode: "compaction",
        agent: "compaction",
        path: { cwd: Instance.worktree, root: Instance.worktree },
        cost: 0,
        tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
        modelID: model.modelID,
        providerID: model.providerID,
        finish: "stop",
        summary: true,
        tailStartId: promptID,
      })

      const fork = await Session.fork({ sessionID: session.id })
      const copied = await Session.messages({ sessionID: fork.id })
      expect(copied).toHaveLength(3)
      const [prompt, carrier, summary] = copied
      const ids = new Set(copied.map((message) => message.info.id))
      expect(ids.has(promptID) || ids.has(carrierID) || ids.has(summaryID)).toBe(false)

      expect(prompt.info.role === "user" ? prompt.info.internal : undefined).toEqual({
        type: "prompt",
        epoch: prompt.info.id,
      })
      expect(carrier.info.role === "user" ? carrier.info.internal : undefined).toMatchObject({
        type: "compaction",
        epoch: prompt.info.id,
        transaction: carrier.info.id,
      })
      expect(carrier.parts.map((part) => part.id).sort()).toEqual(
        [
          SessionLoopState.partID(carrier.info.id, "carrier"),
          SessionLoopState.partID(carrier.info.id, "finalization"),
        ].sort(),
      )
      expect(summary.info.role === "assistant" ? summary.info.parentID : undefined).toBe(carrier.info.id)
      expect(summary.info.role === "assistant" ? summary.info.tailStartId : undefined).toBe(prompt.info.id)

      // The fork sends the same verbatim tail the source does.
      const newestFirst = async function* (messages: MessageV2.WithParts[]) {
        for (const message of [...messages].reverse()) yield message
      }
      const sourceTail = await MessageV2.filterCompacted(newestFirst(await Session.messages({ sessionID: session.id })))
      const forkTail = await MessageV2.filterCompacted(newestFirst(copied))
      const hasQuestion = (tail: MessageV2.WithParts[]) =>
        tail.some((message) => message.parts.some((part) => part.type === "text" && part.text === "first question"))
      expect(forkTail.map((message) => message.info.role)).toEqual(sourceTail.map((message) => message.info.role))
      expect(hasQuestion(sourceTail)).toBe(true)
      expect(hasQuestion(forkTail)).toBe(true)
    },
  })
})

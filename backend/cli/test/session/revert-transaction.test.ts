import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionRevert } from "../../src/session/revert"
import { Snapshot } from "../../src/snapshot"
import { tmpdir } from "../fixture/fixture"

async function turn(input: { sessionID: string; root: string; hash: string; files: string[] }) {
  const user = await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID: input.sessionID,
    effort: "normal",
    agent: "default",
    model: { providerID: "openai", modelID: "gpt-4" },
    time: { created: Date.now() },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: user.id,
    sessionID: input.sessionID,
    type: "text",
    text: "Change the project",
  })

  const assistant: MessageV2.Assistant = {
    id: Identifier.ascending("message"),
    role: "assistant",
    sessionID: input.sessionID,
    mode: "default",
    agent: "default",
    path: { cwd: input.root, root: input.root },
    cost: 0,
    tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "gpt-4",
    providerID: "openai",
    parentID: user.id,
    time: { created: Date.now(), completed: Date.now() },
    finish: "end_turn",
  }
  await Session.updateMessage(assistant)
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: assistant.id,
    sessionID: input.sessionID,
    type: "patch",
    hash: input.hash,
    files: input.files,
  })
  return user
}

async function conversationTurn(input: { sessionID: string; root: string }) {
  const user = await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "user",
    sessionID: input.sessionID,
    effort: "normal",
    agent: "default",
    model: { providerID: "openai", modelID: "gpt-4" },
    time: { created: Date.now() },
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: user.id,
    sessionID: input.sessionID,
    type: "text",
    text: "Explain this result",
  })

  const assistant = await Session.updateMessage({
    id: Identifier.ascending("message"),
    role: "assistant",
    sessionID: input.sessionID,
    mode: "default",
    agent: "default",
    path: { cwd: input.root, root: input.root },
    cost: 0,
    tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "gpt-4",
    providerID: "openai",
    parentID: user.id,
    time: { created: Date.now(), completed: Date.now() },
    finish: "end_turn",
  } satisfies MessageV2.Assistant)
  await Session.updatePart({
    id: Identifier.ascending("part"),
    messageID: assistant.id,
    sessionID: input.sessionID,
    type: "text",
    text: "The result is sound.",
  })
  return user
}

describe("transactional session undo", () => {
  afterAll(() => Instance.disposeAll())

  test("undoes and restores a conversation-only turn without requiring Git", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const user = await conversationTurn({ sessionID: session.id, root: tmp.path })

        const undone = await SessionRevert.revert({ sessionID: session.id, messageID: user.id })
        expect(SessionRevert.RevertResult.parse(undone)).toEqual(undone)
        expect(undone).toMatchObject({
          status: "reverted",
          turns: 1,
          files: [],
          filesystem: { status: "noop", restored: [], removed: [], skipped: [], errors: [] },
        })
        expect(undone.session.revert).toMatchObject({ messageID: user.id, turns: 1, files: [] })
        expect(undone.session.revert?.snapshot).toBeUndefined()

        const restored = await SessionRevert.unrevert({ sessionID: session.id })
        expect(restored.revert).toBeUndefined()
      },
    })
  })

  test("returns a structured result, is idempotent, and restores the exact redo snapshot", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const file = path.join(tmp.path, "result.txt")
        await Bun.write(file, "before")
        const before = await Snapshot.track()
        expect(before).toBeTruthy()
        await Bun.write(file, "after")
        const patch = await Snapshot.patch(before!)
        const session = await Session.create({})
        const user = await turn({ sessionID: session.id, root: tmp.path, hash: before!, files: patch.files })

        const [result, parallel] = await Promise.all([
          SessionRevert.revert({ sessionID: session.id, messageID: user.id }),
          SessionRevert.revert({ sessionID: session.id, messageID: user.id }),
        ])
        expect(parallel).toEqual(result)
        expect(SessionRevert.RevertResult.parse(result)).toEqual(result)
        expect(result).toMatchObject({
          status: "reverted",
          turns: 1,
          files: ["result.txt"],
          filesystem: { status: "applied", restored: ["result.txt"], removed: [], skipped: [], errors: [] },
        })
        expect(result.session.revert).toMatchObject({ messageID: user.id, turns: 1, files: ["result.txt"] })
        expect(await Bun.file(file).text()).toBe("before")

        const duplicate = await SessionRevert.revert({ sessionID: session.id, messageID: user.id })
        expect(duplicate).toMatchObject({ status: "unchanged", turns: 1, files: ["result.txt"] })

        const restored = await SessionRevert.unrevert({ sessionID: session.id })
        expect(restored.revert).toBeUndefined()
        expect(await Bun.file(file).text()).toBe("after")
      },
    })
  })

  test("restores only files recorded by Undo and preserves unrelated edits made afterward", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const result = path.join(tmp.path, "result.txt")
        const unrelated = path.join(tmp.path, "notes.txt")
        const newUnrelated = path.join(tmp.path, "new-notes.txt")
        await Promise.all([Bun.write(result, "before"), Bun.write(unrelated, "initial notes")])
        const before = await Snapshot.track()
        expect(before).toBeTruthy()
        await Bun.write(result, "after")
        const patch = await Snapshot.patch(before!)
        const session = await Session.create({})
        const user = await turn({ sessionID: session.id, root: tmp.path, hash: before!, files: patch.files })

        const undone = await SessionRevert.revert({ sessionID: session.id, messageID: user.id })
        expect(undone.files).toEqual(["result.txt"])
        expect(await Bun.file(result).text()).toBe("before")

        await Bun.write(unrelated, "edited outside OpenScience after Undo")
        await Bun.write(newUnrelated, "created outside OpenScience after Undo")
        await SessionRevert.unrevert({ sessionID: session.id })

        expect(await Bun.file(result).text()).toBe("after")
        expect(await Bun.file(unrelated).text()).toBe("edited outside OpenScience after Undo")
        expect(await Bun.file(newUnrelated).text()).toBe("created outside OpenScience after Undo")
      },
    })
  })

  test("rolls back partial filesystem work and retains the original session state on failure", async () => {
    await using tmp = await tmpdir({ git: true })
    const outside = `${tmp.path}-outside.txt`
    await Bun.write(outside, "outside")
    try {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const file = path.join(tmp.path, "result.txt")
          await Bun.write(file, "before")
          const before = await Snapshot.track()
          expect(before).toBeTruthy()
          await Bun.write(file, "after")
          const session = await Session.create({})
          const user = await turn({ sessionID: session.id, root: tmp.path, hash: before!, files: [file, outside] })

          await expect(SessionRevert.revert({ sessionID: session.id, messageID: user.id })).rejects.toBeInstanceOf(
            SessionRevert.TransactionError,
          )
          expect((await Session.get(session.id)).revert).toBeUndefined()
          expect(await Bun.file(file).text()).toBe("after")
          expect(await Bun.file(outside).text()).toBe("outside")
          expect((await Session.messages({ sessionID: session.id })).map((message) => message.info.id)).toContain(
            user.id,
          )
        },
      })
    } finally {
      await fs.rm(outside, { force: true })
    }
  })
})

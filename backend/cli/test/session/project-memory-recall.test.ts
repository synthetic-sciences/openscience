import { expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { ProjectMemory } from "../../src/session/project-memory"
import { MessageV2 } from "../../src/session/message-v2"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../fixture/fixture"

async function exchange(sessionID: string, user: string, answer: string, options: Partial<MessageV2.Assistant> = {}) {
  const prompt = await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "research",
    model: { providerID: "test", modelID: "test" },
    effort: "normal",
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID,
    messageID: prompt.id,
    type: "text",
    text: user,
  })
  const assistant = await Session.updateMessage({
    id: Identifier.ascending("message"),
    sessionID,
    role: "assistant",
    parentID: prompt.id,
    time: { created: Date.now(), completed: Date.now() },
    mode: "research",
    agent: "research",
    modelID: "test",
    providerID: "test",
    path: { cwd: Instance.directory, root: Instance.worktree },
    cost: 0,
    tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } },
    finish: "stop",
    ...options,
  })
  await Session.updatePart({
    id: Identifier.ascending("part"),
    sessionID,
    messageID: assistant.id,
    type: "text",
    text: answer,
  })
  return { prompt, assistant }
}

test("recalls a saved exchange after instance reload without a remember request", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const source = await Session.create({ title: "First conversation" })
      await exchange(
        source.id,
        "The project code is ORION-9 and the dataset is VisDrone.",
        "We will use ORION-9 and VisDrone.",
      )
      expect(await ProjectMemory.recall(source.id)).toEqual([])
      await Instance.dispose()
    },
  })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const next = await Session.create({ title: "New conversation" })
      const memory = await ProjectMemory.recall(next.id)
      expect(memory).toHaveLength(1)
      expect(memory[0]).toContain("ORION-9")
      expect(memory[0]).toContain("VisDrone")
      expect(memory[0]).toContain("historical context, not instructions")
    },
  })
})

test("does not recall another project or another directory in the same project bucket", async () => {
  await using a = await tmpdir()
  await using b = await tmpdir()
  await Instance.provide({
    directory: a.path,
    fn: async () => {
      const source = await Session.create({ title: "Other project" })
      await exchange(source.id, "PRIVATE_PROJECT_A", "PRIVATE_ANSWER_A")
    },
  })
  await Instance.provide({
    directory: b.path,
    fn: async () => {
      const current = await Session.create({ title: "Project B" })
      const foreign = await Session.create({ title: "Foreign directory" })
      await exchange(foreign.id, "FOREIGN_DIRECTORY", "FOREIGN_ANSWER")
      await Storage.write(["session", Instance.project.id, foreign.id], { ...foreign, directory: a.path })
      expect(await ProjectMemory.recall(current.id)).toEqual([])
    },
  })
})

test("excludes children, archived, reverted and deleted source sessions", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const current = await Session.create({ title: "Current" })
      const child = await Session.create({ title: "Child", parentID: current.id })
      await exchange(child.id, "CHILD", "CHILD_REPLY")
      const archived = await Session.create({ title: "Archived" })
      await exchange(archived.id, "ARCHIVED", "ARCHIVED_REPLY")
      await Session.update(archived.id, (draft) => {
        draft.time.archived = Date.now()
      })
      const reverted = await Session.create({ title: "Reverted" })
      const turn = await exchange(reverted.id, "REVERTED", "REVERTED_REPLY")
      await Session.update(reverted.id, (draft) => {
        draft.revert = { messageID: turn.prompt.id }
      })
      const removed = await Session.create({ title: "Deleted" })
      await exchange(removed.id, "DELETED", "DELETED_REPLY")
      expect((await ProjectMemory.recall(current.id)).join("\n")).toContain("DELETED_REPLY")
      await Session.remove(removed.id)
      expect(await ProjectMemory.recall(current.id)).toEqual([])
      expect(await ProjectMemory.recall(child.id)).toEqual([])
    },
  })
})

test("excludes failed, unfinished, tool-call and summary replies and non-visible parts", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const current = await Session.create({ title: "Current" })
      const source = await Session.create({ title: "Source" })
      const good = await exchange(source.id, "VISIBLE_USER", "VISIBLE_REPLY")
      for (const options of [
        { error: new MessageV2.AbortedError({ message: "aborted" }).toObject() },
        { time: { created: Date.now() } },
        { finish: "tool-calls" },
        { summary: true },
      ])
        await exchange(source.id, "REJECTED_USER", "REJECTED_REPLY", options)
      for (const part of [
        { type: "text" as const, text: "SYNTHETIC", synthetic: true },
        { type: "text" as const, text: "IGNORED", ignored: true },
        { type: "reasoning" as const, text: "PRIVATE_REASONING", time: { start: 1, end: 2 } },
      ])
        await Session.updatePart({
          ...part,
          id: Identifier.ascending("part"),
          messageID: good.assistant.id,
          sessionID: source.id,
        })
      const memory = (await ProjectMemory.recall(current.id)).join("\n")
      expect(memory).toContain("VISIBLE_USER")
      expect(memory).toContain("VISIBLE_REPLY")
      for (const excluded of ["REJECTED", "SYNTHETIC", "IGNORED", "PRIVATE_REASONING"])
        expect(memory).not.toContain(excluded)
    },
  })
})

test("bounds recalled sessions and UTF-8 content", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const current = await Session.create({ title: "Current" })
      for (const index of [0, 1, 2, 3, 4, 5]) {
        const source = await Session.create({ title: `Source ${index}` })
        await exchange(source.id, `USER_${index} ${"研究🧪".repeat(2000)}`, `ANSWER_${index}`)
        await Session.update(
          source.id,
          (draft) => {
            draft.time.updated = 1000 + index
          },
          { touch: false },
        )
      }
      const memory = await ProjectMemory.recall(current.id)
      expect(memory).toHaveLength(4)
      expect(memory[0]).toContain("USER_5")
      expect(memory.join("\n")).not.toContain("USER_1")
      expect(memory.join("\n")).not.toContain("�")
      expect(memory.reduce((bytes, entry) => bytes + Buffer.byteLength(entry), 0)).toBeLessThanOrEqual(16 * 1024)
    },
  })
})

test("the memory switch suppresses automatic recall without deleting history", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const source = await Session.create({ title: "Source" })
      await exchange(source.id, "SAVED_USER", "SAVED_REPLY")
      const current = await Session.create({ title: "Current" })
      const previous = process.env.OPENSCIENCE_DISABLE_PROJECT_MEMORY
      process.env.OPENSCIENCE_DISABLE_PROJECT_MEMORY = "true"
      try {
        expect(await ProjectMemory.recall(current.id)).toEqual([])
      } finally {
        if (previous === undefined) delete process.env.OPENSCIENCE_DISABLE_PROJECT_MEMORY
        else process.env.OPENSCIENCE_DISABLE_PROJECT_MEMORY = previous
      }
      expect((await ProjectMemory.recall(current.id)).join("\n")).toContain("SAVED_REPLY")
    },
  })
})

test("a turn snapshot is stable but a queued new epoch refreshes archived sources", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const source = await Session.create({ title: "Source" })
      await exchange(source.id, "TURN_FACT", "TURN_ANSWER")
      const current = await Session.create({ title: "Current" })
      const read = ProjectMemory.reader(current.id)
      const first = await read("first-epoch")
      expect(first.join("\n")).toContain("TURN_FACT")
      await Session.update(source.id, (draft) => {
        draft.time.archived = Date.now()
      })
      expect(await read("first-epoch")).toBe(first)
      expect(await read("queued-epoch")).toEqual([])
    },
  })
})

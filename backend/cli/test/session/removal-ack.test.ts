import { expect, test } from "bun:test"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { Storage } from "../../src/storage/storage"
import { tmpdir } from "../fixture/fixture"

test("session deletion tombstones rejected cleanup and succeeds on retry before erasing data", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const messageKey = ["message", session.id, "msg_deletion_tombstone"]
      await Storage.write(messageKey, { id: "msg_deletion_tombstone", retained: true })
      let attempts = 0
      let resourceAlive = true
      const unsubscribe = Bus.subscribe(Session.Event.Deleted, async () => {
        attempts++
        if (attempts === 1) throw new Error("runtime reaper rejected")
        resourceAlive = false
      })
      try {
        await expect(Session.remove(session.id)).rejects.toThrow("runtime reaper rejected")
        expect(resourceAlive).toBe(true)
        expect(await Storage.read<{ id: string; retained: boolean }>(messageKey)).toEqual({
          id: "msg_deletion_tombstone",
          retained: true,
        })
        await expect(Session.get(session.id)).rejects.toBeInstanceOf(Storage.NotFoundError)
        await expect(Session.createNext({ id: session.id, directory: tmp.path })).rejects.toBeInstanceOf(
          Session.DeletingError,
        )

        await Session.remove(session.id)
        expect(attempts).toBe(2)
        expect(resourceAlive).toBe(false)
        await expect(Storage.read(messageKey)).rejects.toBeInstanceOf(Storage.NotFoundError)

        // Successful completion removes the tombstone, so an explicit import
        // may reuse the historical id only after cleanup has been acknowledged.
        const replacement = await Session.createNext({ id: session.id, directory: tmp.path })
        expect(replacement.id).toBe(session.id)
        await Session.remove(replacement.id)
      } finally {
        unsubscribe()
      }
    },
  })
})

import { expect, test } from "bun:test"
import { getEventListeners } from "node:events"
import { PermissionNext } from "../../src/permission/next"
import { Instance } from "../../src/project/instance"
import { Bus } from "../../src/bus"
import { tmpdir } from "../fixture/fixture"

const input = {
  sessionID: "ses_cancelled",
  permission: "bash",
  patterns: ["ls"],
  metadata: {},
  always: [],
  ruleset: [{ permission: "bash", pattern: "*", action: "ask" as const }],
}

test("cancelled permissions leave no live request or reusable approval", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const controller = new AbortController()
      const event = Promise.withResolvers<unknown>()
      const unsubscribe = Bus.subscribe(PermissionNext.Event.Cancelled, (value) => event.resolve(value.properties))
      const result = PermissionNext.ask(input, controller.signal).catch((error) => error)
      const [request] = await PermissionNext.list()
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(1)
      controller.abort()
      expect(await PermissionNext.list()).toEqual([])
      expect((await result).name).toBe("AbortError")
      expect(await event.promise).toEqual({ sessionID: request.sessionID, requestID: request.id })
      expect(await PermissionNext.reply({ requestID: request.id, reply: "always" })).toBe(false)
      expect(await PermissionNext.standing()).toEqual([])
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
      unsubscribe()
      await Instance.dispose()
    },
  })
})

test("already cancelled permissions never become pending, including configured allows", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const controller = new AbortController()
      controller.abort(new Error("Stopped by the caller"))
      await expect(PermissionNext.ask(input, controller.signal)).rejects.toThrow("Stopped by the caller")
      await expect(
        PermissionNext.ask(
          { ...input, ruleset: [{ permission: "*", pattern: "*", action: "allow" }] },
          controller.signal,
        ),
      ).rejects.toThrow("Stopped by the caller")
      expect(await PermissionNext.list()).toEqual([])
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
      await Instance.dispose()
    },
  })
})

test("permission replies enforce expected session and only one caller claims a pending approval", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const controller = new AbortController()
      const result = PermissionNext.ask(input, controller.signal)
      const [request] = await PermissionNext.list()
      expect(await PermissionNext.reply({ requestID: request.id, sessionID: "ses_other", reply: "always" })).toBe(false)
      expect(await PermissionNext.list()).toHaveLength(1)
      expect(await PermissionNext.standing()).toEqual([])
      const replies = await Promise.all([
        PermissionNext.reply({ requestID: request.id, sessionID: input.sessionID, reply: "once" }),
        PermissionNext.reply({ requestID: request.id, reply: "always" }),
      ])
      expect(replies).toEqual([true, false])
      await result
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
      expect(await PermissionNext.standing()).toEqual([])
      await Instance.dispose()
    },
  })
})

test("permission rejection and disposal remove cancellation listeners", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const first = new AbortController()
      const second = new AbortController()
      const a = PermissionNext.ask(input, first.signal).catch((error) => error)
      const b = PermissionNext.ask(input, second.signal).catch((error) => error)
      const pending = await PermissionNext.list()
      expect(pending).toHaveLength(2)
      expect(await PermissionNext.reply({ requestID: pending[0].id, reply: "reject" })).toBe(true)
      expect(await a).toBeInstanceOf(PermissionNext.RejectedError)
      expect(await b).toBeInstanceOf(PermissionNext.RejectedError)
      expect(getEventListeners(first.signal, "abort")).toHaveLength(0)
      expect(getEventListeners(second.signal, "abort")).toHaveLength(0)
      const c = PermissionNext.ask(input, first.signal).catch((error) => error)
      expect(await PermissionNext.list()).toHaveLength(1)
      await Instance.dispose()
      expect(await c).toBeInstanceOf(PermissionNext.InstanceDisposedError)
      expect(getEventListeners(first.signal, "abort")).toHaveLength(0)
    },
  })
})

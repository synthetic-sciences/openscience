import { expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { CommandRuntime } from "../../src/science/command/registry"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { tmpdir, trustProject } from "../fixture/fixture"

async function waitUntil(check: () => boolean, timeout = 5_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (check()) return
    await Bun.sleep(5)
  }
  throw new Error("Session controller did not become active")
}

test("a stale loop disposer cannot cancel the current controller, while explicit cancel can", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await trustProject()
      const session = await Session.create({
        permission: [{ permission: "bash", pattern: "*", action: "allow" }],
      })
      const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`
      const running = SessionPrompt.shell({
        sessionID: session.id,
        agent: "research",
        model: { providerID: "test", modelID: "test" },
        command,
      })

      await waitUntil(() => {
        try {
          SessionPrompt.assertNotBusy(session.id)
          return false
        } catch (error) {
          expect(error).toBeInstanceOf(Session.BusyError)
          return true
        }
      })
      await waitUntil(() => CommandRuntime.list(Instance.project.id, session.id).length === 1)

      // A loop disposer passes the signal it owns. This stale signal models an
      // older loop finishing after a newer controller has claimed the session.
      const stale = new AbortController()
      stale.abort()
      SessionPrompt.cancel(session.id, stale.signal)
      expect(() => SessionPrompt.assertNotBusy(session.id)).toThrow(Session.BusyError)

      // The public stop action intentionally has no owner and must still stop
      // whichever controller currently owns the session.
      SessionPrompt.cancel(session.id)
      expect(() => SessionPrompt.assertNotBusy(session.id)).not.toThrow()

      await running
      await Session.remove(session.id)
    },
  })
}, 15_000)

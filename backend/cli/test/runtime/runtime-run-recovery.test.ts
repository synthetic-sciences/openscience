import { expect, test } from "bun:test"
import path from "node:path"
import fs from "node:fs/promises"
import { Global } from "../../src/global"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import { RuntimeEvents } from "../../src/runtime/events"
import { RuntimeRuns } from "../../src/runtime/runs"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Storage } from "../../src/storage/storage"
import { tmpdir, trustProject } from "../fixture/fixture"
import { STRESS_PROVIDER_ID, STRESS_PROVIDER_MODEL, stressProviderConfig } from "../fixture/stress-provider"

async function within<T>(promise: Promise<T>) {
  const expired = Promise.withResolvers<never>()
  const timer = setTimeout(() => expired.reject(new Error("Runtime did not reach the test barrier")), 5_000)
  return Promise.race([promise, expired.promise]).finally(() => clearTimeout(timer))
}

test("a cancelled admission retains its message ID even when no message was written", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const input = {
        sessionID: session.id,
        requestID: "first",
        messageID: Identifier.ascending("message"),
        message: "Original request",
        effort: "normal" as const,
      }
      const accepted = await RuntimeRuns.admit(input)
      await RuntimeRuns.cancel(session.id, accepted.run.runID)
      expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
      await expect(
        RuntimeRuns.admit({ ...input, requestID: "second", message: "Different work" }),
      ).rejects.toBeInstanceOf(RuntimeRuns.ConflictError)
      expect((await RuntimeRuns.admit(input)).run).toMatchObject({ runID: accepted.run.runID, state: "cancelled" })
      expect(await RuntimeRuns.list(session.id)).toHaveLength(1)
    },
  })
})

test("a successor admitted before crash reconciliation still reports the old receipt as interrupted", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const child = Bun.spawn(
        [
          process.execPath,
          path.resolve(import.meta.dir, "../fixture/runtime-admission-process.ts"),
          tmp.path,
          session.id,
          "crashed",
        ],
        { env: process.env, stdout: "pipe", stderr: "pipe" },
      )
      try {
        const [code, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ])
        if (code !== 0) throw new Error(stderr)
        const prior = JSON.parse(stdout) as { run: RuntimeRuns.Run }
        const next = await RuntimeRuns.admit({
          sessionID: session.id,
          requestID: "successor",
          message: "Explicit replacement",
          effort: "normal",
        })
        expect(
          (await RuntimeEvents.replay(session.id)).events.find(
            (event) => event.runID === prior.run.runID && event.type === "runtime.failed",
          )?.properties.recovered,
        ).toBe(true)
        expect(await RuntimeRuns.get(session.id, prior.run.runID)).toMatchObject({
          state: "interrupted",
          error: { code: "runtime_stopped" },
        })
        await RuntimeRuns.cancel(session.id, next.run.runID)
      } finally {
        if (child.exitCode === null) child.kill()
        await child.exited
      }
    },
  })
}, 15_000)

test("journal corruption cannot prevent cancellation of the exact locally owned run", async () => {
  await using tmp = await tmpdir({ git: true, config: stressProviderConfig("http://127.0.0.1:9/v1") })
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      await trustProject()
      await Provider.invalidate()
    },
    fn: async () => {
      const session = await Session.create({})
      const other = await Session.create({})
      const entered = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      using hooks = SessionPrompt.testing({
        beforeLoopAdmission: async () => {
          entered.resolve()
          await release.promise
        },
      })
      const accepted = await RuntimeRuns.prompt({
        sessionID: session.id,
        message: "Wait before model execution",
        effort: "normal",
        delegation: false,
        model: { providerID: STRESS_PROVIDER_ID, modelID: STRESS_PROVIDER_MODEL },
      })
      try {
        await within(entered.promise)
        const controller = SessionPrompt.activeController(session.id)
        expect(controller).toBeDefined()
        await expect(RuntimeRuns.cancel(other.id, accepted.runID)).rejects.toBeInstanceOf(Storage.NotFoundError)
        expect(controller?.aborted).toBe(false)
        await Storage.write(["runtime_event", Instance.project.id, session.id], { malformed: true })
        await expect(RuntimeRuns.cancel(session.id, accepted.runID)).rejects.toThrow()
        expect(controller?.aborted).toBe(true)
        expect(SessionPrompt.activeController(session.id)).toBeUndefined()
      } finally {
        release.resolve()
        SessionPrompt.cancel(session.id)
      }
    },
  })
})

test("an admission storage failure retains one failed receipt and an exact retry does not execute", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const session = await Session.create({})
      const journal = ["runtime_event", Instance.project.id, session.id]
      await Storage.write(journal, { nextSequence: 1, events: [] })
      // A real live writer keeps journal reads available while exhausting the
      // bounded mutation wait. The separate run receipt can still be persisted.
      const lock = path.join(Global.Path.data, "storage", ...journal) + ".json.lock"
      await Bun.write(
        lock,
        JSON.stringify({ pid: process.pid, token: "admission-failure-fixture", created: Date.now() }),
      )
      const input = {
        sessionID: session.id,
        requestID: "failed-admission",
        message: "Do not execute",
        effort: "normal" as const,
      }
      try {
        await expect(RuntimeRuns.prompt(input)).rejects.toThrow("Timed out waiting for storage mutation lock")
      } finally {
        await fs.rm(lock, { force: true })
      }
      const [failed] = await RuntimeRuns.list(session.id)
      expect(failed).toMatchObject({ state: "failed", error: { code: "admission_failed" } })
      const replay = await RuntimeRuns.admit(input)
      expect(replay).toEqual({ run: failed, replayed: true })
      expect(await RuntimeRuns.prompt(input)).toEqual({ runID: failed!.runID, acceptedAt: failed!.acceptedAt })
      expect(await RuntimeRuns.list(session.id)).toEqual([failed!])
      expect(await Session.messages({ sessionID: session.id })).toHaveLength(0)
      expect((await RuntimeEvents.replay(session.id)).events).toHaveLength(0)
      expect(SessionPrompt.activeController(session.id)).toBeUndefined()
    },
  })
}, 20_000)

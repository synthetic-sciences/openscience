import { describe, expect, spyOn, test } from "bun:test"
import z from "zod"
import { Bus } from "../../src/bus"
import { BusEvent } from "../../src/bus/bus-event"
import { Instance } from "../../src/project/instance"
import { RuntimeEvents } from "../../src/runtime/events"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { CommandRuntime } from "../../src/science/command/registry"
import { handoffRuntimeEvents, RuntimeRoutes } from "../../src/server/routes/runtime"
import { SessionRoutes } from "../../src/server/routes/session"
import { Server } from "../../src/server/server"
import { Storage } from "../../src/storage/storage"
import { tmpdir, trustProject } from "../fixture/fixture"
import { applyRuntimeCancellationRequest } from "../../src/project/bootstrap"

const Tick = BusEvent.define(
  "test.runtime.tick",
  z.object({
    sessionID: z.string(),
    value: z.number(),
  }),
)

async function waitUntil(check: () => boolean | Promise<boolean>, timeout = 5_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await Bun.sleep(5)
  }
  throw new Error("Condition did not become true")
}

describe("public runtime event journal", () => {
  test("durably sequences a run, associates bus events, and replays after a cursor", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const seen: number[] = []
        const unsubscribe = RuntimeEvents.subscribe(session.id, (event) => {
          seen.push(event.sequence)
        })

        await RuntimeEvents.begin({
          sessionID: session.id,
          runID: "run_stable",
          acceptedAt: 100,
          effort: "ultra",
        })
        await Bus.publish(Tick, { sessionID: session.id, value: 7 })
        await RuntimeEvents.finish({ sessionID: session.id, runID: "run_stable", messageID: "msg_result" })
        await Bus.publish(Tick, { sessionID: session.id, value: 8 })
        unsubscribe()

        expect(seen).toEqual([1, 2, 3])
        expect(await RuntimeEvents.replay(session.id, 1)).toMatchObject({
          oldestSequence: 1,
          latestSequence: 3,
          events: [
            { sequence: 2, runID: "run_stable", type: "test.runtime.tick", properties: { value: 7 } },
            { sequence: 3, runID: "run_stable", type: "runtime.completed" },
          ],
        })
      },
    })
  })

  test("captures real message progress events with their explicit nested session owners", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const info: MessageV2.User = {
          id: "msg_runtime_progress",
          sessionID: session.id,
          role: "user",
          time: { created: 101 },
          agent: "research",
          model: { providerID: "test", modelID: "test" },
          effort: "normal",
        }
        const part: MessageV2.TextPart = {
          id: "prt_runtime_progress",
          sessionID: session.id,
          messageID: info.id,
          type: "text",
          text: "streamed",
        }

        await RuntimeEvents.begin({
          sessionID: session.id,
          runID: "run_progress",
          acceptedAt: 100,
          effort: "normal",
        })
        await Bus.publish(MessageV2.Event.Updated, { info })
        await Bus.publish(MessageV2.Event.PartUpdated, { part, delta: "streamed" })
        await RuntimeEvents.capture({
          type: "test.runtime.unknown-nested-owner",
          properties: { info: { sessionID: session.id } },
        })

        expect(await RuntimeEvents.replay(session.id)).toMatchObject({
          latestSequence: 3,
          events: [
            { sequence: 1, type: "runtime.accepted" },
            {
              sequence: 2,
              type: "message.updated",
              properties: { info: { id: info.id, sessionID: session.id } },
            },
            {
              sequence: 3,
              type: "message.part.updated",
              properties: { part: { id: part.id, sessionID: session.id }, delta: "streamed" },
            },
          ],
        })
      },
    })
  })

  test("batches durable streaming progress without dropping ordinary bus deltas", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const parts: string[] = []
        const unsubscribe = Bus.subscribe(MessageV2.Event.PartUpdated, (event) => {
          if (event.properties.delta) parts.push(event.properties.delta)
        })
        await RuntimeEvents.begin({
          sessionID: session.id,
          runID: "run_progress_batch",
          acceptedAt: 100,
          effort: "normal",
        })
        const publish = (text: string, delta: string) =>
          Bus.publish(MessageV2.Event.PartUpdated, {
            part: {
              id: "prt_progress_batch",
              sessionID: session.id,
              messageID: "msg_progress_batch",
              type: "text",
              text,
            },
            delta,
          })
        const writes = [publish("one", "one"), publish("onetwo", "two"), publish("onetwothree", "three")]

        await RuntimeEvents.finish({
          sessionID: session.id,
          runID: "run_progress_batch",
          messageID: "msg_progress_batch",
        })
        await Promise.all(writes)
        unsubscribe()

        expect(parts).toEqual(["one", "two", "three"])
        expect((await RuntimeEvents.replay(session.id)).events).toMatchObject([
          { sequence: 1, type: "runtime.accepted" },
          {
            sequence: 2,
            type: "message.part.updated",
            properties: { part: { text: "one" }, delta: "one" },
          },
          {
            sequence: 3,
            type: "message.part.updated",
            properties: { part: { text: "onetwothree" }, delta: "twothree" },
          },
          { sequence: 4, type: "runtime.completed" },
        ])
      },
    })
  })

  test("isolates cyclic subscriber rejections from durable capture and healthy subscribers", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await RuntimeEvents.begin({
          sessionID: session.id,
          runID: "run_subscriber_isolation",
          acceptedAt: 100,
          effort: "normal",
        })

        const rejection: Record<string, unknown> = {}
        rejection.self = rejection
        const received: RuntimeEvents.Event[] = []
        const unsubscribeFailing = RuntimeEvents.subscribe(session.id, () => {
          throw rejection
        })
        const unsubscribeHealthy = RuntimeEvents.subscribe(session.id, (event) => {
          received.push(event)
        })
        try {
          await expect(
            RuntimeEvents.capture({
              type: Tick.type,
              properties: { sessionID: session.id, value: 1 },
            }),
          ).resolves.toBeUndefined()
        } finally {
          unsubscribeFailing()
          unsubscribeHealthy()
        }

        expect(received).toMatchObject([{ runID: "run_subscriber_isolation", type: Tick.type }])
        expect((await RuntimeEvents.replay(session.id)).events.at(-1)).toMatchObject({
          runID: "run_subscriber_isolation",
          type: Tick.type,
          properties: { sessionID: session.id, value: 1 },
        })
        await RuntimeEvents.finish({
          sessionID: session.id,
          runID: "run_subscriber_isolation",
          messageID: "msg_subscriber_isolation",
        })
      },
    })
  })

  test("preserves the failed assistant message id and structured error text", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await RuntimeEvents.begin({
          sessionID: session.id,
          runID: "run_policy",
          acceptedAt: 100,
          effort: "normal",
        })
        await RuntimeEvents.fail({
          sessionID: session.id,
          runID: "run_policy",
          messageID: "msg_policy",
          error: { data: { message: "bio policy" } },
        })

        expect((await RuntimeEvents.replay(session.id)).events.at(-1)).toMatchObject({
          type: "runtime.failed",
          properties: { messageID: "msg_policy", message: "bio policy" },
        })
      },
    })
  })

  test("records an explicit user cancellation from the abort endpoint", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await RuntimeEvents.begin({
          sessionID: session.id,
          runID: "run_cancelled",
          acceptedAt: 100,
          effort: "normal",
        })

        const response = await SessionRoutes().request(`/${session.id}/abort`, { method: "POST" })

        expect(response.status).toBe(200)
        expect((await RuntimeEvents.replay(session.id)).events.at(-1)).toMatchObject({
          runID: "run_cancelled",
          type: "runtime.cancelled",
          properties: { source: "user" },
        })
      },
    })
  })

  test("stops the active controller even when cancellation event delivery fails", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const session = await Session.create({
          permission: [{ permission: "bash", pattern: "*", action: "allow" }],
        })
        await RuntimeEvents.begin({
          sessionID: session.id,
          runID: "run_cancel_delivery_failure",
          acceptedAt: 100,
          effort: "normal",
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
        const unsubscribe = RuntimeEvents.subscribe(session.id, () => {
          throw new Error("subscriber delivery failed")
        })

        const response = await SessionRoutes().request(`/${session.id}/abort`, { method: "POST" })
        unsubscribe()

        expect(response.status).toBe(200)
        expect(() => SessionPrompt.assertNotBusy(session.id)).not.toThrow()
        expect((await RuntimeEvents.replay(session.id)).events.at(-1)).toMatchObject({
          runID: "run_cancel_delivery_failure",
          type: "runtime.cancelled",
          properties: { source: "user" },
        })
        await running
        expect(CommandRuntime.list(Instance.project.id, session.id)).toEqual([])
        await Session.remove(session.id)
      },
    })
  }, 15_000)

  test("a stale run-specific cancellation request cannot cancel a newer prompt", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const cancel = spyOn(SessionPrompt, "cancel")
        try {
          await RuntimeEvents.begin({
            sessionID: session.id,
            runID: "run_stale_request",
            acceptedAt: 100,
            effort: "normal",
          })
          await RuntimeEvents.finish({
            sessionID: session.id,
            runID: "run_stale_request",
            messageID: "msg_old",
          })
          await RuntimeEvents.begin({
            sessionID: session.id,
            runID: "run_new_owner",
            acceptedAt: 200,
            effort: "normal",
          })

          await expect(
            applyRuntimeCancellationRequest({
              sessionID: session.id,
              runID: "run_stale_request",
              source: "user",
            }),
          ).resolves.toEqual({ status: "inactive" })
          expect(cancel).not.toHaveBeenCalled()
          expect((await RuntimeEvents.replay(session.id)).events.at(-1)).toMatchObject({
            runID: "run_new_owner",
            type: "runtime.accepted",
          })

          await RuntimeEvents.cancel({ sessionID: session.id, runID: "run_new_owner", source: "user" })
        } finally {
          cancel.mockRestore()
          await Session.remove(session.id)
        }
      },
    })
  })

  test("the HTTP abort endpoint cannot cancel a controller that replaced its original owner", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await trustProject()
        const session = await Session.create({
          permission: [{ permission: "bash", pattern: "*", action: "allow" }],
        })
        const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify("setInterval(() => {}, 1000)")}`
        const oldRun = SessionPrompt.shell({
          sessionID: session.id,
          agent: "research",
          model: { providerID: "test", modelID: "test" },
          command,
        })
        await waitUntil(() => {
          try {
            SessionPrompt.assertNotBusy(session.id)
            return false
          } catch {
            return true
          }
        })

        const pending = Promise.withResolvers<RuntimeEvents.CancelResult>()
        const requestCancel = spyOn(RuntimeEvents, "requestCancel").mockImplementation(() => pending.promise)
        let newRun: ReturnType<typeof SessionPrompt.shell> | undefined
        try {
          const response = SessionRoutes().request(`/${session.id}/abort`, { method: "POST" })
          await waitUntil(() => requestCancel.mock.calls.length === 1)

          // Replace the controller while the route awaits durable cancellation.
          // Its eventual finally block must stay bound to the old signal.
          SessionPrompt.cancel(session.id)
          newRun = SessionPrompt.shell({
            sessionID: session.id,
            agent: "research",
            model: { providerID: "test", modelID: "test" },
            command,
          })
          await waitUntil(() => {
            try {
              SessionPrompt.assertNotBusy(session.id)
              return false
            } catch {
              return true
            }
          })

          pending.resolve({ status: "inactive" })
          // Once the deferred route has captured its result, release the
          // process-wide spy before awaiting any command settlement. A broken
          // cancellation path must fail this test without poisoning the next
          // test with a requestCancel implementation that never resolves.
          requestCancel.mockRestore()
          expect((await response).status).toBe(200)
          expect(() => SessionPrompt.assertNotBusy(session.id)).toThrow(Session.BusyError)

          SessionPrompt.cancel(session.id)
          await Promise.all([oldRun, newRun])
        } finally {
          pending.resolve({ status: "inactive" })
          requestCancel.mockRestore()
          SessionPrompt.cancel(session.id)
          await Promise.allSettled([oldRun, ...(newRun ? [newRun] : [])])
          await Session.remove(session.id)
        }
      },
    })
  }, 15_000)

  test("preserves runner timeout provenance on programmatic abort", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await RuntimeEvents.begin({
          sessionID: session.id,
          runID: "run_timeout",
          acceptedAt: 100,
          effort: "normal",
        })

        const response = await SessionRoutes().request(`/${session.id}/abort`, {
          method: "POST",
          headers: { "x-openscience-abort-source": "runner_timeout" },
        })

        expect(response.status).toBe(200)
        expect((await RuntimeEvents.replay(session.id)).events.at(-1)).toMatchObject({
          runID: "run_timeout",
          type: "runtime.cancelled",
          properties: { source: "runner_timeout" },
        })
      },
    })
  })

  test("rejects overlapping runs and cursors that would reconnect with a gap", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await RuntimeEvents.begin({
          sessionID: session.id,
          runID: "run_first",
          acceptedAt: 100,
          effort: "normal",
        })
        await expect(
          RuntimeEvents.begin({
            sessionID: session.id,
            runID: "run_second",
            acceptedAt: 101,
            effort: "normal",
          }),
        ).rejects.toBeInstanceOf(RuntimeEvents.ActiveRunError)
        await RuntimeEvents.finish({ sessionID: session.id, runID: "run_first", messageID: "msg_done" })

        await Storage.write(["runtime_event", Instance.project.id, session.id], {
          nextSequence: 5,
          events: [
            {
              sequence: 4,
              sessionID: session.id,
              runID: "run_later",
              type: "runtime.completed",
              properties: {},
              time: 200,
            },
          ],
        })
        await expect(RuntimeEvents.replay(session.id, 1)).rejects.toBeInstanceOf(RuntimeEvents.CursorExpiredError)
        await expect(RuntimeEvents.replay(session.id, 5)).rejects.toBeInstanceOf(RuntimeEvents.CursorAheadError)
      },
    })
  })

  test("fails closed when the durable journal is malformed", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await Storage.write(["runtime_event", Instance.project.id, session.id], {
          nextSequence: "broken",
          events: [],
        })
        await expect(RuntimeEvents.replay(session.id)).rejects.toBeDefined()
      },
    })
  })

  test("closes a run abandoned by a crashed server before accepting the next prompt", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await Storage.write(["runtime_event", Instance.project.id, session.id], {
          nextSequence: 2,
          events: [
            {
              sequence: 1,
              sessionID: session.id,
              runID: "run_orphaned",
              type: "runtime.accepted",
              properties: { effort: "normal" },
              time: 100,
            },
          ],
          activeRunID: "run_orphaned",
          activeOwner: { pid: 2_147_483_647, identity: "0".repeat(64) },
        })

        await RuntimeEvents.begin({
          sessionID: session.id,
          runID: "run_recovered",
          acceptedAt: 200,
          effort: "ultra",
        })
        expect((await RuntimeEvents.replay(session.id)).events).toMatchObject([
          { sequence: 1, runID: "run_orphaned", type: "runtime.accepted" },
          {
            sequence: 2,
            runID: "run_orphaned",
            type: "runtime.failed",
            properties: { recovered: true },
          },
          { sequence: 3, runID: "run_recovered", type: "runtime.accepted" },
        ])
        await RuntimeEvents.finish({ sessionID: session.id, runID: "run_recovered", messageID: "msg_done" })
      },
    })
  })

  test("caps retained events and rejects a cursor before the retained window", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const events = Array.from({ length: RuntimeEvents.RETAINED_EVENTS }, (_, index) => ({
          sequence: index + 1,
          sessionID: session.id,
          runID: "run_retained",
          type: "test.runtime.retained",
          properties: { index },
          time: index + 1,
        }))
        await Storage.write(["runtime_event", Instance.project.id, session.id], {
          nextSequence: RuntimeEvents.RETAINED_EVENTS + 1,
          events,
        })
        await RuntimeEvents.begin({
          sessionID: session.id,
          runID: "run_latest",
          acceptedAt: 10_000,
          effort: "normal",
        })

        const retained = await RuntimeEvents.replay(session.id, 1)
        expect(retained.events).toHaveLength(RuntimeEvents.RETAINED_EVENTS)
        expect(retained.oldestSequence).toBe(2)
        expect(retained.latestSequence).toBe(RuntimeEvents.RETAINED_EVENTS + 1)
        await expect(RuntimeEvents.replay(session.id, 0)).rejects.toBeInstanceOf(RuntimeEvents.CursorExpiredError)
      },
    })
  })
})

describe("/runtime routes", () => {
  test("drains events queued at the snapshot-to-live boundary exactly once", () => {
    const make = (sequence: number): RuntimeEvents.Event => ({
      sequence,
      sessionID: "ses_handoff",
      runID: "run_handoff",
      type: "test.runtime.tick",
      properties: { sequence },
      time: sequence,
    })
    const queued = [make(2)]
    const delivered: number[] = []
    let receive = (event: RuntimeEvents.Event): void => {
      queued.push(event)
    }

    handoffRuntimeEvents(
      queued,
      (event) => {
        delivered.push(event.sequence)
        if (event.sequence === 2) receive(make(3))
      },
      (live) => {
        receive = live
      },
    )
    receive(make(4))

    expect(delivered).toEqual([2, 3, 4])
    expect(queued).toHaveLength(0)
  })

  test("publishes the prompt, replay, and SSE schemas without changing legacy routes", async () => {
    const specs = await Server.openapi()
    expect(specs.paths?.["/runtime/prompt"]?.post).toBeDefined()
    expect(specs.paths?.["/runtime/events"]?.get).toBeDefined()
    expect(specs.paths?.["/runtime/events/replay"]?.get).toBeDefined()
    expect(specs.paths?.["/session/{sessionID}/prompt_async"]?.post).toBeDefined()
    expect(specs.paths?.["/event"]?.get).toBeDefined()
  })

  test("returns an accepted run immediately and exposes its durable event", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        const prompt = Promise.withResolvers<MessageV2.WithParts>()
        const promptStub: typeof SessionPrompt.prompt = Object.assign(
          (_input: SessionPrompt.PromptInput) => prompt.promise,
          { force: SessionPrompt.prompt.force, schema: SessionPrompt.prompt.schema },
        )
        const promptCall = spyOn(SessionPrompt, "prompt").mockImplementation(promptStub)
        try {
          const response = await RuntimeRoutes().request("/prompt", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionID: session.id, message: "Inspect the data", effort: "normal" }),
          })
          expect(response.status).toBe(202)
          const accepted = (await response.json()) as { runID: string; acceptedAt: number }
          expect(accepted.runID).toStartWith("run_")
          expect(accepted.acceptedAt).toBeGreaterThan(0)
          expect(promptCall.mock.calls[0]?.[0].agent).toBe("research")

          const replay = await RuntimeRoutes().request(`/events/replay?sessionID=${session.id}&afterSequence=0`)
          expect(replay.status).toBe(200)
          expect(await replay.json()).toMatchObject({
            events: [
              {
                sequence: 1,
                sessionID: session.id,
                runID: accepted.runID,
                type: "runtime.accepted",
                properties: { effort: "normal" },
              },
            ],
          })
        } finally {
          prompt.resolve({
            info: {
              id: "msg_runtime_prompt_stub",
              sessionID: session.id,
              role: "user",
              time: { created: 101 },
              agent: "research",
              model: { providerID: "test", modelID: "test" },
              effort: "normal",
            },
            parts: [],
          })
          const started = promptCall.mock.calls.length > 0
          promptCall.mockRestore()
          if (started) {
            await waitUntil(async () =>
              (await RuntimeEvents.replay(session.id)).events.some((event) => event.type === "runtime.completed"),
            )
          }
        }
      },
    })
  })

  test("rejects omitted or unsupported effort before accepting a run", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        for (const body of [
          { sessionID: session.id, message: "No effort" },
          { sessionID: session.id, message: "Bad effort", effort: "maximum" },
        ]) {
          const response = await RuntimeRoutes().request("/prompt", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          })
          expect(response.status).toBe(400)
        }
        expect((await RuntimeEvents.replay(session.id)).events).toHaveLength(0)
      },
    })
  })

  test("frames replayed events with SSE sequence ids", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await RuntimeEvents.begin({
          sessionID: session.id,
          runID: "run_sse",
          acceptedAt: 100,
          effort: "normal",
        })

        const controller = new AbortController()
        const response = await RuntimeRoutes().request(`/events?sessionID=${session.id}&afterSequence=0`, {
          signal: controller.signal,
        })
        expect(response.status).toBe(200)
        expect(response.headers.get("content-type")).toContain("text/event-stream")
        const reader = response.body!.getReader()
        const chunk = await reader.read()
        const text = new TextDecoder().decode(chunk.value)
        expect(text).toContain("id: 1")
        expect(text).toContain("event: runtime.accepted")
        expect(text).toContain('"runID":"run_sse"')
        controller.abort()
        await reader.cancel()
      },
    })
  })

  test("prefers Last-Event-ID over the original query cursor on reconnect", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await Session.create({})
        await RuntimeEvents.begin({
          sessionID: session.id,
          runID: "run_reconnect",
          acceptedAt: 100,
          effort: "normal",
        })
        await Bus.publish(Tick, { sessionID: session.id, value: 2 })

        const controller = new AbortController()
        const response = await RuntimeRoutes().request(`/events?sessionID=${session.id}&afterSequence=0`, {
          headers: { "Last-Event-ID": "1" },
          signal: controller.signal,
        })
        const reader = response.body!.getReader()
        const chunk = await reader.read()
        const text = new TextDecoder().decode(chunk.value)
        expect(text).toContain("id: 2")
        expect(text).not.toContain("id: 1")
        controller.abort()
        await reader.cancel()
      },
    })
  })
})

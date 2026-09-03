import assert from "node:assert/strict"
import { describe, test } from "node:test"
import type { RuntimeEvent } from "../src/v2/gen/types.gen.js"
import { createOpenScienceRuntime, RuntimeEventCursorError } from "../src/v2/runtime.js"

describe("OpenScienceRuntime", () => {
  test("sends the strict public prompt contract and returns the accepted run", async () => {
    let request: Request | undefined
    const runtime = createOpenScienceRuntime({
      baseUrl: "http://runtime.test",
      fetch: async (input) => {
        request = input instanceof Request ? input : new Request(input)
        return Response.json({ runID: "run_public", acceptedAt: 123 }, { status: 202 })
      },
    })

    assert.deepEqual(await runtime.prompt({ sessionID: "ses_public", message: "Analyze this", effort: "ultra" }), {
      runID: "run_public",
      acceptedAt: 123,
    })
    assert.equal(request?.url, "http://runtime.test/runtime/prompt")
    assert.equal(request?.method, "POST")
    assert.deepEqual(await request?.json(), {
      sessionID: "ses_public",
      message: "Analyze this",
      effort: "ultra",
    })
  })

  test("generated prompt serialization keeps normal effort in the request body", async () => {
    let body: unknown
    const runtime = createOpenScienceRuntime({
      baseUrl: "http://runtime.test",
      fetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input)
        body = await request.json()
        return Response.json({ runID: "run_normal", acceptedAt: 321 }, { status: 202 })
      },
    })

    await runtime.prompt({ sessionID: "ses_normal", message: "Summarize", effort: "normal" })
    assert.deepEqual(body, { sessionID: "ses_normal", message: "Summarize", effort: "normal" })
  })

  test("replays from a sequence cursor and yields typed SSE events", async () => {
    const urls: string[] = []
    const controller = new AbortController()
    const event = {
      sequence: 4,
      sessionID: "ses_public",
      runID: "run_public",
      type: "runtime.completed",
      properties: { messageID: "msg_public" },
      time: 456,
    }
    const runtime = createOpenScienceRuntime({
      baseUrl: "http://runtime.test",
      fetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input)
        urls.push(request.url)
        if (request.url.includes("/replay")) {
          return Response.json({ events: [event], oldestSequence: 1, latestSequence: 4 })
        }
        return new Response(`id: 4\nevent: runtime.completed\ndata: ${JSON.stringify(event)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })

    assert.deepEqual(await runtime.replay({ sessionID: "ses_public", afterSequence: 3 }), {
      events: [event],
      oldestSequence: 1,
      latestSequence: 4,
    })
    const received: RuntimeEvent[] = []
    for await (const item of runtime.events({ sessionID: "ses_public", afterSequence: 3, signal: controller.signal })) {
      received.push(item)
      controller.abort()
    }
    assert.deepEqual(received, [event])
    assert.deepEqual(urls, [
      "http://runtime.test/runtime/events/replay?sessionID=ses_public&afterSequence=3",
      "http://runtime.test/runtime/events?sessionID=ses_public&afterSequence=3",
    ])
  })

  test("reconnects after clean EOF with the last delivered sequence", async () => {
    const requests: Request[] = []
    const controller = new AbortController()
    const event = (sequence: number): RuntimeEvent => ({
      sequence,
      sessionID: "ses_reconnect",
      runID: "run_reconnect",
      type: sequence === 1 ? "runtime.accepted" : "runtime.completed",
      properties: sequence === 1 ? { effort: "normal" } : { messageID: "msg_done" },
      time: sequence,
    })
    const runtime = createOpenScienceRuntime({
      baseUrl: "http://runtime.test",
      runtimeReconnectDelayMs: 0,
      fetch: async (input) => {
        const request = input instanceof Request ? input : new Request(input)
        requests.push(request)
        const current = event(requests.length)
        return new Response(`id: ${current.sequence}\nevent: ${current.type}\ndata: ${JSON.stringify(current)}\n\n`, {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })

    const received: RuntimeEvent[] = []
    for await (const item of runtime.events({
      sessionID: "ses_reconnect",
      afterSequence: 0,
      signal: controller.signal,
    })) {
      received.push(item)
      if (received.length === 2) controller.abort()
    }

    assert.deepEqual(
      received.map((item) => item.sequence),
      [1, 2],
    )
    assert.equal(requests.length, 2)
    assert.equal(requests[0]?.headers.get("Last-Event-ID"), "0")
    assert.equal(requests[1]?.headers.get("Last-Event-ID"), "1")
  })

  test("backs off after empty clean closes and resets once events arrive", async () => {
    const times: number[] = []
    const controller = new AbortController()
    const event = {
      sequence: 1,
      sessionID: "ses_empty",
      runID: "run_empty",
      type: "runtime.accepted",
      properties: { effort: "normal" },
      time: 1,
    }
    const runtime = createOpenScienceRuntime({
      baseUrl: "http://runtime.test",
      runtimeReconnectDelayMs: 20,
      fetch: async () => {
        times.push(Date.now())
        if (times.length === 6) controller.abort()
        const body = times.length === 5 ? `id: 1\nevent: runtime.accepted\ndata: ${JSON.stringify(event)}\n\n` : ""
        return new Response(body, { headers: { "content-type": "text/event-stream" } })
      },
    })

    const received: RuntimeEvent[] = []
    for await (const item of runtime.events({ sessionID: "ses_empty", signal: controller.signal })) {
      received.push(item)
    }

    assert.equal(received.length, 1)
    assert.equal(times.length, 6)
    const gaps = times.slice(1).map((time, index) => time - (times[index] ?? time))
    // Four empty closes wait 20, 40, 80, and 160 ms; the delivered event on
    // the fifth connection resets the next wait to the 20 ms base.
    assert.ok((gaps[3] ?? 0) >= 150, `fourth reconnect waited ${gaps[3]}ms`)
    assert.ok((gaps[0] ?? 0) + (gaps[1] ?? 0) + (gaps[2] ?? 0) + (gaps[3] ?? 0) >= 280, `empty closes waited ${gaps}`)
    assert.ok((gaps[4] ?? 0) < 200, `reconnect after a delivered event waited ${gaps[4]}ms`)
  })

  test("surfaces a retained-window conflict without retrying forever", async () => {
    let calls = 0
    const runtime = createOpenScienceRuntime({
      baseUrl: "http://runtime.test",
      runtimeReconnectDelayMs: 0,
      fetch: async () => {
        calls += 1
        return Response.json({ error: "cursor_expired" }, { status: 409, statusText: "Conflict" })
      },
    })

    await assert.rejects(async () => {
      for await (const _ of runtime.events({ sessionID: "ses_expired", afterSequence: 1 })) {
        // No event is expected.
      }
    }, RuntimeEventCursorError)
    assert.equal(calls, 1)
  })

  test("settles a rejecting stream cancellation when the caller aborts", async () => {
    const controller = new AbortController()
    let connected = false
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown) => unhandled.push(error)
    process.on("unhandledRejection", onUnhandled)
    try {
      const runtime = createOpenScienceRuntime({
        baseUrl: "http://runtime.test",
        runtimeReconnectDelayMs: 0,
        fetch: async () => {
          connected = true
          return new Response(
            new ReadableStream({
              pull: () => new Promise<void>(() => {}),
              cancel: () => Promise.reject(new Error("upstream cancel failed")),
            }),
            { headers: { "content-type": "text/event-stream" } },
          )
        },
      })

      const consuming = (async () => {
        for await (const _ of runtime.events({ sessionID: "ses_abort", signal: controller.signal })) {
          // No event is expected.
        }
      })()
      while (!connected) await new Promise((resolve) => setTimeout(resolve, 1))
      controller.abort()
      await consuming
      await new Promise((resolve) => setImmediate(resolve))
      assert.deepEqual(unhandled, [])
    } finally {
      process.off("unhandledRejection", onUnhandled)
    }
  })
})

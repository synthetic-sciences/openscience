import { describe, expect, test } from "bun:test"
import { consumeReconnectingStream, reconnectDelay } from "./reconnecting-event-stream"

describe("global event reconnection", () => {
  test("reconnects after a failed stream and consumes the replacement", async () => {
    const abort = new AbortController()
    const received: string[] = []
    const delays: number[] = []
    let connections = 0

    await consumeReconnectingStream({
      signal: abort.signal,
      connect: async () => {
        connections += 1
        if (connections === 1) throw new Error("connection reset")
        return {
          stream: (async function* () {
            yield "server.connected"
          })(),
        }
      },
      onEvent(event) {
        received.push(event)
        abort.abort()
      },
      sleep(ms) {
        delays.push(ms)
        return Promise.resolve()
      },
    })

    expect(connections).toBe(2)
    expect(delays).toEqual([250])
    expect(received).toEqual(["server.connected"])
  })

  test("keeps backing off when a stream closes right after delivering an event", async () => {
    const abort = new AbortController()
    const delays: number[] = []
    let connections = 0

    await consumeReconnectingStream({
      signal: abort.signal,
      now: () => 0,
      connect: async () => {
        connections += 1
        if (connections === 3) abort.abort()
        return {
          stream: (async function* () {
            yield "server.connected"
          })(),
        }
      },
      onEvent() {},
      sleep(ms) {
        delays.push(ms)
        return Promise.resolve()
      },
    })

    expect(connections).toBe(3)
    expect(delays).toEqual([250, 500])
  })

  test("resets the backoff only after a connection delivered events and stayed open", async () => {
    const abort = new AbortController()
    const delays: number[] = []
    const clock = { now: 0 }
    let connections = 0

    await consumeReconnectingStream({
      signal: abort.signal,
      now: () => clock.now,
      stable: 5_000,
      connect: async () => {
        connections += 1
        if (connections === 4) abort.abort()
        if (connections !== 2) throw new Error("connection reset")
        return {
          stream: (async function* () {
            yield "server.connected"
          })(),
        }
      },
      onEvent() {
        clock.now += 6_000
      },
      sleep(ms) {
        delays.push(ms)
        return Promise.resolve()
      },
    })

    expect(delays).toEqual([250, 250, 250])
  })

  test("continues consuming the stream after an event handler throws", async () => {
    const abort = new AbortController()
    const received: string[] = []
    const warnings: unknown[] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args)
    }

    try {
      await consumeReconnectingStream({
        signal: abort.signal,
        connect: async () => ({
          stream: (async function* () {
            yield "first"
            yield "second"
          })(),
        }),
        onEvent(event) {
          received.push(event)
          if (event === "first") throw new Error("handler failed")
          abort.abort()
        },
        sleep: () => Promise.resolve(),
      })
    } finally {
      console.warn = warn
    }

    expect(received).toEqual(["first", "second"])
    expect(warnings).toHaveLength(1)
  })

  test("backs off failed connection attempts without exceeding five seconds", () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(reconnectDelay)).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000])
  })
})

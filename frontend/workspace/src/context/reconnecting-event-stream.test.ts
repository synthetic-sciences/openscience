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

  test("backs off failed connection attempts without exceeding five seconds", () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(reconnectDelay)).toEqual([250, 500, 1000, 2000, 4000, 5000, 5000])
  })
})

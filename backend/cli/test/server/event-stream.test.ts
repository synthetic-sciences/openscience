import { describe, expect, test } from "bun:test"
import path from "path"
import z from "zod"
import { Bus } from "../../src/bus"
import { BusEvent } from "../../src/bus/bus-event"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { MessageV2 } from "../../src/session/message-v2"
import { Log } from "../../src/util/log"

const projectRoot = path.join(__dirname, "../..")
Log.init({ print: false })

const Ping = BusEvent.define("test.event.stream.ping", z.object({ n: z.number() }))

type Frame = { type: string; properties: { n?: number; part?: { text?: string } } }

async function frames(body: ReadableStream<Uint8Array>, until: (frame: Frame) => boolean) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  const result: Frame[] = []
  const pending = { text: "" }
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) return result
      pending.text += decoder.decode(chunk.value, { stream: true })
      const parts = pending.text.split("\n\n")
      pending.text = parts.pop() ?? ""
      for (const part of parts) {
        const data = part
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .join("\n")
        if (!data) continue
        const frame = JSON.parse(data) as Frame
        result.push(frame)
        if (until(frame)) return result
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

describe("event.subscribe", () => {
  test("a client that never reads its socket does not stall awaited publishes", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const fetch = Server.internalFetch()
        const response = await fetch(`http://openscience.internal/event?directory=${encodeURIComponent(projectRoot)}`)
        expect(response.status).toBe(200)
        expect(response.body).not.toBeNull()

        // Nothing reads the response body yet, so the underlying stream is
        // backpressured after its first frame. Every publish must still settle
        // promptly: the subscriber only enqueues, it never awaits the socket.
        const total = 2500
        const started = Date.now()
        for (let n = 0; n < total; n++) await Bus.publish(Ping, { n })
        expect(Date.now() - started).toBeLessThan(5_000)

        const received = await frames(response.body!, (frame) => frame.properties.n === total - 1)
        expect(received[0]?.type).toBe("server.connected")
        const pings = received.filter((frame) => frame.type === Ping.type).map((frame) => frame.properties.n!)
        // Delivery keeps stream order, converges on the newest events, and the
        // bounded queue dropped the oldest rather than the newest ones.
        expect(pings.at(-1)).toBe(total - 1)
        expect(pings.every((n, index) => index === 0 || n > pings[index - 1]!)).toBe(true)
        expect(pings.length).toBeLessThan(total)
        expect(pings.length).toBeGreaterThan(1_000)
      },
    })
  })

  test("a full queue coalesces part updates onto the newest state in stream order", async () => {
    await Instance.provide({
      directory: projectRoot,
      fn: async () => {
        const fetch = Server.internalFetch()
        const response = await fetch(`http://openscience.internal/event?directory=${encodeURIComponent(projectRoot)}`)
        expect(response.status).toBe(200)
        expect(response.body).not.toBeNull()

        // Fill most of the unread queue with unrelated events, then stream
        // more updates for one part than the remaining capacity so the newest
        // ones must coalesce with updates already queued for that part.
        for (let n = 0; n < 1500; n++) await Bus.publish(Ping, { n })
        const total = 1000
        for (let version = 1; version <= total; version++) {
          await Bus.publish(MessageV2.Event.PartUpdated, {
            part: {
              id: "prt_event_stream",
              sessionID: "ses_event_stream",
              messageID: "msg_event_stream",
              type: "text",
              text: String(version),
            },
            delta: String(version),
          })
        }
        await Bus.publish(Ping, { n: -1 })

        const received = await frames(response.body!, (frame) => frame.properties.n === -1)
        const versions = received
          .filter((frame) => frame.type === MessageV2.Event.PartUpdated.type)
          .map((frame) => Number(frame.properties.part!.text))
        // Coalescing replaced the newest queued update for the part, so the
        // client sees a monotone sequence that ends on the latest state and
        // never an older, truncated part after it.
        expect(versions.at(-1)).toBe(total)
        expect(versions.every((version, index) => index === 0 || version > versions[index - 1]!)).toBe(true)
        expect(versions.length).toBeLessThan(total)
      },
    })
  })
})

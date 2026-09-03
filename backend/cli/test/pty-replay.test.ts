import { expect, test } from "bun:test"
import { Replay } from "@/pty/replay"

const LIMIT = 2 * 1024 * 1024
const CHUNK = 64 * 1024

test("keeps a bounded canonical PTY stream and replays it in transport-sized chunks", () => {
  const small = Replay.append(Replay.append(Replay.create(), "first"), "-second")
  expect(Replay.text(small)).toBe("first-second")
  expect(Replay.chunks(small)).toEqual(["first-second"])

  const data = "x".repeat(LIMIT + 5)
  const ring = Replay.append(Replay.append(Replay.create(), "prefix"), data)
  const replay = Replay.text(ring)
  const chunks = Replay.chunks(ring)

  expect(replay.length).toBe(ring.length)
  expect(replay.length).toBeLessThanOrEqual(LIMIT)
  expect(replay.length).toBeGreaterThan(LIMIT - CHUNK)
  expect(replay).toBe(data.slice(-replay.length))
  expect(chunks.every((chunk) => chunk.length <= CHUNK)).toBe(true)
  expect(chunks.join("")).toBe(replay)
})

test("drops whole chunks from the head and packs small writes without copying the budget", () => {
  const ring = Replay.create()
  for (let index = 0; index < 1000; index++) Replay.append(ring, "y")
  expect(ring.chunks).toHaveLength(1)
  expect(Replay.text(ring)).toBe("y".repeat(1000))

  const stream = ["a".repeat(CHUNK), "b".repeat(CHUNK), "c".repeat(LIMIT - CHUNK)]
  for (const piece of stream) Replay.append(ring, piece)
  const replay = Replay.text(ring)
  expect(ring.length).toBeLessThanOrEqual(LIMIT)
  expect(ring.length).toBeGreaterThan(LIMIT - CHUNK)
  expect(replay).toBe(("y".repeat(1000) + stream.join("")).slice(-replay.length))
  expect(ring.chunks.every((chunk) => chunk.length <= CHUNK)).toBe(true)
  expect(Replay.chunks(ring).join("")).toBe(replay)
})

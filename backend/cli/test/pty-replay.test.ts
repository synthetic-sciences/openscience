import { expect, test } from "bun:test"
import { Replay } from "@/pty/replay"

test("keeps a bounded canonical PTY stream and replays it in transport-sized chunks", () => {
  expect(Replay.append("first", "-second")).toBe("first-second")

  const data = "x".repeat(2 * 1024 * 1024 + 5)
  const replay = Replay.append("prefix", data)
  const chunks = Replay.chunks(replay)

  expect(replay).toHaveLength(2 * 1024 * 1024)
  expect(replay).toBe(data.slice(-2 * 1024 * 1024))
  expect(chunks.every((chunk) => chunk.length <= 64 * 1024)).toBe(true)
  expect(chunks.join("")).toBe(replay)
})

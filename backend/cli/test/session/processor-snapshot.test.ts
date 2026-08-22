import { describe, expect, test } from "bun:test"
import { SessionProcessor } from "../../src/session/processor"

describe("session processor snapshot routing", () => {
  test("tracks only when the model can execute an advertised tool", () => {
    expect(SessionProcessor.tracks({ tools: {}, toolcall: true })).toBe(false)
    expect(SessionProcessor.tracks({ tools: { bash: {} }, toolcall: false })).toBe(false)
    expect(SessionProcessor.tracks({ tools: { bash: {} }, toolcall: true })).toBe(true)
  })

  test("finishing a streamed part preserves its first-output timestamp", () => {
    expect(SessionProcessor.finishTime({ start: 123 }, 456)).toEqual({ start: 123, end: 456 })
    expect(SessionProcessor.finishTime(undefined, 456)).toEqual({ start: 456, end: 456 })
  })
})

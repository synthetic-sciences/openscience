import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"

const long = (n: number) => "x".repeat(n)

describe("compactToolInput under compaction.pruneInputs", () => {
  test("a call that was not pruned keeps every argument byte-exact", () => {
    const input = { patchText: long(50_000) }
    expect(MessageV2.compactToolInput("apply_patch", input, false)).toBe(input)
  })

  test("a pruned call's recoverable body becomes the preview the write guard refuses", () => {
    const body = long(50_000)
    const reduced = MessageV2.compactToolInput("apply_patch", { patchText: body, filePath: "/app/x.py" }, true)
    expect(reduced.patchText).not.toBe(body)
    expect(MessageV2.hasArgTruncationMarker(String(reduced.patchText))).toBe(true)
    // The path stays whole: it is short, and the model steers by it.
    expect(reduced.filePath).toBe("/app/x.py")
  })

  test("an argument nothing can give back stays whole however long it is", () => {
    // A shell line, a worker's brief and a search pattern exist only here;
    // previewing them would destroy work rather than defer a read.
    const command = long(50_000)
    expect(MessageV2.compactToolInput("bash", { command }, true).command).toBe(command)
    const prompt = long(50_000)
    expect(MessageV2.compactToolInput("task", { prompt }, true).prompt).toBe(prompt)
    const pattern = long(50_000)
    expect(MessageV2.compactToolInput("grep", { pattern }, true).pattern).toBe(pattern)
  })

  test("a short recoverable body is not worth a read", () => {
    const content = long(MessageV2.INPUT_PREVIEW_FLOOR - 1)
    expect(MessageV2.compactToolInput("write", { content }, true).content).toBe(content)
  })
})

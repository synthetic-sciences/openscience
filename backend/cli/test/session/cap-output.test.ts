import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"

const MARKER = /\[… ([\d,]+) characters of this result omitted for the handoff …\]/

/** The count the marker claims beside the count the output really leaves behind. */
function omission(text: string, max: number) {
  const reported = Number(MessageV2.capOutput(text, max).match(MARKER)?.[1]?.replaceAll(",", ""))
  const tail = Math.floor(max / 5)
  const kept = text.slice(0, max - tail).trimEnd().length + text.slice(-tail).trimStart().length
  return { reported, dropped: text.length - kept }
}

describe("capOutput", () => {
  test("the omission marker does not count the tail it hands over in full", () => {
    const { reported, dropped } = omission("x".repeat(10_000), 2_000)
    expect(dropped).toBe(8_000)
    expect(reported).toBe(dropped)
  })

  test("whitespace trimmed at the cut is omitted too", () => {
    const text = `${"x".repeat(1_597)}   ${"y".repeat(400)}   ${"z".repeat(1_597)}`
    const { reported, dropped } = omission(text, 2_000)
    expect(dropped).toBe(1_603) // the 1,600-character gap plus the 3 spaces trimmed off the head
    expect(reported).toBe(dropped)
  })

  test("a result within the cap is handed over unmarked", () => {
    const text = "x".repeat(2_000)
    expect(MessageV2.capOutput(text, 2_000)).toBe(text)
    expect(MessageV2.capOutput("short", undefined)).toBe("short")
  })
})

test("a tiny cap does not duplicate the entire result through a zero-length tail", () => {
  expect(MessageV2.capOutput("abcdef", 0)).toBe("")
  for (const max of [1, 2, 3, 4]) {
    expect(MessageV2.capOutput("abcdef", max)).toBe(
      `${"abcdef".slice(0, max)}\n[… ${6 - max} characters of this result omitted for the handoff …]\n`,
    )
  }
})

import { expect, test } from "bun:test"
import { hasRepeatedTail } from "../../src/session/loop-guard"

const STATE_BLOCK =
  "# Research State: placeholder topic here\n## Current Stage\nSCOPE\n## Research Question\nplaceholder question line\n## Artifacts\n- literature-review.md: missing\n- reasoning.md: missing\n"

test("hasRepeatedTail: trips when a substantial block repeats back-to-back", () => {
  expect(hasRepeatedTail(STATE_BLOCK.repeat(3))).toBe(true)
  expect(hasRepeatedTail("intro paragraph. " + STATE_BLOCK.repeat(4))).toBe(true)
})

test("hasRepeatedTail: does NOT trip on varied text or too-few repeats", () => {
  expect(hasRepeatedTail(STATE_BLOCK)).toBe(false) // one copy
  expect(hasRepeatedTail(STATE_BLOCK.repeat(2))).toBe(false) // only two copies
  expect(
    hasRepeatedTail(
      "A genuinely varied paragraph about sensorless SMA control that never repeats any substantial block of text and keeps introducing new clauses and ideas throughout its length.",
    ),
  ).toBe(false)
})

test("hasRepeatedTail: ignores short-period repeats (below the block minimum)", () => {
  expect(hasRepeatedTail("ab".repeat(300))).toBe(false) // period 2 « min block
  expect(hasRepeatedTail("\n".repeat(500))).toBe(false)
})

import { describe, test, expect } from "bun:test"
import { revealStep } from "./typewriter"

describe("revealStep", () => {
  test("never exceeds target", () => {
    expect(revealStep(95, 100, 1000)).toBe(100)
  })
  test("never decreases", () => {
    expect(revealStep(100, 40, 16)).toBe(100)
  })
  test("advances at least minCps", () => {
    // 30 cps over 100ms ≈ 3 chars minimum
    expect(revealStep(0, 1000, 100, { minCps: 30 })).toBeGreaterThanOrEqual(3)
  })
  test("drains a large buffer faster than the floor", () => {
    // buffer 1000, drainMs 250 → ~4000 cps → ~64 chars in 16ms
    expect(revealStep(0, 1000, 16, { drainMs: 250, minCps: 30 })).toBeGreaterThan(30)
  })
  test("returns integer counts", () => {
    expect(Number.isInteger(revealStep(0, 1000, 16))).toBe(true)
  })
})

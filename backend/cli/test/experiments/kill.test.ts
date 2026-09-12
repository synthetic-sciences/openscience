import { describe, expect, test } from "bun:test"
import { KillCriteria } from "../../src/experiments/kill"

describe("kill criteria", () => {
  test("parses time, step, plateau and threshold rules in natural phrasings", () => {
    const parsed = KillCriteria.parse(
      "1 hour OR kill after 30 minutes, 5000 steps; val_loss plateaus for 500 steps OR val_loss > 5.0 for 100 steps\nacc below 0.1 for 50 steps OR nonsense rule",
    )
    expect(parsed.rules.map((rule) => rule.kind)).toEqual([
      "time",
      "time",
      "steps",
      "plateau",
      "threshold",
      "threshold",
    ])
    expect(parsed.rules[0]).toMatchObject({ seconds: 3600 })
    expect(parsed.rules[1]).toMatchObject({ seconds: 1800 })
    expect(parsed.rules[4]).toMatchObject({ key: "val_loss", op: ">", value: 5, window: 100 })
    expect(parsed.rules[5]).toMatchObject({ key: "acc", op: "<", value: 0.1, window: 50 })
    expect(parsed.unparsed).toEqual(["nonsense rule"])
    expect(KillCriteria.parse("").rules).toEqual([])
    // The phrasings a model actually writes.
    const spoken = KillCriteria.parse(
      "Kill any run after 2 minutes. Stop the run if val_loss exceeds 9 for 10 steps; no improvement for 300 steps",
    )
    expect(spoken.unparsed).toEqual([])
    expect(spoken.rules[0]).toMatchObject({ kind: "time", seconds: 120 })
    expect(spoken.rules[1]).toMatchObject({ kind: "threshold", key: "val_loss", op: ">", value: 9, window: 10 })
    expect(spoken.rules[2]).toMatchObject({ kind: "plateau", key: "", window: 300 })
  })

  test("fires each rule from a metric snapshot and names the reason", () => {
    const { rules } = KillCriteria.parse(
      "10 minutes OR 100 steps OR val_loss plateaus for 20 steps OR val_loss > 9 for 3 steps",
    )
    const now = Date.now()
    const series = (values: number[]) => values.map((value, index) => ({ step: index * 5, value }))
    const quiet = (data: Record<string, Array<{ step: number; value: number }>>) => ({
      startedAt: now,
      now,
      lastStep: 50,
      recent: (key: string, limit: number) => (data[key] ?? []).slice(-limit),
    })
    expect(KillCriteria.check(rules, quiet({ val_loss: series([1, 0.9, 0.8]) }))).toBeUndefined()
    expect(KillCriteria.check(rules, { ...quiet({}), now: now + 11 * 60_000 })).toContain("time budget")
    expect(KillCriteria.check(rules, { ...quiet({}), lastStep: 120 })).toContain("step budget")
    // Best value at step 0, no improvement for 25 steps.
    expect(KillCriteria.check(rules, quiet({ val_loss: series([0.5, 0.6, 0.7, 0.8, 0.9, 1.0]) }))).toContain(
      "plateaued",
    )
    expect(KillCriteria.check(rules, quiet({ val_loss: series([1, 9.5, 9.6, 9.7]) }))).toContain(
      "val_loss > 9 for 3 steps",
    )
    // Two of three above the threshold does not fire.
    expect(KillCriteria.check(rules, quiet({ val_loss: series([9.5, 1, 9.7]) }))).toBeUndefined()
  })

  test("infers direction from the metric name and respects the study's declaration", () => {
    expect(KillCriteria.direction("val_loss")).toBe("minimize")
    expect(KillCriteria.direction("val_acc")).toBe("maximize")
    expect(KillCriteria.direction("weird_metric", { metric: "weird_metric", direction: "maximize" })).toBe("maximize")
  })
})

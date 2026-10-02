import { expect, test } from "bun:test"
import { work } from "../../src/util/queue"

test("every item runs once, whatever the order", async () => {
  const seen: number[] = []
  await work(2, [1, 2, 3, 4, 5], async (item) => {
    seen.push(item)
  })
  expect(seen.toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4, 5])
})

test("an item that is itself undefined does not strand the rest of the batch", async () => {
  // A popped `undefined` is indistinguishable from an exhausted queue, so this
  // used to retire the worker on the undefined and silently leave every item
  // behind it unprocessed — while the call still resolved successfully.
  const seen: (string | undefined)[] = []
  await work(1, ["a", undefined, "c"], async (item) => {
    seen.push(item)
  })
  expect(seen).toHaveLength(3)
  expect(seen.filter((item) => item === "a")).toHaveLength(1)
  expect(seen.filter((item) => item === "c")).toHaveLength(1)
  expect(seen.filter((item) => item === undefined)).toHaveLength(1)
})

test("a concurrency below one is refused instead of quietly doing nothing", async () => {
  // Zero workers meant no items ran and the promise still resolved, so a
  // caller passing a config-derived value got a silent no-op. Cleanup already
  // refuses the same values for its own concurrency.
  for (const concurrency of [0, -1, 1.5, NaN, Infinity]) {
    let called = 0
    await expect(work(concurrency, [1, 2, 3], async () => void called++)).rejects.toThrow(
      "Queue concurrency must be a positive integer",
    )
    expect(called).toBe(0)
  }
})

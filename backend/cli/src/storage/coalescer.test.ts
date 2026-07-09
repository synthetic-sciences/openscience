import { describe, test, expect } from "bun:test"
import { createCoalescer } from "./coalescer"

describe("createCoalescer", () => {
  test("flushNow writes the latest value and cancels the pending timer", async () => {
    const writes: [string, number][] = []
    const c = createCoalescer<number>((k, v) => void writes.push([k, v]), 1000)
    c.push("a", 1)
    c.push("a", 2)
    c.push("a", 3)
    await c.flushNow("a")
    expect(writes).toEqual([["a", 3]])
  })

  test("flushAll writes latest per key once", async () => {
    const writes: [string, number][] = []
    const c = createCoalescer<number>((k, v) => void writes.push([k, v]), 1000)
    c.push("a", 1)
    c.push("b", 9)
    c.push("a", 2)
    await c.flushAll()
    expect(writes.sort()).toEqual([
      ["a", 2],
      ["b", 9],
    ])
  })

  test("flushNow on an unknown key is a no-op", async () => {
    const writes: string[] = []
    const c = createCoalescer<number>((k) => void writes.push(k), 1000)
    await c.flushNow("missing")
    expect(writes).toEqual([])
  })

  test("flushWhere only flushes keys matching the predicate", async () => {
    const writes: [string, number][] = []
    const c = createCoalescer<number>((k, v) => void writes.push([k, v]), 1000)
    c.push("sessionA/msg1/part1", 1)
    c.push("sessionA/msg1/part2", 2)
    c.push("sessionB/msg1/part1", 9)
    await c.flushWhere((k) => k.startsWith("sessionA/"))
    expect(writes.sort()).toEqual([
      ["sessionA/msg1/part1", 1],
      ["sessionA/msg1/part2", 2],
    ])
    await c.flushAll()
    expect(writes.sort()).toEqual([
      ["sessionA/msg1/part1", 1],
      ["sessionA/msg1/part2", 2],
      ["sessionB/msg1/part1", 9],
    ])
  })
})

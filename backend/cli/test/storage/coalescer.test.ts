import { describe, expect, test } from "bun:test"
import { createCoalescer } from "../../src/storage/coalescer"

describe("coalesced storage writes", () => {
  test("coalesces pending values and keeps final writes ordered behind an in-flight timer", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const writes: string[] = []
    const coalescer = createCoalescer<string>(async (_key, value) => {
      if (value === "streaming") {
        started.resolve()
        await release.promise
      }
      writes.push(value)
    }, 1)
    coalescer.push("session/part", "old")
    coalescer.push("session/part", "streaming")
    await started.promise
    coalescer.push("session/part", "complete")
    const final = coalescer.flushNow("session/part")
    await Bun.sleep(0)
    expect(writes).toEqual([])
    release.resolve()
    await final
    expect(writes).toEqual(["streaming", "complete"])
  })

  test.each(["now", "where", "all"] as const)(
    "%s flush waits for a timer-driven write even when no value remains pending",
    async (mode) => {
      const started = Promise.withResolvers<void>()
      const release = Promise.withResolvers<void>()
      let durable = false
      let settled = false
      const coalescer = createCoalescer(async () => {
        started.resolve()
        await release.promise
        durable = true
      }, 1)
      coalescer.push("session/part", "partial")
      await started.promise
      const wait =
        mode === "now"
          ? coalescer.flushNow("session/part")
          : mode === "where"
            ? coalescer.flushWhere((key) => key.startsWith("session/"))
            : coalescer.flushAll()
      const flushed = wait.then(() => {
        settled = true
      })
      await Bun.sleep(0)
      expect(settled).toBe(false)
      release.resolve()
      await flushed
      expect(durable).toBe(true)
    },
  )

  test("a scoped flush does not wait for another session's in-flight write", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const writes: string[] = []
    const coalescer = createCoalescer<string>(async (key, value) => {
      if (key === "other/part") {
        started.resolve()
        await release.promise
      }
      writes.push(value)
    }, 1)
    coalescer.push("other/part", "unrelated")
    await started.promise
    coalescer.push("session/part", "complete")
    await coalescer.flushWhere((key) => key.startsWith("session/"))
    expect(writes).toEqual(["complete"])
    release.resolve()
    await coalescer.flushAll()
    expect(writes).toEqual(["complete", "unrelated"])
  })

  test("an in-flight storage failure is observable by an explicit flush", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const failure = new Error("Storage unavailable")
    const errors: unknown[] = []
    const coalescer = createCoalescer(
      async () => {
        started.resolve()
        await release.promise
        throw failure
      },
      1,
      (_key, error) => {
        errors.push(error)
      },
    )
    coalescer.push("session/part", "partial")
    await started.promise
    const rejected = coalescer.flushWhere(() => true).catch((error) => error)
    release.resolve()
    expect(await rejected).toBe(failure)
    expect(errors).toEqual([failure])
  })

  test("a failed write does not poison a queued final value", async () => {
    const started = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    const failure = new Error("First write failed")
    const writes: string[] = []
    const coalescer = createCoalescer<string>(async (_key, value) => {
      if (value === "partial") {
        started.resolve()
        await release.promise
        throw failure
      }
      writes.push(value)
    }, 100)
    coalescer.push("session/part", "partial")
    const rejected = coalescer.flushNow("session/part").catch((error) => error)
    await started.promise
    coalescer.push("session/part", "complete")
    const final = coalescer.flushNow("session/part")
    release.resolve()
    expect(await rejected).toBe(failure)
    await final
    expect(writes).toEqual(["complete"])
  })
})

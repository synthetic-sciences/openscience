import { afterEach, describe, expect, test } from "bun:test"
import { UpdateQuiescence } from "../../src/process/update-quiescence"
import { createGracefulDisposer } from "../../src/process/graceful-shutdown"

describe("desktop update quiescence", () => {
  let cleanup: (() => void) | undefined

  afterEach(() => {
    cleanup?.()
    cleanup = undefined
    expect(UpdateQuiescence.pending()).toBe(false)
    expect(UpdateQuiescence.admitted()).toBe(0)
  })

  test("refuses to drain while a start is admitted", () => {
    const release = UpdateQuiescence.enter()
    expect(UpdateQuiescence.admitted()).toBe(1)
    expect(() => UpdateQuiescence.begin()).toThrow("starting new work")
    release()

    cleanup = UpdateQuiescence.begin()
    expect(UpdateQuiescence.pending()).toBe(true)
    expect(() => UpdateQuiescence.enter()).toThrow("restarting to install")
  })

  test("release is idempotent and reopens admission", () => {
    cleanup = UpdateQuiescence.begin()
    cleanup()
    cleanup()
    cleanup = undefined

    const release = UpdateQuiescence.enter()
    release()
    release()
  })

  test("interactive terminals, kernel executions, and MCP requests are visible blockers", () => {
    const terminal = UpdateQuiescence.enter("pty")
    const kernel = UpdateQuiescence.enter("kernel")
    const mcp = UpdateQuiescence.enter("mcp")
    expect(UpdateQuiescence.inventory()).toEqual({ admitted: 3, pty: 1, kernel: 1, mcp: 1 })
    expect(() => UpdateQuiescence.begin()).toThrow("starting new work")

    terminal()
    kernel()
    mcp()
    expect(UpdateQuiescence.inventory()).toEqual({ admitted: 0, pty: 0, kernel: 0, mcp: 0 })
  })

  test("graceful disposal seals admission, coalesces callers, and awaits every runtime disposer", async () => {
    const events: string[] = []
    const commands = Promise.withResolvers<void>()
    const instances = Promise.withResolvers<void>()
    const dispose = createGracefulDisposer({
      seal: () => events.push("sealed"),
      stopCommands: async () => {
        events.push("commands")
        return commands.promise
      },
      disposeInstances: async () => {
        events.push("instances")
        return instances.promise
      },
    })

    const first = dispose({ timeoutMs: 1_000 })
    const second = dispose({ timeoutMs: 1_000 })
    await Promise.resolve()
    expect(events).toEqual(["sealed", "commands", "instances", "sealed"])
    commands.resolve()
    instances.resolve()
    await Promise.all([first, second])
    expect(events.filter((event) => event === "commands")).toHaveLength(1)
    expect(events.filter((event) => event === "instances")).toHaveLength(1)
  })

  test("a failed strict disposal can be retried without overlapping the failed operation", async () => {
    let attempts = 0
    const dispose = createGracefulDisposer({
      seal() {},
      stopCommands: async () => undefined,
      disposeInstances: async () => {
        attempts++
        if (attempts === 1) throw new Error("ledger busy")
      },
    })

    await expect(dispose()).rejects.toThrow("could not release")
    await dispose()
    expect(attempts).toBe(2)
  })
})

import { describe, expect, test } from "bun:test"
import { queueStartupUpdateCheck } from "./startup-update"

describe("startup update preference", () => {
  test("does not schedule a network request when startup checks are disabled", () => {
    let scheduled = 0
    let checked = 0
    queueStartupUpdateCheck({
      enabled: false,
      check: async () => {
        checked++
        return { updateAvailable: true }
      },
      notify: () => {},
      schedule: (() => {
        scheduled++
        return 1 as unknown as ReturnType<typeof setTimeout>
      }) as (run: () => void, delay: number) => ReturnType<typeof setTimeout>,
    })

    expect(scheduled).toBe(0)
    expect(checked).toBe(0)
  })

  test("defers the real check and only announces an available update", async () => {
    const queued: Array<() => void> = []
    const notices: string[] = []
    let checked = 0
    queueStartupUpdateCheck({
      enabled: true,
      check: async () => {
        checked++
        return { updateAvailable: true, version: "2.1.0" }
      },
      notify: (result) => notices.push(result.version ?? "missing"),
      schedule: ((run) => {
        queued.push(run)
        return 1 as unknown as ReturnType<typeof setTimeout>
      }) as (run: () => void, delay: number) => ReturnType<typeof setTimeout>,
    })

    expect(checked).toBe(0)
    expect(queued).toHaveLength(1)
    queued[0]!()
    await Promise.resolve()
    await Promise.resolve()

    expect(checked).toBe(1)
    expect(notices).toEqual(["2.1.0"])
  })

  test("cancellation prevents a queued check after the app unmounts", () => {
    let run: (() => void) | undefined
    let checked = 0
    let cancelled = 0
    const stop = queueStartupUpdateCheck({
      enabled: true,
      check: async () => {
        checked++
        return { updateAvailable: false }
      },
      notify: () => {},
      schedule: ((next) => {
        run = next
        return 7 as unknown as ReturnType<typeof setTimeout>
      }) as (run: () => void, delay: number) => ReturnType<typeof setTimeout>,
      cancel: () => cancelled++,
    })

    stop()
    run?.()

    expect(cancelled).toBe(1)
    expect(checked).toBe(0)
  })

  test("a failed background check is contained and never notifies", async () => {
    let run: (() => void) | undefined
    let notices = 0
    queueStartupUpdateCheck({
      enabled: true,
      check: async () => {
        throw new Error("registry unavailable")
      },
      notify: () => notices++,
      schedule: ((next) => {
        run = next
        return 1 as unknown as ReturnType<typeof setTimeout>
      }) as (run: () => void, delay: number) => ReturnType<typeof setTimeout>,
    })

    run?.()
    await Promise.resolve()
    await Promise.resolve()

    expect(notices).toBe(0)
  })
})

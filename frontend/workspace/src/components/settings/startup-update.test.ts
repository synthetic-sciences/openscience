import { describe, expect, test } from "bun:test"
import { queueStartupUpdateCheck, updateNotice } from "./startup-update"

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

describe("startup update notice", () => {
  test("says nothing when there is no update and no result", () => {
    expect(updateNotice({ phase: "idle" })).toBeUndefined()
  })

  test("a newer release outranks a finished update result and keeps its action", () => {
    const notice = updateNotice({
      phase: "succeeded",
      version: "2.0.126",
      completed_at: "2026-09-20T09:44:55.838Z",
      available: "2.0.127",
    })
    expect(notice?.kind).toBe("available")
    expect(notice?.title).toBe("OpenScience 2.0.127 is available")
    expect(notice?.primary).toEqual({ label: "Download and restart", busy: false })
  })

  test("offers the newer release from a plain launch too", () => {
    expect(updateNotice({ phase: "idle", available: "2.0.127" })?.title).toBe("OpenScience 2.0.127 is available")
  })

  test("reports the installed update only while nothing newer is offered", () => {
    const notice = updateNotice({ phase: "succeeded", version: "2.0.127", completed_at: "2026-09-20T09:44:55.838Z" })
    expect(notice?.kind).toBe("succeeded")
    expect(notice?.title).toBe("Updated to OpenScience 2.0.127")
    expect(notice?.primary).toBeUndefined()
  })

  test("follows the download and keeps the person from pressing twice", () => {
    const downloading = updateNotice({
      phase: "downloading",
      version: "2.0.127",
      transferred: 1_500_000,
      total: 3_000_000,
    })
    expect(downloading?.kind).toBe("preparing")
    expect(downloading?.primary?.busy).toBe(true)
    expect(downloading?.detail).toBe("1.4 MiB of 2.9 MiB downloaded")
    expect(updateNotice({ phase: "verifying", version: "2.0.127" })?.primary?.busy).toBe(true)
  })

  test("a verified update restarts, moving the copy first when it must", () => {
    expect(updateNotice({ phase: "ready", version: "2.0.127" })?.primary).toEqual({
      label: "Restart to update",
      busy: false,
    })
    expect(updateNotice({ phase: "ready", version: "2.0.127", migration_required: true })?.primary?.label).toBe(
      "Move & restart",
    )
  })

  test("a refused or failed attempt stays recoverable", () => {
    const blocked = updateNotice({ phase: "restart_blocked", version: "2.0.127", error: "Close the installer first" })
    expect(blocked?.primary).toEqual({ label: "Retry restart", busy: false })
    expect(blocked?.detail).toBe("Close the installer first")

    const failed = updateNotice({ phase: "failed", version: "2.0.127", error: "publisher verification failed" })
    expect(failed?.primary).toEqual({ label: "Retry", busy: false })
    expect(failed?.detail).toBe("publisher verification failed")
  })

  test("a restart in flight names the version it is finishing", () => {
    const notice = updateNotice({ phase: "restarting", version: "2.0.127" })
    expect(notice?.title).toBe("Restarting OpenScience 2.0.127")
    expect(notice?.primary?.busy).toBe(true)
  })
})

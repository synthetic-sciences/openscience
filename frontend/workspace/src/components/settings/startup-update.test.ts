import { describe, expect, test } from "bun:test"
import { queueStartupUpdateCheck, updateNotice, updateNoticeLine } from "./startup-update"

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
    expect(updateNotice({ phase: "idle" }, "download-and-restart")).toBeUndefined()
  })

  test("a newer release outranks a finished update result and keeps its action", () => {
    const notice = updateNotice(
      {
        phase: "succeeded",
        version: "2.0.126",
        completed_at: "2026-09-20T09:44:55.838Z",
        available: "2.0.127",
      },
      "download-and-restart",
    )
    expect(notice?.kind).toBe("available")
    expect(notice?.title).toBe("OpenScience 2.0.127 is available")
    expect(notice?.primary).toEqual({ label: "Download and restart", busy: false })
  })

  test("offers the newer release from a plain launch too", () => {
    expect(updateNotice({ phase: "idle", available: "2.0.127" }, "download-and-restart")?.title).toBe(
      "OpenScience 2.0.127 is available",
    )
  })

  test("reports the installed update only while nothing newer is offered", () => {
    const notice = updateNotice(
      { phase: "succeeded", version: "2.0.127", completed_at: "2026-09-20T09:44:55.838Z" },
      "download-and-restart",
    )
    expect(notice?.kind).toBe("succeeded")
    expect(notice?.title).toBe("Updated to OpenScience 2.0.127")
    expect(notice?.primary).toBeUndefined()
  })

  test("follows the download and keeps the person from pressing twice", () => {
    const downloading = updateNotice(
      {
        phase: "downloading",
        version: "2.0.127",
        transferred: 1_500_000,
        total: 3_000_000,
      },
      "download-and-restart",
    )
    expect(downloading?.kind).toBe("preparing")
    expect(downloading?.primary?.busy).toBe(true)
    expect(downloading?.detail).toBe("1.4 MiB of 2.9 MiB downloaded")
    expect(updateNotice({ phase: "verifying", version: "2.0.127" }, "download")?.primary?.busy).toBe(true)
  })

  test("a verified update restarts, moving the copy first when it must", () => {
    expect(updateNotice({ phase: "ready", version: "2.0.127" }, "download-and-restart")?.primary).toEqual({
      label: "Restart to update",
      busy: false,
    })
    expect(
      updateNotice({ phase: "ready", version: "2.0.127", migration_required: true }, "download")?.primary?.label,
    ).toBe("Move & restart")
  })

  test("a refused or failed attempt stays recoverable", () => {
    const blocked = updateNotice(
      { phase: "restart_blocked", version: "2.0.127", error: "Close the installer first" },
      "download-and-restart",
    )
    expect(blocked?.primary).toEqual({ label: "Retry restart", busy: false })
    expect(blocked?.detail).toBe("Close the installer first")

    const failed = updateNotice(
      { phase: "failed", version: "2.0.127", error: "publisher verification failed" },
      "download-and-restart",
    )
    expect(failed?.primary).toEqual({ label: "Retry", busy: false })
    expect(failed?.detail).toBe("publisher verification failed")
  })

  test("a restart in flight names the version it is finishing", () => {
    const notice = updateNotice({ phase: "restarting", version: "2.0.127" }, "download-and-restart")
    expect(notice?.title).toBe("Restarting OpenScience 2.0.127")
    expect(notice?.primary?.busy).toBe(true)
  })

  test("promises one press only where there is one", () => {
    const offer = { phase: "idle", available: "2.0.127" } as const

    const banner = updateNotice(offer, "download-and-restart")
    expect(banner?.primary?.label).toBe("Download and restart")
    expect(banner?.detail).toBe("One press downloads and verifies the signed update, then restarts OpenScience.")

    // Customize → General downloads; the restart is a second press there.
    const settings = updateNotice(offer, "download")
    expect(settings?.primary?.label).toBe("Download 2.0.127")
    expect(settings?.detail).toBe("Download the signed update and restart when you are ready.")

    // No in-app staging (off macOS, or an unpackaged build): nothing in the app
    // can download or restart, so the copy and the action are the release page.
    const installer = updateNotice(offer, "installer")
    expect(installer?.primary?.label).toBe("Download installer")
    expect(installer?.detail).toBe("Get the installer from the releases page and reinstall to update.")
    expect(installer?.title).toBe("OpenScience 2.0.127 is available")
  })

  test("says the same thing in one sentence for a single copy slot", () => {
    expect(updateNoticeLine(updateNotice({ phase: "idle", available: "2.0.127" }, "download")!)).toBe(
      "OpenScience 2.0.127 is available. Download the signed update and restart when you are ready.",
    )
    expect(
      updateNoticeLine(
        updateNotice(
          { phase: "downloading", version: "2.0.127", transferred: 1_500_000, total: 3_000_000 },
          "download",
        )!,
      ),
    ).toBe("Preparing OpenScience 2.0.127. 1.4 MiB of 2.9 MiB downloaded.")
    expect(updateNoticeLine(updateNotice({ phase: "failed", version: "2.0.127" }, "download")!)).toBe(
      "OpenScience could not prepare the update.",
    )
    expect(updateNoticeLine(updateNotice({ phase: "idle", available: "2.0.127" }, "installer")!)).toBe(
      "OpenScience 2.0.127 is available. Get the installer from the releases page and reinstall to update.",
    )
  })
})

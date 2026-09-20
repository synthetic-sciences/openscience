import { describe, expect, test } from "bun:test"
import type { DesktopUpdateState, Platform } from "@/context/platform"
import { createUpdateController, formatUpdateBytes, offeredUpdate, pollDelay } from "./update-controller"

const flush = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve()
}

function platform(input: { states: DesktopUpdateState[]; calls: string[] }): Platform {
  return {
    platform: "desktop",
    openLink() {},
    async restart() {},
    back() {},
    forward() {},
    async notify() {},
    async checkUpdate() {
      input.calls.push("check")
      return { updateAvailable: true, version: "2.0.54" }
    },
    async stageUpdate() {
      input.calls.push("stage")
      return { phase: "downloading", version: "2.0.54", transferred: 10, total: 100 }
    },
    async updateState() {
      input.calls.push("state")
      return input.states.shift() ?? { phase: "idle" }
    },
    async applyUpdate() {
      input.calls.push("apply")
      return { phase: "restarting", version: "2.0.54" }
    },
    async cancelUpdate() {
      input.calls.push("cancel")
      return { phase: "idle" }
    },
  }
}

describe("desktop update controller", () => {
  test("polls a supervised launch until the newly installed version proves health", async () => {
    const calls: string[] = []
    const queued: Array<() => void> = []
    const controller = createUpdateController(
      platform({
        states: [
          { phase: "restarting", version: "2.0.76" },
          { phase: "succeeded", version: "2.0.76", completed_at: "2026-09-06T13:00:00Z" },
        ],
        calls,
      }),
      {
        schedule: (run) => {
          queued.push(run)
          return 1 as unknown as ReturnType<typeof setTimeout>
        },
      },
    )
    controller.start()
    await Promise.resolve()
    await Promise.resolve()
    expect(controller.state.phase).toBe("restarting")
    expect(queued).toHaveLength(1)
    queued.shift()?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(controller.state.phase).toBe("succeeded")
    expect(controller.state.version).toBe("2.0.76")
    expect(controller.state.available).toBeUndefined()
    expect(queued).toHaveLength(0)
  })

  test("shares the explicit download then restart lifecycle without claiming early installation", async () => {
    const calls: string[] = []
    const queued: Array<() => void> = []
    const controller = createUpdateController(
      platform({ states: [{ phase: "ready", version: "2.0.54", migration_required: true }], calls }),
      {
        schedule: ((run) => {
          queued.push(run)
          return queued.length as unknown as ReturnType<typeof setTimeout>
        }) as (run: () => void, delay: number) => ReturnType<typeof setTimeout>,
      },
    )

    await controller.check()
    expect(controller.state.available).toBe("2.0.54")
    await controller.stage()
    expect(controller.state.phase).toBe("downloading")
    expect(queued).toHaveLength(1)

    queued.shift()?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(controller.state.phase).toBe("ready")
    expect(controller.state.transferred).toBeUndefined()
    expect(controller.state.total).toBeUndefined()
    expect(controller.state.progress).toBeUndefined()
    expect(controller.state.migration_required).toBe(true)

    await controller.apply()
    expect(controller.state.phase).toBe("restarting")
    expect(calls).toEqual(["check", "stage", "state", "apply"])
  })

  test("can discard a prepared update without restarting", async () => {
    const calls: string[] = []
    const controller = createUpdateController(platform({ states: [], calls }))
    await controller.cancel()
    expect(controller.state.phase).toBe("idle")
    expect(calls).toEqual(["cancel"])
  })

  test("leaves a failed download recoverable instead of looking indefinitely busy", async () => {
    const calls: string[] = []
    const candidate = platform({ states: [], calls })
    candidate.stageUpdate = async () => {
      calls.push("stage")
      throw new Error("publisher verification failed")
    }
    const controller = createUpdateController(candidate)

    await expect(controller.stage()).rejects.toThrow("publisher verification failed")
    expect(controller.state.phase).toBe("failed")
    expect(controller.state.error).toBe("publisher verification failed")
  })

  test("shows post-relaunch success without offering the installed version again", async () => {
    const calls: string[] = []
    const controller = createUpdateController(
      platform({ states: [{ phase: "succeeded", version: "2.0.54", completed_at: "2026-08-29T00:00:00Z" }], calls }),
    )
    await controller.check()
    expect(controller.state.available).toBe("2.0.54")

    controller.start()
    await Promise.resolve()
    await Promise.resolve()
    expect(controller.state.phase).toBe("succeeded")
    expect(controller.state.available).toBeUndefined()
  })

  test("keeps a newer release offered while a finished result is still on screen", async () => {
    const calls: string[] = []
    const candidate = platform({
      states: [{ phase: "succeeded", version: "2.0.126", completed_at: "2026-09-20T09:44:55.838Z" }],
      calls,
    })
    candidate.checkUpdate = async () => {
      calls.push("check")
      return { updateAvailable: true, version: "2.0.127" }
    }
    const controller = createUpdateController(candidate)

    await controller.check()
    expect(controller.state.available).toBe("2.0.127")

    controller.start()
    await flush()
    expect(controller.state.phase).toBe("succeeded")
    expect(controller.state.version).toBe("2.0.126")
    expect(controller.state.available).toBe("2.0.127")
    expect(offeredUpdate(controller.state)).toBe("2.0.127")
  })

  test("a newer release outranks a finished or absent update, never an active one", () => {
    expect(offeredUpdate({ phase: "succeeded", available: "2.0.127" })).toBe("2.0.127")
    expect(offeredUpdate({ phase: "idle", available: "2.0.127" })).toBe("2.0.127")
    expect(offeredUpdate({ phase: "succeeded" })).toBeUndefined()
    expect(offeredUpdate({ phase: "downloading", available: "2.0.127" })).toBeUndefined()
    expect(offeredUpdate({ phase: "ready", available: "2.0.127" })).toBeUndefined()
    expect(offeredUpdate({ phase: "failed", available: "2.0.127" })).toBeUndefined()
  })

  test("one press downloads, follows the staging and restarts once it is verified", async () => {
    const calls: string[] = []
    const queued: Array<() => void> = []
    const candidate = platform({
      states: [
        { phase: "verifying", version: "2.0.54" },
        { phase: "ready", version: "2.0.54" },
      ],
      calls,
    })
    const controller = createUpdateController(candidate, {
      schedule: (run) => {
        queued.push(run)
        return queued.length as unknown as ReturnType<typeof setTimeout>
      },
    })
    let restarts = 0
    const restart = async () => {
      restarts++
      await controller.apply()
    }

    await controller.downloadAndRestart(restart)
    expect(controller.state.phase).toBe("downloading")
    expect(restarts).toBe(0)

    queued.shift()?.()
    await flush()
    expect(controller.state.phase).toBe("verifying")
    expect(restarts).toBe(0)

    queued.shift()?.()
    await flush()
    expect(restarts).toBe(1)
    expect(controller.state.phase).toBe("restarting")
    expect(calls).toEqual(["stage", "state", "state", "apply"])
  })

  test("restarts straight away when the update is already verified", async () => {
    const calls: string[] = []
    const controller = createUpdateController(platform({ states: [{ phase: "ready", version: "2.0.54" }], calls }))
    controller.start()
    await flush()
    expect(controller.state.phase).toBe("ready")

    let restarts = 0
    await controller.downloadAndRestart(async () => {
      restarts++
      await controller.apply()
    })
    expect(restarts).toBe(1)
    expect(calls).toEqual(["state", "apply"])
  })

  test("a cancelled download never restarts on its own afterwards", async () => {
    const calls: string[] = []
    const queued: Array<() => void> = []
    const candidate = platform({ states: [{ phase: "ready", version: "2.0.54" }], calls })
    const controller = createUpdateController(candidate, {
      schedule: (run) => {
        queued.push(run)
        return queued.length as unknown as ReturnType<typeof setTimeout>
      },
    })
    let restarts = 0

    await controller.downloadAndRestart(async () => {
      restarts++
    })
    expect(controller.state.phase).toBe("downloading")
    await controller.cancel()
    expect(controller.state.phase).toBe("idle")

    controller.start()
    await flush()
    expect(controller.state.phase).toBe("ready")
    expect(restarts).toBe(0)
  })

  test("a failed download reports the failure instead of restarting", async () => {
    const calls: string[] = []
    const candidate = platform({ states: [{ phase: "ready", version: "2.0.54" }], calls })
    candidate.stageUpdate = async () => {
      calls.push("stage")
      throw new Error("publisher verification failed")
    }
    const controller = createUpdateController(candidate)
    let restarts = 0

    await expect(controller.downloadAndRestart(async () => void restarts++)).rejects.toThrow(
      "publisher verification failed",
    )
    expect(controller.state.phase).toBe("failed")

    controller.start()
    await flush()
    expect(controller.state.phase).toBe("ready")
    expect(restarts).toBe(0)
  })

  test("coalesces banner and Settings state reads", async () => {
    const calls: string[] = []
    const controller = createUpdateController(platform({ states: [{ phase: "idle" }], calls }))
    controller.start()
    controller.start()
    await Promise.resolve()
    await Promise.resolve()
    expect(calls).toEqual(["state"])
  })

  test("does not let a pending check consume restart and still coalesces duplicate actions", async () => {
    const calls: string[] = []
    let finishCheck!: () => void
    let finishApply!: () => void
    const candidate = platform({ states: [], calls })
    candidate.checkUpdate = () => {
      calls.push("check")
      return new Promise((resolve) => {
        finishCheck = () => resolve({ updateAvailable: true, version: "2.0.54" })
      })
    }
    candidate.applyUpdate = () => {
      calls.push("apply")
      return new Promise((resolve) => {
        finishApply = () => resolve({ phase: "restarting", version: "2.0.54" })
      })
    }
    const controller = createUpdateController(candidate)

    const checking = controller.check()
    await Promise.resolve()
    const applying = controller.apply()
    const duplicate = controller.apply()
    expect(calls).toEqual(["check", "apply"])
    expect(duplicate).toBe(applying)

    finishApply()
    await applying
    expect(controller.state.phase).toBe("restarting")
    finishCheck()
    await checking
    expect(calls).toEqual(["check", "apply"])
  })

  test("optimistically locks restart and rejects a concurrent discard", async () => {
    const calls: string[] = []
    let finishApply!: () => void
    const candidate = platform({ states: [], calls })
    candidate.applyUpdate = () => {
      calls.push("apply")
      return new Promise((resolve) => {
        finishApply = () => resolve({ phase: "restarting", version: "2.0.54" })
      })
    }
    const controller = createUpdateController(candidate)

    const applying = controller.apply()
    expect(controller.state.phase).toBe("restarting")
    await expect(controller.cancel()).rejects.toThrow("already restarting")
    expect(calls).toEqual(["apply"])

    finishApply()
    await applying
    expect(controller.state.phase).toBe("restarting")
  })

  test("keeps half-second reads for twenty polls, then backs off to a thirty-second ceiling", async () => {
    const delays: number[] = []
    const queued: Array<() => void> = []
    const states: DesktopUpdateState[] = Array.from({ length: 40 }, () => ({ phase: "downloading", version: "2.0.54" }))
    const controller = createUpdateController(platform({ states, calls: [] }), {
      schedule: (run, delay) => {
        delays.push(delay)
        queued.push(run)
        return delays.length as unknown as ReturnType<typeof setTimeout>
      },
    })
    controller.start()
    await flush()
    for (let i = 0; i < 27; i++) {
      queued.shift()?.()
      await flush()
    }
    expect(controller.state.phase).toBe("downloading")
    expect(delays.slice(0, 20)).toEqual(Array.from({ length: 20 }, () => 500))
    expect(delays.slice(20, 28)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
    expect(pollDelay(0)).toBe(500)
    expect(pollDelay(19)).toBe(500)
    expect(pollDelay(20)).toBe(1000)
    expect(pollDelay(60)).toBe(30000)

    // A user action means the supervisor is expected to move again soon.
    await controller.stage()
    expect(delays.at(-1)).toBe(500)
  })

  test("stops polling a blocked restart until the user acts", async () => {
    const calls: string[] = []
    const queued: Array<() => void> = []
    const candidate = platform({
      states: [{ phase: "restart_blocked", version: "2.0.54", error: "Close the running installer first" }],
      calls,
    })
    const controller = createUpdateController(candidate, {
      schedule: (run) => {
        queued.push(run)
        return queued.length as unknown as ReturnType<typeof setTimeout>
      },
    })
    controller.start()
    await flush()
    expect(controller.state.phase).toBe("restart_blocked")
    expect(controller.state.error).toBe("Close the running installer first")
    expect(queued).toHaveLength(0)

    await controller.apply()
    expect(controller.state.phase).toBe("restarting")
    expect(queued).toHaveLength(1)
    expect(calls).toEqual(["state", "apply"])
  })

  test("formats progress with compact tabular-friendly values", () => {
    expect(formatUpdateBytes(1_500_000)).toBe("1.4 MiB")
    expect(formatUpdateBytes(512)).toBe("512 B")
    expect(formatUpdateBytes(undefined)).toBe("")
  })
})

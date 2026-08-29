import { describe, expect, test } from "bun:test"
import type { DesktopUpdateState, Platform } from "@/context/platform"
import { createUpdateController, formatUpdateBytes } from "./update-controller"

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

  test("formats progress with compact tabular-friendly values", () => {
    expect(formatUpdateBytes(1_500_000)).toBe("1.4 MiB")
    expect(formatUpdateBytes(512)).toBe("512 B")
    expect(formatUpdateBytes(undefined)).toBe("")
  })
})

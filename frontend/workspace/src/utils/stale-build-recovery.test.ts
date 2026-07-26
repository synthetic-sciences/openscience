import { describe, expect, test } from "bun:test"
import { installStaleBuildRecovery } from "./stale-build-recovery"

function memoryStorage(): Pick<Storage, "getItem" | "setItem"> {
  const values = new Map<string, string>()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  }
}

function preloadError() {
  return new Event("vite:preloadError", { cancelable: true })
}

describe("installStaleBuildRecovery", () => {
  test("reloads once when a deployed lazy chunk is stale", () => {
    const target = new EventTarget()
    const storage = memoryStorage()
    let reloads = 0

    installStaleBuildRecovery({
      target,
      storage,
      reload: () => reloads++,
      now: () => 1_000,
    })

    const event = preloadError()
    target.dispatchEvent(event)

    expect(event.defaultPrevented).toBe(true)
    expect(reloads).toBe(1)
  })

  test("lets a repeated failure reach the error boundary instead of reloading forever", () => {
    const storage = memoryStorage()
    let reloads = 0

    const firstTarget = new EventTarget()
    const cleanup = installStaleBuildRecovery({
      target: firstTarget,
      storage,
      reload: () => reloads++,
      now: () => 1_000,
    })
    firstTarget.dispatchEvent(preloadError())
    cleanup()

    const reloadedTarget = new EventTarget()
    installStaleBuildRecovery({
      target: reloadedTarget,
      storage,
      reload: () => reloads++,
      now: () => 1_001,
    })

    const repeatedError = preloadError()
    reloadedTarget.dispatchEvent(repeatedError)

    expect(repeatedError.defaultPrevented).toBe(false)
    expect(reloads).toBe(1)
  })

  test("allows another recovery after the cooldown", () => {
    const target = new EventTarget()
    const storage = memoryStorage()
    let reloads = 0
    let now = 1_000

    installStaleBuildRecovery({
      target,
      storage,
      reload: () => reloads++,
      now: () => now,
      cooldownMs: 30_000,
    })

    target.dispatchEvent(preloadError())
    now += 30_000
    const laterError = preloadError()
    target.dispatchEvent(laterError)

    expect(laterError.defaultPrevented).toBe(true)
    expect(reloads).toBe(2)
  })

  test("does not reload when the durable loop guard is unavailable", () => {
    const blockedStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage blocked")
      },
    }

    for (const storage of [null, blockedStorage]) {
      const target = new EventTarget()
      let reloads = 0
      installStaleBuildRecovery({ target, storage, reload: () => reloads++ })

      const event = preloadError()
      target.dispatchEvent(event)

      expect(event.defaultPrevented).toBe(false)
      expect(reloads).toBe(0)
    }
  })
})

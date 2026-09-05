import { describe, expect, test } from "bun:test"
import { outputWatchdog } from "../../src/session/output-watchdog"

function fixture(timeout: number | false = 60) {
  const user = new AbortController()
  const transport = new AbortController()
  const error = new Error("No useful model output")
  const watchdog = outputWatchdog({
    timeout,
    signal: user.signal,
    expire: () => error,
    onTimeout: (reason) => transport.abort(reason),
  })
  watchdog.start()
  return { watchdog, user, transport, error }
}

describe("useful model output watchdog", () => {
  test("metadata events do not reset the cumulative waiting budget", async () => {
    const { watchdog, transport, error } = fixture()
    try {
      const events = (async () => {
        for (let index = 0; index < 100; index++) await watchdog.next(() => Bun.sleep(10))
      })()
      await expect(events).rejects.toBe(error)
      expect(transport.signal.reason).toBe(error)
    } finally {
      watchdog.dispose()
    }
  })

  test("real output allows a generation longer than the inactivity deadline", async () => {
    const { watchdog, transport } = fixture()
    try {
      for (let index = 0; index < 8; index++) {
        await watchdog.next(() => Bun.sleep(15))
        watchdog.progress()
      }
      expect(transport.signal.aborted).toBe(false)
    } finally {
      watchdog.dispose()
    }
  })

  test("local tool/permission waits do not consume the model deadline", async () => {
    const { watchdog, transport, error } = fixture()
    try {
      const pending = watchdog.next(() => Bun.sleep(180))
      watchdog.pause(true)
      await pending
      expect(transport.signal.aborted).toBe(false)
      watchdog.pause(false)
      await expect(watchdog.next(() => new Promise(() => {}))).rejects.toBe(error)
    } finally {
      watchdog.dispose()
    }
  })

  test("local event processing is excluded without resetting metadata-only budget", async () => {
    const { watchdog, transport } = fixture()
    try {
      await watchdog.next(() => Bun.sleep(10))
      await Bun.sleep(120)
      await watchdog.next(() => Bun.sleep(10))
      expect(transport.signal.aborted).toBe(false)
    } finally {
      watchdog.dispose()
    }
  })

  test("manual cancellation stays immediate even when deadlines are explicitly disabled", async () => {
    const { watchdog, user, transport } = fixture(false)
    try {
      const pending = watchdog.next(() => new Promise(() => {}))
      user.abort(new DOMException("User stopped", "AbortError"))
      await expect(pending).rejects.toThrow("User stopped")
      expect(transport.signal.aborted).toBe(false)
    } finally {
      watchdog.dispose()
    }
  })
})

import { expect, test } from "bun:test"
import { createListeners } from "./listeners"

// createListeners backs global-sync's `onProvidersRefreshed`, which is how the
// Settings mode toggle learns that adding an own OpenRouter key flipped
// billing.llm managed → byok server-side. The two properties that fix depends
// on are ordering (notify strictly after the refresh, or the re-read races the
// write it is reacting to) and notify-on-failure (the flip already happened, so
// a failed catalog reload must not leave the toggle stale). Exercised with
// plain async functions standing in for refreshProviders — no DOM, no mocks.

// A macrotask hop the body must cross before it is "done". A body with no
// internal await runs synchronously the instant it is called, so it could not
// tell a real `await body()` apart from a dropped one.
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))

test("notifies every subscriber only after the body has finished", async () => {
  const listeners = createListeners()
  const order: string[] = []
  listeners.add(() => order.push("first"))
  listeners.add(() => order.push("second"))

  await listeners.notifyAfter(async () => {
    await tick()
    order.push("body")
  })

  expect(order).toEqual(["body", "first", "second"])
})

test("notifies subscribers even when the body rejects, and still surfaces the rejection", async () => {
  const listeners = createListeners()
  let notified = 0
  listeners.add(() => notified++)

  const rejection = listeners.notifyAfter(async () => {
    await tick()
    throw new Error("catalog unreachable")
  })

  await expect(rejection).rejects.toThrow("catalog unreachable")
  expect(notified).toBe(1)
})

test("the unsubscribe returned by add stops further notifications", async () => {
  const listeners = createListeners()
  let kept = 0
  let dropped = 0
  listeners.add(() => kept++)
  const unsubscribe = listeners.add(() => dropped++)

  await listeners.notifyAfter(async () => {})
  unsubscribe()
  await listeners.notifyAfter(async () => {})

  expect(kept).toBe(2)
  expect(dropped).toBe(1)
})

test("a subscriber that unsubscribes itself during notify does not disturb the others", async () => {
  const listeners = createListeners()
  const seen: string[] = []
  const unsubscribe = listeners.add(() => {
    seen.push("self-removing")
    unsubscribe()
  })
  listeners.add(() => seen.push("other"))

  await listeners.notifyAfter(async () => {})
  await listeners.notifyAfter(async () => {})

  expect(seen).toEqual(["self-removing", "other", "other"])
})

test("a subscriber that throws does not fail the batch or the caller", async () => {
  const listeners = createListeners()
  const seen: string[] = []
  listeners.add(() => {
    seen.push("first")
    throw new Error("subscriber blew up")
  })
  listeners.add(() => seen.push("second"))

  // A throw out of the finally would replace the body's outcome with its own,
  // handing the settings panels a rejection for a credential that did save.
  await expect(listeners.notifyAfter(async () => {})).resolves.toBeUndefined()
  expect(seen).toEqual(["first", "second"])
})

test("a throwing subscriber does not mask the body's own rejection", async () => {
  const listeners = createListeners()
  let notified = 0
  listeners.add(() => {
    throw new Error("subscriber blew up")
  })
  listeners.add(() => notified++)

  const rejection = listeners.notifyAfter(async () => {
    throw new Error("catalog unreachable")
  })

  await expect(rejection).rejects.toThrow("catalog unreachable")
  expect(notified).toBe(1)
})

import { expect, test } from "bun:test"
import { CredentialLifecycle } from "../../src/credentials/lifecycle"

test("an admitted SDK callback can re-enter and serialize sibling credential writes", async () => {
  let active = 0
  let maximum = 0
  const write = (label: string) =>
    CredentialLifecycle.serialized(async () => {
      active++
      maximum = Math.max(maximum, active)
      await Bun.sleep(15)
      active--
      return label
    })

  const result = await CredentialLifecycle.admit(() =>
    CredentialLifecycle.admit(() => Promise.all([write("first"), write("second"), write("third")])),
  )

  expect(result).toEqual(["first", "second", "third"])
  expect(maximum).toBe(1)
})

test("an unawaited descendant cannot retain a disposed credential lease", async () => {
  const timerReady = Promise.withResolvers<void>()
  const lateDone = Promise.withResolvers<void>()
  let lateStarted = false

  await CredentialLifecycle.admit(async () => {
    setTimeout(() => {
      timerReady.resolve()
      void CredentialLifecycle.serialized(async () => {
        lateStarted = true
      }).then(lateDone.resolve, lateDone.reject)
    }, 20)
  })

  const releaseBlocker = Promise.withResolvers<void>()
  const blockerStarted = Promise.withResolvers<void>()
  const blocker = CredentialLifecycle.serialized(async () => {
    blockerStarted.resolve()
    await releaseBlocker.promise
  })
  await blockerStarted.promise
  await timerReady.promise
  await Bun.sleep(20)
  expect(lateStarted).toBe(false)

  releaseBlocker.resolve()
  await blocker
  await lateDone.promise
  expect(lateStarted).toBe(true)
})

test("a credential-checked network response does not hold the global mutation lease", async () => {
  const response = Promise.withResolvers<string>()
  const started = Promise.withResolvers<void>()
  const request = CredentialLifecycle.dispatch(
    async () => undefined,
    () => {
      started.resolve()
      return response.promise
    },
  )
  await started.promise

  const mutation = CredentialLifecycle.serialized(async () => "changed")
  await expect(mutation).resolves.toBe("changed")

  response.resolve("complete")
  await expect(request).resolves.toBe("complete")
})

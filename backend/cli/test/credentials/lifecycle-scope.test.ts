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
  const startLate = Promise.withResolvers<void>()
  const lateDone = Promise.withResolvers<void>()
  const order: string[] = []
  let lateStarted = false

  await CredentialLifecycle.admit(async () => {
    // An SDK callback can start a credential write from a continuation of the
    // admitted scope that runs long after the scope closed. This `.then`
    // inherits the admitted async context exactly as a stray timer would, but
    // the test decides when it runs: gating it on a wall clock raced the 20ms
    // delay against releasing one cross-process lease and taking another, and
    // lost that race whenever the filesystem was slow enough (CI), which then
    // stranded the blocker's lease below for the rest of the process.
    void startLate.promise.then(() =>
      CredentialLifecycle.serialized(async () => {
        lateStarted = true
        order.push("late")
      }).then(lateDone.resolve, lateDone.reject),
    )
  })

  const releaseBlocker = Promise.withResolvers<void>()
  const blockerStarted = Promise.withResolvers<void>()
  const blocker = CredentialLifecycle.serialized(async () => {
    blockerStarted.resolve()
    await releaseBlocker.promise
    order.push("blocker")
  })

  try {
    // The descendant is only released once the blocker demonstrably holds the
    // lease, so it has no lease to inherit and no way to run before the
    // blocker returns it.
    await blockerStarted.promise
    startLate.resolve()
    await Bun.sleep(20)
    expect(lateStarted).toBe(false)
  } finally {
    // A failed expectation must not leave the cross-process credential lease
    // held: every later admit, serialized write and dispatch in this process
    // would wait out the 30s mutation lease and time out with it.
    releaseBlocker.resolve()
    await blocker
  }

  await lateDone.promise
  expect(order).toEqual(["blocker", "late"])
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

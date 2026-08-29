import { expect, test } from "bun:test"
import { State } from "../../src/project/state"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

test("strict state disposal surfaces failure and preserves the disposer for a safe retry", async () => {
  const key = `strict-disposal-${crypto.randomUUID()}`
  let attempts = 0
  let completedAttempts = 0
  let failing = true
  const completed = State.create(
    () => key,
    () => ({ ready: true }),
    async () => {
      completedAttempts++
    },
  )
  const state = State.create(
    () => key,
    () => ({ ready: true }),
    async () => {
      attempts++
      if (failing) throw new Error("ledger still active")
    },
  )
  completed()
  state()

  await expect(State.dispose(key, { strict: true })).rejects.toThrow("could not be disposed")
  expect(attempts).toBe(1)
  expect(completedAttempts).toBe(1)
  failing = false
  await State.dispose(key, { strict: true })
  expect(attempts).toBe(2)
  expect(completedAttempts).toBe(1)
})

test("strict global disposal still attempts every project instance before reporting failures", async () => {
  await using first = await tmpdir()
  await using second = await tmpdir()
  const attempts: string[] = []
  let failing = true
  const runtime = Instance.state(
    () => ({ directory: Instance.directory }),
    async (value) => {
      attempts.push(value.directory)
      if (failing && value.directory === first.path) throw new Error("first project ledger busy")
    },
  )
  for (const directory of [first.path, second.path]) {
    await Instance.provide({ directory, fn: () => runtime() })
  }

  await expect(Instance.disposeAll({ strict: true })).rejects.toThrow("could not be disposed")
  expect(attempts).toContain(first.path)
  expect(attempts).toContain(second.path)

  failing = false
  await Instance.disposeAll({ strict: true })
  expect(attempts.filter((directory) => directory === first.path)).toHaveLength(2)
  expect(attempts.filter((directory) => directory === second.path)).toHaveLength(1)
})

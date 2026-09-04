import { expect, test } from "bun:test"
import { InstanceBootstrap, InstanceWarmup, WARMUP_DELAY_MS } from "../../src/project/bootstrap"
import { Instance } from "../../src/project/instance"
import { State } from "../../src/project/state"
import { tmpdir } from "../fixture/fixture"

test("bootstrap leaves the watcher, file index, LSP and VCS runtimes to the deferred warmup", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    init: InstanceBootstrap,
    fn: async () => {
      expect(InstanceWarmup.pending()).toBe(true)
      const eager = State.size(Instance.directory)

      await InstanceWarmup.flush()

      expect(InstanceWarmup.pending()).toBe(false)
      // LSP, file watcher, file index and VCS each register their runtime
      // only once the warmup runs; none of them were part of the bootstrap.
      expect(State.size(Instance.directory) - eager).toBeGreaterThanOrEqual(4)
    },
  })
  await Instance.provide({ directory: tmp.path, fn: () => Instance.dispose() })
})

test("flushing twice runs the deferred warmup once", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    init: InstanceBootstrap,
    fn: async () => {
      await InstanceWarmup.flush()
      const warmed = State.size(Instance.directory)
      await InstanceWarmup.flush()
      expect(State.size(Instance.directory)).toBe(warmed)
    },
  })
  await Instance.provide({ directory: tmp.path, fn: () => Instance.dispose() })
})

test("disposing an instance cancels a warmup that has not started", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    init: InstanceBootstrap,
    fn: async () => {
      expect(InstanceWarmup.pending()).toBe(true)
      await Instance.dispose()
    },
  })
  await Bun.sleep(WARMUP_DELAY_MS + 250)
  // A cancelled warmup must not resurrect the released project's runtimes.
  expect(State.size(tmp.path)).toBe(0)
})

test("a bootstrap that fails after scheduling its warmup cannot mint a bare instance", async () => {
  await using tmp = await tmpdir()
  const failure = new Error("bootstrap failed")
  await expect(
    Instance.provide({
      directory: tmp.path,
      init: async () => {
        await InstanceBootstrap()
        throw failure
      },
      fn: async () => {},
    }),
  ).rejects.toBe(failure)
  // Runtimes the bootstrap registered before it failed stay behind; let the
  // ones that finish registering asynchronously settle before the timer fires.
  await Bun.sleep(WARMUP_DELAY_MS / 2)
  const leaked = State.size(tmp.path)
  await Bun.sleep(WARMUP_DELAY_MS)
  // The timer found no instance to warm and minted nothing.
  expect(Instance.has(tmp.path)).toBe(false)
  expect(State.size(tmp.path)).toBe(leaked)

  // The next request for the directory runs its own bootstrap rather than
  // landing on an instance that skipped InstanceBootstrap.
  const init = { ran: false }
  await Instance.provide({
    directory: tmp.path,
    init: async () => {
      init.ran = true
    },
    fn: () => Instance.dispose(),
  })
  expect(init.ran).toBe(true)
})

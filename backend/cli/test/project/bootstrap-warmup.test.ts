import { expect, test } from "bun:test"
import { InstanceBootstrap, InstanceWarmup, WARMUP_DELAY_MS } from "../../src/project/bootstrap"
import { AuthoritySignal } from "../../src/project/authority-signal"
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

/** InstanceBootstrap, then a failure after its warmup is scheduled. */
async function failingBootstrap(directory: string) {
  const failure = new Error("bootstrap failed")
  const scheduled = { pending: false }
  await expect(
    Instance.provide({
      directory,
      init: async () => {
        await InstanceBootstrap()
        scheduled.pending = InstanceWarmup.pending()
        throw failure
      },
      fn: async () => {},
    }),
  ).rejects.toBe(failure)
  expect(scheduled.pending).toBe(true)
}

test("a bootstrap that fails after scheduling its warmup tears the warmup down with its other runtimes", async () => {
  await using tmp = await tmpdir()
  await failingBootstrap(tmp.path)
  // By the time the caller sees the failure, every runtime the bootstrap
  // registered is disposed, the warmup timer and the authority poller among
  // them: nothing is left that could provide the directory and mint a bare
  // instance, and nothing remains to dispose.
  expect(Instance.has(tmp.path)).toBe(false)
  expect(State.size(tmp.path)).toBe(0)

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

test("an unsettled authority change cannot resurrect a project whose bootstrap failed", async () => {
  await using tmp = await tmpdir()
  // An authority record another process published and no watcher settled
  // yet. A poller that survived the failed bootstrap would apply it through
  // Instance.provide and mint a bare instance, which the warmup timer would
  // then go on to warm.
  const signal = await AuthoritySignal.publish({ kind: "trust", projectID: "prj_elsewhere", denied: true })
  try {
    await failingBootstrap(tmp.path)
    expect(Instance.has(tmp.path)).toBe(false)
    // Several poll intervals plus the warmup delay: a longer wait can only
    // expose a survivor, never fail a clean teardown.
    await Bun.sleep(WARMUP_DELAY_MS + 250)
    expect(Instance.has(tmp.path)).toBe(false)
    expect(State.size(tmp.path)).toBe(0)
  } finally {
    await AuthoritySignal.settle(signal.revision)
  }
})

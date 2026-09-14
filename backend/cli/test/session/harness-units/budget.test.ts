import { afterEach, expect, test } from "bun:test"
import path from "path"
import type { PluginInput } from "@synsci/plugin"
import { Budget, BudgetUnit } from "../../../src/harness/budget"
import { HarnessState } from "../../../src/harness/state"
import { tmpdir } from "../../fixture/fixture"

afterEach(() => HarnessState.reset())

test("compute limits come from the cgroup when present", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "cpu.max"), "200000 100000\n")
  await Bun.write(path.join(tmp.path, "memory.max"), String(8 * 1024 ** 3))
  expect(await Budget.compute(tmp.path)).toEqual({ cpus: 2, gib: 8 })
  await Bun.write(path.join(tmp.path, "cpu.max"), "max 100000\n")
  await Bun.write(path.join(tmp.path, "memory.max"), "max")
  const host = await Budget.compute(tmp.path)
  expect(host.cpus).toBeGreaterThan(0)
  expect(host.gib).toBeGreaterThan(0)
})

test("compute is a stable env line; elapsed time and the 50%/85% reminders are per-step status", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "cpu.max"), "400000 100000")
  await Bun.write(path.join(tmp.path, "memory.max"), String(16 * 1024 ** 3))
  HarnessState.cgroup.root = tmp.path
  let now = 1_000_000
  HarnessState.clock.now = () => now
  const unit = await BudgetUnit({} as PluginInput)
  await unit["chat.message"]!(
    { sessionID: "ses_b", messageID: "msg_1" },
    { message: { time: { created: now }, deadline: now + 60 * 60_000 } as never, parts: [] },
  )
  const render = async () => {
    const output = { lines: [] as string[], status: [] as string[] }
    await unit["env.lines"]!({ sessionID: "ses_b", model: {} as never }, output)
    return output
  }
  const first = await render()
  // The system prompt is the provider's cache prefix: only what never changes
  // during the session may go there.
  expect(first.lines).toEqual(["Compute: 4 CPUs, 16 GiB"])
  expect(first.status).toEqual(["Time budget: 1h, elapsed 0m"])
  now += 31 * 60_000
  const half = await render()
  expect(half.lines).toEqual(["Compute: 4 CPUs, 16 GiB"])
  expect(half.status[0]).toBe("Time budget: 1h, elapsed 31m")
  expect(half.status[1]).toContain("half the budget")
  expect((await render()).status.some((line) => line.includes("half the budget"))).toBe(false)
  now += 22 * 60_000
  const late = await render()
  expect(late.status[1]).toContain("85% of the budget")
  expect((await render()).status).toHaveLength(1)
})

test("a finished turn with failing deliverables and time left is asked to continue, once", async () => {
  let now = 5_000_000
  HarnessState.clock.now = () => now
  const unit = await BudgetUnit({} as PluginInput)
  await unit["chat.message"]!(
    { sessionID: "ses_c", messageID: "msg_1" },
    { message: { time: { created: now }, deadline: now + 100 * 60_000 } as never, parts: [] },
  )
  const state = HarnessState.get("ses_c")
  const finish = async () => {
    const output = { message: undefined as string | undefined }
    await unit["loop.before_finish"]!({ sessionID: "ses_c", messageID: "msg_a", turn: "msg_1", injections: 0 }, output)
    return output.message
  }
  // Nothing to say while the deliverables check has not failed.
  expect(await finish()).toBeUndefined()
  state.deliverablesFailing = true
  expect(await finish()).toContain("Time remains")
  expect(await finish()).toBeUndefined()
  // Past 85% of the budget the nudge never fires.
  const other = await BudgetUnit({} as PluginInput)
  await other["chat.message"]!(
    { sessionID: "ses_d", messageID: "msg_1" },
    { message: { time: { created: now }, deadline: now + 100 * 60_000 } as never, parts: [] },
  )
  HarnessState.get("ses_d").deliverablesFailing = true
  now += 90 * 60_000
  const output = { message: undefined as string | undefined }
  await other["loop.before_finish"]!({ sessionID: "ses_d", messageID: "msg_a", turn: "msg_1", injections: 0 }, output)
  expect(output.message).toBeUndefined()
})

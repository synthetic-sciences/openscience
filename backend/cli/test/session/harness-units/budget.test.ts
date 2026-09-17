import { afterEach, expect, test } from "bun:test"
import path from "path"
import type { PluginInput } from "@synsci/plugin"
import { Budget, BudgetUnit } from "../../../src/harness/budget"
import { HarnessState } from "../../../src/harness/state"
import { SessionLoopState } from "../../../src/session/loop-state"
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

test("compute is a stable env line; the 50%/85% reminders fire once each and carry the figures", async () => {
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "cpu.max"), "400000 100000")
  await Bun.write(path.join(tmp.path, "memory.max"), String(16 * 1024 ** 3))
  HarnessState.cgroup.root = tmp.path
  let now = 1_000_000
  HarnessState.clock.now = () => now
  const unit = await BudgetUnit({} as PluginInput)
  await unit["chat.message"]!(
    { sessionID: "ses_b", messageID: "msg_1" },
    {
      message: {
        id: "msg_1",
        role: "user",
        time: { created: now },
        deadline: now + 60 * 60_000,
        internal: SessionLoopState.prompt("msg_1"),
      } as never,
      parts: [],
    },
  )
  const render = async () => {
    const output = { lines: [] as string[], status: [] as string[] }
    await unit["env.lines"]!({ sessionID: "ses_b", model: {} as never }, output)
    return output
  }
  const first = await render()
  // The system prompt is the provider's cache prefix: only what never changes
  // during the session may go there. Nothing rides along every step either;
  // a status line is appended to the transcript only when it changes, so a
  // running "elapsed" figure would be a new message every step.
  expect(first.lines).toEqual(["Compute: 4 CPUs, 16 GiB", "Time budget: 1h"])
  expect(first.status).toEqual([])
  now += 31 * 60_000
  const half = await render()
  expect(half.lines).toEqual(["Compute: 4 CPUs, 16 GiB", "Time budget: 1h"])
  expect(half.status).toHaveLength(1)
  expect(half.status[0]).toContain("31m of the 1h time budget is used (half)")
  expect((await render()).status).toEqual([])
  now += 22 * 60_000
  const late = await render()
  expect(late.status).toHaveLength(1)
  expect(late.status[0]).toContain("53m of the 1h time budget is used (85%)")
  expect((await render()).status).toEqual([])
})

test("an initial 85% reminder consumes the obsolete half-time threshold", () => {
  const state = HarnessState.get("ses_late")
  state.startedAt = 1_000
  state.deadline = 11_000

  expect(Budget.status(state, 9_500)[0]).toContain("(85%)")
  expect(Budget.status(state, 9_501)).toEqual([])
  expect(state.budgetReminders).toEqual(new Set([50, 85]))
})

test("timed external prompts reset their matching start while untimed and synthetic follow-ups preserve it", async () => {
  const unit = await BudgetUnit({} as PluginInput)
  const send = async (message: Record<string, unknown>, parts: unknown[] = []) =>
    unit["chat.message"]!(
      { sessionID: "ses_turns", messageID: message.id as string },
      { message: message as never, parts: parts as never },
    )

  await send({
    id: "msg_1",
    role: "user",
    time: { created: 1_000 },
    deadline: 11_000,
    internal: SessionLoopState.prompt("msg_1"),
  })
  expect(HarnessState.get("ses_turns")).toMatchObject({ startedAt: 1_000, deadline: 11_000 })

  await send({
    id: "msg_2",
    role: "user",
    time: { created: 20_000 },
    deadline: 50_000,
    internal: SessionLoopState.prompt("msg_2"),
  })
  expect(HarnessState.get("ses_turns")).toMatchObject({ startedAt: 20_000, deadline: 50_000 })

  await send(
    { id: "msg_3", role: "user", time: { created: 30_000 } },
    [{ type: "text", text: "untimed follow-up" }],
  )
  expect(HarnessState.get("ses_turns")).toMatchObject({ startedAt: 20_000, deadline: 50_000 })

  await send(
    {
      id: "msg_4",
      role: "user",
      time: { created: 40_000 },
      deadline: 90_000,
      internal: SessionLoopState.intent({
        kind: "harness",
        text: "Continue.",
        epoch: "msg_2",
        transaction: "msg_4",
      }),
    },
    [{ type: "text", text: "Continue.", synthetic: true }],
  )
  expect(HarnessState.get("ses_turns")).toMatchObject({ startedAt: 20_000, deadline: 50_000 })
})

test("each timed external prompt gets fresh reminders and a fresh nudge", async () => {
  let now = 1_000
  HarnessState.clock.now = () => now
  const unit = await BudgetUnit({} as PluginInput)
  const send = (id: string) =>
    unit["chat.message"]!(
      { sessionID: "ses_repeat", messageID: id },
      {
        message: {
          id,
          role: "user",
          time: { created: now },
          deadline: now + 100_000,
          internal: SessionLoopState.prompt(id),
        } as never,
        parts: [],
      },
    )
  const remind = async () => {
    const output = { lines: [] as string[], status: [] as string[] }
    await unit["env.lines"]!({ sessionID: "ses_repeat", model: {} as never }, output)
    return output.status
  }
  const nudge = async () => {
    const output = { message: undefined as string | undefined }
    await unit["loop.before_finish"]!(
      { sessionID: "ses_repeat", messageID: "msg_finish", turn: "msg_1", injections: 0 },
      output,
    )
    return output.message
  }

  await send("msg_1")
  const state = HarnessState.get("ses_repeat")
  state.deliverablesFailing = true
  now += 50_000
  expect(await remind()).toHaveLength(1)
  expect(await nudge()).toContain("Time remains")

  now += 50_000
  await send("msg_2")
  now += 50_000
  expect(await remind()).toHaveLength(1)
  expect(await nudge()).toContain("Time remains")
})

test("a finished turn with failing deliverables and time left is asked to continue, once", async () => {
  let now = 5_000_000
  HarnessState.clock.now = () => now
  const unit = await BudgetUnit({} as PluginInput)
  await unit["chat.message"]!(
    { sessionID: "ses_c", messageID: "msg_1" },
    {
      message: {
        id: "msg_1",
        role: "user",
        time: { created: now },
        deadline: now + 100 * 60_000,
        internal: SessionLoopState.prompt("msg_1"),
      } as never,
      parts: [],
    },
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
    {
      message: {
        id: "msg_1",
        role: "user",
        time: { created: now },
        deadline: now + 100 * 60_000,
        internal: SessionLoopState.prompt("msg_1"),
      } as never,
      parts: [],
    },
  )
  HarnessState.get("ses_d").deliverablesFailing = true
  now += 90 * 60_000
  const output = { message: undefined as string | undefined }
  await other["loop.before_finish"]!({ sessionID: "ses_d", messageID: "msg_a", turn: "msg_1", injections: 0 }, output)
  expect(output.message).toBeUndefined()
})

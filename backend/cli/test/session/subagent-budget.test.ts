import { describe, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { SubagentBudget } from "../../src/session/subagent-budget"

const input = (sessionID: string, allocation = 100) => ({
  rootSessionID: "root",
  parentSessionID: "root",
  sessionID,
  assignmentID: `assignment-${sessionID}`,
  objective: "Compare sources",
  expectedOutput: "Findings and limitations",
  model: { providerID: "test", modelID: "model" },
  route: "chatgpt" as const,
  unit: "tokens" as const,
  allocation,
  settings: { tokens: 200 },
})

describe("bounded subagent ledger", () => {
  test("atomically reserves shared allocations, excluding main calls", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const results = await Promise.allSettled([
          SubagentBudget.open(input("a", 150)),
          SubagentBudget.open(input("b", 150)),
        ])
        expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1)
        expect(await SubagentBudget.read("root")).toBeUndefined()
        expect((await SubagentBudget.inspect("root"))?.limits.tokens).toBe(200)
      },
    })
  })
  test("counts every call once and keeps uncertain reservations", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await SubagentBudget.open(input("a"))
        await SubagentBudget.reserve("a", "call1", 60)
        await expect(SubagentBudget.reserve("a", "call2", 60)).rejects.toThrow(/limit/i)
        await SubagentBudget.settle("a", "call1", 40)
        await SubagentBudget.settle("a", "call1", 40)
        expect((await SubagentBudget.read("a"))?.worker.spent).toBe(40)
        await SubagentBudget.reserve("a", "call2", 60)
        await SubagentBudget.settle("a", "call2")
        await SubagentBudget.release("a")
        expect((await SubagentBudget.read("a"))?.worker.calls.call2.state).toBe("pending")
      },
    })
  })
  test("returns unused allocation and reacquires it without resetting consumption", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await SubagentBudget.open(input("a"))
        await SubagentBudget.reserve("a", "call", 40)
        await SubagentBudget.settle("a", "call", 40)
        await SubagentBudget.release("a")
        await SubagentBudget.open(input("b", 160))
        await expect(SubagentBudget.open({ ...input("a"), assignmentID: "follow-up" })).rejects.toThrow(/limit/i)
        expect((await SubagentBudget.read("a"))?.worker.spent).toBe(40)
      },
    })
  })
  test("nested allocations remain inside ancestor limits without double reserving", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await SubagentBudget.open(input("a", 150))
        await SubagentBudget.open({ ...input("b", 100), parentSessionID: "a" })
        await SubagentBudget.reserve("b", "child", 80)
        await expect(SubagentBudget.reserve("a", "parent", 80)).rejects.toThrow(/limit/i)
        await SubagentBudget.open(input("c", 50))
        await SubagentBudget.settle("b", "child", 70)
        expect((await SubagentBudget.read("b"))?.worker.spent).toBe(70)
      },
    })
  })
  test("requires revisioned idempotent user increases, not changed defaults", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await SubagentBudget.open(input("a"))
        const pool = (await SubagentBudget.inspect("root"))!
        const approval = { unit: "tokens" as const, amount: 100, revision: pool.revision, key: "user-approval" }
        const first = await SubagentBudget.increase("root", approval)
        const replay = await SubagentBudget.increase("root", approval)
        expect(replay).toEqual(first)
        await expect(SubagentBudget.increase("root", { ...approval, key: "other" })).rejects.toThrow(/revision/i)
        expect(first.limits.tokens).toBe(300)
        await SubagentBudget.open({ ...input("b", 100), settings: { tokens: 5000 } })
        expect((await SubagentBudget.inspect("root"))?.limits.tokens).toBe(300)
      },
    })
  })
  test("preserves source precision and rejects invalid settings", () => {
    expect(SubagentBudget.dollars("0.00000452")).toBe(4520)
    expect(SubagentBudget.usd(4520)).toBe(0.00000452)
    expect(SubagentBudget.Settings.parse({ tokens: 50 }).deadlineMs).toBe(600000)
    expect(SubagentBudget.Settings.safeParse({ usd: -1 }).success).toBe(false)
    expect(SubagentBudget.Settings.safeParse({ tokens: 1.5 }).success).toBe(false)
  })
  test("retains pending funds after release and records deadline stops", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await SubagentBudget.open(input("a", 200))
        await SubagentBudget.reserve("a", "uncertain", 150)
        await SubagentBudget.release("a")
        await expect(SubagentBudget.open(input("b", 100))).rejects.toThrow(/limit/i)
        await SubagentBudget.open({ ...input("b", 50), deadline: Date.now() - 1 })
        await expect(SubagentBudget.reserve("b", "late", 1)).rejects.toThrow(/deadline/)
        expect((await SubagentBudget.read("b"))?.worker.stopReason).toBe("deadline")
      },
    })
  })
  test("cannot move a child binding to another root pool", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await SubagentBudget.open(input("a"))
        await expect(
          SubagentBudget.open({ ...input("a"), rootSessionID: "other", parentSessionID: "other" }),
        ).rejects.toThrow(/root|parent/i)
      },
    })
  })
})

test("deleted child reports stay redacted and deleted roots cannot be recreated by late work", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await SubagentBudget.open(input("a"))
      await SubagentBudget.remove("a")
      await SubagentBudget.report("a", { handoff: "private stale text", outcome: "completed", reason: "completed" })
      expect((await SubagentBudget.read("a"))?.worker.handoff).toBeUndefined()
      await SubagentBudget.remove("root")
      await expect(SubagentBudget.open(input("late"))).rejects.toThrow(/deleted/)
      expect(await SubagentBudget.inspect("root")).toBeUndefined()
    },
  })
})

test("resuming a parent retains its background descendant allocations", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await SubagentBudget.open(input("a", 150))
      await SubagentBudget.open({ ...input("nested", 100), parentSessionID: "a" })
      await SubagentBudget.release("a")
      await SubagentBudget.open({ ...input("a", 50), assignmentID: "resume" })
      await expect(SubagentBudget.open(input("other", 150))).rejects.toThrow(/limit/)
      const pool = (await SubagentBudget.inspect("root"))!
      expect(SubagentBudget.available(pool, "tokens")).toBe(50)
    },
  })
})
test("a shared-pool overrun blocks new calls from already allocated siblings", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await SubagentBudget.open(input("a", 100))
      await SubagentBudget.open(input("b", 100))
      await SubagentBudget.reserve("a", "overrun", 100)
      await SubagentBudget.settle("a", "overrun", 300)
      await expect(SubagentBudget.reserve("b", "later", 100)).rejects.toThrow(/limit/)
      expect((await SubagentBudget.read("b"))?.worker.calls.later).toBeUndefined()
    },
  })
})
test("a new assignment cannot replace a child that is still active", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const first = await SubagentBudget.open(input("a", 100))
      await expect(SubagentBudget.open({ ...input("a", 20), assignmentID: "overlap" })).rejects.toThrow(
        /running|active/,
      )
      expect((await SubagentBudget.read("a"))?.worker.assignmentID).toBe(first.assignmentID)
    },
  })
})

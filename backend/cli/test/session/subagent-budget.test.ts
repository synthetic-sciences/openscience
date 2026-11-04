import { describe, expect, test } from "bun:test"
import { Storage } from "../../src/storage/storage"
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
  for (const reason of ["cancelled", "deadline"] as const) {
    test(`late settlement preserves the ${reason} stop reason`, async () => {
      await using tmp = await tmpdir({ git: true })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await SubagentBudget.open(input("a"))
          await SubagentBudget.reserve("a", "accepted", 100)
          await SubagentBudget.stop("a", reason)
          await SubagentBudget.release("a")
          await SubagentBudget.settle("a", "accepted", 100)
          const worker = (await SubagentBudget.read("a"))!.worker
          expect(worker.stopReason).toBe(reason)
          expect(worker.spent).toBe(100)
          expect(worker.calls.accepted).toMatchObject({ state: "settled", consumed: 100 })
        },
      })
    })
  }
  test("a later stop cannot replace an established cancellation", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await SubagentBudget.open(input("a"))
        await SubagentBudget.stop("a", "cancelled")
        await SubagentBudget.stop("a", "deadline")
        expect((await SubagentBudget.read("a"))?.worker.stopReason).toBe("cancelled")
      },
    })
  })
  test("a late failed reservation preserves the original deadline stop", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        await SubagentBudget.open(input("a"))
        await SubagentBudget.reserve("a", "accepted", 100)
        await SubagentBudget.stop("a", "deadline")
        await expect(SubagentBudget.reserve("a", "late", 1)).rejects.toMatchObject({ reason: "deadline" })
        const state = (await SubagentBudget.read("a"))!
        expect(state.worker.stopReason).toBe("deadline")
        expect(state.worker.calls.late).toBeUndefined()
      },
    })
  })
  test("a stream timeout records the elapsed deadline before releasing the worker", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const worker = await SubagentBudget.open({ ...input("a"), deadline: Date.now() - 1 })
        const guard = await SubagentBudget.watch(
          worker,
          AbortSignal.abort(new DOMException("Stream deadline", "TimeoutError")),
        )
        await guard[Symbol.asyncDispose]()
        const state = (await SubagentBudget.read("a"))!
        expect(state.worker.stopReason).toBe("deadline")
        expect(state.worker.active).toBe(false)
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

test("bounded mode is opt-in and suggested amounts are shared defaults", () => {
  expect(SubagentBudget.Settings.parse({}).enabled).toBe(false)
  expect(SubagentBudget.settings({})).toMatchObject({
    enabled: false,
    usd: 5,
    tokens: 1000000,
    deadlineMs: 600000,
    usdIncrease: 1,
    tokenIncrease: 250000,
  })
})
test("conversation mode freezes on first admission and old pools stay bounded", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      expect(await SubagentBudget.initialize("off-root", { enabled: false })).toBe(false)
      expect(await SubagentBudget.initialize("off-root", { enabled: true, usd: 25 })).toBe(false)
      expect((await SubagentBudget.inspect("off-root"))?.limits).toEqual({ usd: 0, tokens: 0 })
      expect(await SubagentBudget.initialize("on-root", { enabled: true, tokens: 500 })).toBe(true)
      expect(await SubagentBudget.initialize("on-root", { enabled: false, tokens: 1000 })).toBe(true)
      expect((await SubagentBudget.inspect("on-root"))?.limits.tokens).toBe(500)
      await SubagentBudget.open(input("old", 100))
      expect(await SubagentBudget.initialize("root", { enabled: false })).toBe(true)
    },
  })
})

test("a nested continuation reports an exhausted ancestor even after a root increase", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await SubagentBudget.open(input("a", 150))
      await SubagentBudget.open({ ...input("b", 150), parentSessionID: "a" })
      await SubagentBudget.reserve("b", "spent", 150)
      await SubagentBudget.settle("b", "spent", 150)
      await SubagentBudget.release("b")
      await SubagentBudget.release("a")
      const before = (await SubagentBudget.snapshot("root"))!
      expect(before.available.tokens).toBe(50)
      expect(before.continuationCapacity.b).toEqual({ available: 0, ancestorLimited: true })
      await SubagentBudget.increase("root", { unit: "tokens", amount: 100, revision: before.revision, key: "increase" })
      expect((await SubagentBudget.snapshot("root"))?.continuationCapacity.b).toEqual({
        available: 0,
        ancestorLimited: true,
      })
      await expect(SubagentBudget.continuation("root", "b", "resume")).rejects.toThrow(/allowance/)
    },
  })
})

test("an inactive ancestor cannot lend returned capacity already allocated to a sibling", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await SubagentBudget.open(input("a", 150))
      await SubagentBudget.release("a")
      await SubagentBudget.open(input("sibling", 200))
      await expect(SubagentBudget.open({ ...input("b", 100), parentSessionID: "a" })).rejects.toThrow(/limit/)
      expect(SubagentBudget.available((await SubagentBudget.inspect("root"))!, "tokens", "sibling")).toBe(200)
    },
  })
})

test("an active ancestor keeps its reserved capacity across an inactive intermediate worker", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      await SubagentBudget.open(input("a", 150))
      await SubagentBudget.open({ ...input("b", 100), parentSessionID: "a" })
      await SubagentBudget.release("b")
      await SubagentBudget.open(input("sibling", 50))
      const leaf = await SubagentBudget.open({ ...input("leaf", 100), parentSessionID: "b" })
      expect(leaf.limit).toBe(100)
      await SubagentBudget.reserve("leaf", "call", 100)
      expect((await SubagentBudget.read("leaf"))?.worker.calls.call.amount).toBe(100)
    },
  })
})

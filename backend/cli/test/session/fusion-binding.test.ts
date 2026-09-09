import { describe, expect, test } from "bun:test"
import { Identifier } from "../../src/id/id"
import { Instance } from "../../src/project/instance"
import { Fusion } from "../../src/session/fusion"
import { tmpdir } from "../fixture/fixture"

const opus = { providerID: "anthropic", modelID: "claude-opus-5" }
const terra = { providerID: "openai", modelID: "gpt-5.6-terra" }

describe("Fusion binding", () => {
  test("one lead resolves to one worker, across dispatches, turns and concurrent callers", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = "ses_fusion_parent_000000000000"
        const turn1 = Identifier.ascending("message")
        const mint = () => Identifier.descending("session")

        // Two dispatches in the same assistant step contend for the binding;
        // serialization makes the second observe the first.
        const [a, b] = await Promise.all(
          [0, 1].map(() =>
            Fusion.exclusive(parent, () =>
              Fusion.resolve({ parentSessionID: parent, userMessageID: turn1, worker: terra, mint }),
            ),
          ),
        )
        expect(a.binding.workerSessionID).toBe(b.binding.workerSessionID)
        expect([a.fresh, b.fresh].sort()).toEqual([false, true])
        expect(b.binding.generation).toBe(1)
        const later = a.fresh ? b : a
        expect(later.binding.turn).toEqual({ userMessageID: turn1, handoffs: 2 })

        // A later turn keeps the worker and resets the per-turn count.
        const turn2 = Identifier.ascending("message")
        const c = await Fusion.resolve({ parentSessionID: parent, userMessageID: turn2, worker: terra, mint })
        expect(c.fresh).toBe(false)
        expect(c.binding.workerSessionID).toBe(a.binding.workerSessionID)
        expect(c.binding.turn).toEqual({ userMessageID: turn2, handoffs: 1 })

        // The record is durable: a fresh read (as after a restart) sees it.
        const stored = await Fusion.get(parent)
        expect(stored?.workerSessionID).toBe(a.binding.workerSessionID)
        expect(stored?.worker).toEqual(terra)
        expect(stored?.policy).toEqual({ version: Fusion.POLICY_VERSION, maxHandoffsPerTurn: 6 })
      },
    })
  })

  test("a different configured worker model starts a new lineage instead of re-routing the live worker", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = "ses_fusion_parent_000000000001"
        const turn = Identifier.ascending("message")
        const mint = () => Identifier.descending("session")
        const first = await Fusion.resolve({ parentSessionID: parent, userMessageID: turn, worker: terra, mint })
        const second = await Fusion.resolve({ parentSessionID: parent, userMessageID: turn, worker: opus, mint })
        expect(second.fresh).toBe(true)
        expect(second.binding.generation).toBe(2)
        expect(second.binding.workerSessionID).not.toBe(first.binding.workerSessionID)
        expect(second.binding.worker).toEqual(opus)
        // The turn budget follows the lead, not the lineage.
        expect(second.binding.turn).toEqual({ userMessageID: turn, handoffs: 2 })
      },
    })
  })

  test("the per-turn handoff budget refuses before any work is dispatched, and clears on the next turn", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = "ses_fusion_parent_000000000002"
        const turn = Identifier.ascending("message")
        const mint = () => Identifier.descending("session")
        for (let i = 0; i < 2; i++) {
          await Fusion.resolve({
            parentSessionID: parent,
            userMessageID: turn,
            worker: terra,
            maxHandoffsPerTurn: 2,
            mint,
          })
        }
        await expect(
          Fusion.resolve({ parentSessionID: parent, userMessageID: turn, worker: terra, maxHandoffsPerTurn: 2, mint }),
        ).rejects.toBeInstanceOf(Fusion.HandoffBudgetError)
        expect((await Fusion.get(parent))?.turn?.handoffs).toBe(2)

        const next = Identifier.ascending("message")
        const resumed = await Fusion.resolve({
          parentSessionID: parent,
          userMessageID: next,
          worker: terra,
          maxHandoffsPerTurn: 2,
          mint,
        })
        expect(resumed.binding.turn).toEqual({ userMessageID: next, handoffs: 1 })
      },
    })
  })

  test("settling a handoff accumulates usage once per call id and records the outcome", async () => {
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const parent = "ses_fusion_parent_000000000003"
        const turn = Identifier.ascending("message")
        await Fusion.resolve({
          parentSessionID: parent,
          userMessageID: turn,
          worker: terra,
          mint: () => Identifier.descending("session"),
        })
        const usage = { cost: 0.25, tokens: { input: 1000, output: 200, cache: { read: 300, write: 50 } } }
        await Fusion.settle({
          parentSessionID: parent,
          callID: "call_1",
          outcome: "completed",
          stopReason: "completed",
          usage,
        })
        // A replayed completion (restart recovery) must not double count.
        await Fusion.settle({
          parentSessionID: parent,
          callID: "call_1",
          outcome: "completed",
          stopReason: "completed",
          usage,
        })
        await Fusion.settle({
          parentSessionID: parent,
          callID: "call_2",
          outcome: "partial",
          stopReason: "max_steps",
          usage,
        })
        const stored = await Fusion.get(parent)
        expect(stored?.handoffs).toBe(2)
        expect(stored?.usage).toEqual({
          cost: 0.5,
          tokens: { input: 2000, output: 400, cache: { read: 600, write: 100 } },
        })
        expect(stored?.lastResult).toMatchObject({ callID: "call_2", outcome: "partial", stopReason: "max_steps" })
      },
    })
  })
})

test("removing the lead session removes its binding, and removing twice is harmless", async () => {
  await using tmp = await tmpdir()
  await Instance.provide({
    directory: tmp.path,
    fn: async () => {
      const parent = "ses_fusion_parent_000000000004"
      await Fusion.resolve({
        parentSessionID: parent,
        userMessageID: Identifier.ascending("message"),
        worker: terra,
        mint: () => Identifier.descending("session"),
      })
      expect(await Fusion.get(parent)).toBeDefined()
      await Fusion.remove(parent)
      await Fusion.remove(parent)
      expect(await Fusion.get(parent)).toBeUndefined()
    },
  })
})

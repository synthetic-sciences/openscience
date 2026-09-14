import { expect, test } from "bun:test"
import { modelContextOptions, modelDefaultContext } from "./model-context"

test("context options follow the selected route, never a universal 272k cap", () => {
  expect(modelContextOptions({ limit: { context: 500_000 }, cost: { tiers: [{ threshold: 200_000 }] } })).toEqual([
    200_000, 500_000,
  ])
  expect(modelContextOptions({ limit: { context: 1_050_000 }, cost: { tiers: [{ threshold: 272_000 }] } })).toEqual([
    272_000, 1_050_000,
  ])
  expect(modelContextOptions({ limit: { context: 1_000_000 }, cost: {} })).toEqual([1_000_000])
})

test("published managed caps override stale upstream tiers and are bounded", () => {
  expect(
    modelContextOptions({
      limit: { context: 500_000 },
      contextOptions: [200_000, 500_000, 1_000_000],
      cost: { tiers: [{ threshold: 272_000 }] },
    }),
  ).toEqual([200_000, 500_000])
  expect(
    modelContextOptions({ limit: { context: 200_000 }, contextOptions: [0, Number.NaN, 200_000], cost: {} }),
  ).toEqual([200_000])
})

test("the default cap is the first pricing boundary the route offers, else the full window", () => {
  expect(modelDefaultContext({ limit: { context: 1_050_000 }, cost: { tiers: [{ threshold: 272_000 }] } })).toBe(
    272_000,
  )
  expect(modelDefaultContext({ limit: { context: 1_000_000 }, cost: { experimentalOver200K: {} } })).toBe(200_000)
  expect(modelDefaultContext({ limit: { context: 1_000_000 }, cost: {} })).toBe(1_000_000)
  // A managed route that publishes its own caps decides which boundaries exist.
  expect(
    modelDefaultContext({
      limit: { context: 500_000 },
      contextOptions: [500_000],
      cost: { tiers: [{ threshold: 272_000 }] },
    }),
  ).toBe(500_000)
})

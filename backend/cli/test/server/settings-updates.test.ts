import { describe, expect, test } from "bun:test"
import {
  createUpdateCache,
  createUpdateInstaller,
  isNewerVersion,
  supportsAutomaticUpdate,
} from "../../src/server/routes/settings/updates"

describe("update version ordering", () => {
  test("only reports a genuinely newer release", () => {
    expect(isNewerVersion("2.0.1", "2.0.2")).toBe(true)
    expect(isNewerVersion("2.0.2", "2.0.2")).toBe(false)
    expect(isNewerVersion("2.0.2-test.58.1", "2.0.1")).toBe(false)
    expect(isNewerVersion("local", "2.0.2")).toBe(false)
  })
})

describe("automatic update support", () => {
  test("supports every installer implemented by the upgrader", () => {
    expect(
      ["curl", "npm", "pnpm", "yarn", "bun", "brew", "choco", "scoop", "desktop"].every(supportsAutomaticUpdate),
    ).toBe(true)
    expect(supportsAutomaticUpdate("unknown")).toBe(false)
  })

  test("deduplicates concurrent install requests", async () => {
    const gate = Promise.withResolvers<void>()
    const calls: string[] = []
    const install = createUpdateInstaller({
      resolve: async () => ({
        current: "2.0.47",
        latest: "2.0.49",
        channel: "latest",
        method: "npm",
        updateAvailable: true,
        releaseNotes: "https://example.com/releases",
      }),
      upgrade: async (_method, version) => {
        calls.push(version)
        await gate.promise
      },
    })

    const first = install()
    const second = install()
    await Promise.resolve()
    expect(calls).toEqual(["2.0.49"])
    gate.resolve()
    expect(await Promise.all([first, second])).toEqual([
      expect.objectContaining({ installed: true, restartRequired: true }),
      expect.objectContaining({ installed: true, restartRequired: true }),
    ])
  })
})

describe("update snapshot cache", () => {
  test("deduplicates concurrent and warm background checks", async () => {
    let calls = 0
    let time = 1_000
    const cache = createUpdateCache({
      ttl: 500,
      now: () => time,
      load: async () => ++calls,
    })

    const [first, second] = await Promise.all([cache(), cache()])
    expect([first, second]).toEqual([1, 1])
    expect(await cache()).toBe(1)
    expect(calls).toBe(1)

    time += 501
    expect(await cache()).toBe(2)
    expect(calls).toBe(2)
  })

  test("refreshes explicitly and retries failures immediately", async () => {
    let calls = 0
    const cache = createUpdateCache({
      load: async () => {
        calls++
        if (calls === 1) throw new Error("registry unavailable")
        return calls
      },
    })

    await expect(cache()).rejects.toThrow("registry unavailable")
    expect(await cache()).toBe(2)
    expect(await cache(true)).toBe(3)
  })

  test("deduplicates overlapping explicit refreshes", async () => {
    let calls = 0
    const gate = Promise.withResolvers<number>()
    const cache = createUpdateCache({
      load: () => {
        calls++
        return gate.promise
      },
    })

    const first = cache(true)
    const second = cache(true)
    expect(calls).toBe(0)
    await Promise.resolve()
    expect(calls).toBe(1)
    gate.resolve(7)
    expect(await Promise.all([first, second])).toEqual([7, 7])
  })
})

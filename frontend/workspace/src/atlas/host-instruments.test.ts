import { describe, expect, test } from "bun:test"
import { histogram, hostReading, sample, SAMPLES } from "./host-instruments"

const capacity = {
  memory: { total: 16_000_000_000, available: 13_100_000_000, compute: 500_000_000, kernels: 412_000_000 },
  cpu: { cores: 8, busy: 2.1, compute: 0.7, kernels: 0.4 },
  kernels: { live: 2, running: 1 },
  commands: { live: 1, running: 1 },
  jobs: { live: 1, running: 1 },
}

describe("host reading", () => {
  test("states live compute memory against machine capacity", () => {
    const reading = hostReading(capacity)

    expect(reading.headline).toBe("500.0 MB")
    expect(reading.memory).toBe("of 16.0 GB memory")
    expect(reading.memoryFill).toBeCloseTo(500_000_000 / 16_000_000_000, 5)
  })

  test("states busy cores against the machine count", () => {
    const reading = hostReading(capacity)

    expect(reading.cores).toBe("~0.7 of 8")
    expect(reading.cpuFill).toBeCloseTo(0.7 / 8, 5)
    expect(reading.live).toBe("4")
    expect(reading.running).toBe("3")
    expect(reading.kernels).toBe("2 kernels · 1 command · 1 job · 3 running")
  })

  test("says unavailable rather than zero for a figure the platform withheld", () => {
    const reading = hostReading({ kernels: { live: 0, running: 0 } })

    expect(reading.headline).toBe("—")
    expect(reading.memory).toBe("memory unavailable")
    expect(reading.memoryFill).toBe(0)
    expect(reading.cpuFill).toBe(0)
    expect(reading.running).toBe("0")
  })

  test("degrades only the figure a partial body left out, and never throws", () => {
    // A body that arrives without a section — a version skew, a half-written
    // response — must not take the whole strip down. Dereferencing it would
    // throw inside a memo, and the only ErrorBoundary wraps the workspace.
    const noCpu = hostReading({ memory: { total: 16_000_000_000, available: 13_100_000_000 } })
    expect(noCpu.headline).toBe("—")
    expect(noCpu.cores).toBe("—")

    const halfMemory = hostReading({ memory: { total: 16_000_000_000 } as never, cpu: { cores: 4 } })
    expect(halfMemory.headline).toBe("—")
    expect(halfMemory.memory).toBe("of 16.0 GB memory")

    const noMemory = hostReading({ cpu: { cores: 4, busy: 1, kernels: 0.25 } })
    expect(noMemory.headline).toBe("—")
    expect(noMemory.cores).toBe("~0.3 of 4")
  })

  test("treats a missing busy figure as idle rather than unavailable", () => {
    // The route omits `busy` when it could not sample the interval, but the
    // core count is still true — read 0 of 8, not blank.
    const reading = hostReading({ cpu: { cores: 8 } })

    expect(reading.cores).toBe("~0 of 8")
    expect(reading.cpuFill).toBe(0)
  })

  test("caps the segments so a many-core host stays legible", () => {
    const reading = hostReading({ cpu: { cores: 128, busy: 64, kernels: 64 } })

    // The reading still tells the truth; only the drawing is capped.
    expect(reading.cores).toBe("~64 of 128")
    expect(reading.cpuFill).toBe(0.5)
  })
})

describe("sample history", () => {
  test("appends the fraction in use and never mutates what it was given", () => {
    const before: number[] = []
    const after = sample(before, capacity)

    expect(before).toEqual([])
    expect(after).toHaveLength(1)
    expect(after[0]).toBeCloseTo(2_900_000_000 / 16_000_000_000, 5)
  })

  test("stays bounded however long the pane is left open", () => {
    let history: number[] = []
    for (let i = 0; i < SAMPLES * 5; i++) history = sample(history, capacity)

    expect(history).toHaveLength(SAMPLES)
  })

  test("records nothing at all for a poll that failed", () => {
    // Repeating the last reading would draw a flat stretch that looks like
    // measured calm; a zero would draw a cliff that never happened.
    const history = sample([0.4, 0.5], undefined)

    expect(history).toEqual([0.4, 0.5])
  })

  test("clamps a racing sample instead of overflowing the bar", () => {
    const history = sample([], { memory: { total: 1_000, available: 2_000 } })

    // available > total means the two figures were sampled either side of a
    // change; used floors at 0 rather than going negative.
    expect(history[0]).toBe(0)
  })
})

describe("histogram", () => {
  test("right-aligns a partial series so a fresh panel reads as not-yet-measured", () => {
    const bars = histogram([0.5, 0.5])

    expect(bars).toHaveLength(SAMPLES)
    // Everything before the samples is empty, not zero-height-but-present.
    expect(bars.slice(0, SAMPLES - 2).every((bar) => bar.height === 0)).toBe(true)
    expect(bars[SAMPLES - 1]?.height).toBeGreaterThan(0)
  })

  test("marks only the newest few as recent", () => {
    const bars = histogram(Array.from({ length: SAMPLES }, () => 0.5))

    expect(bars.filter((bar) => bar.recent)).toHaveLength(3)
    expect(bars[SAMPLES - 1]?.recent).toBe(true)
    expect(bars[SAMPLES - 4]?.recent).toBe(false)
  })

  test("floors a measured sample so an idle machine still reads as measurements", () => {
    // Zero-height bars would draw a blank strip, which is indistinguishable
    // from having no data at all.
    const bars = histogram([0, 0, 0])

    expect(bars[SAMPLES - 1]?.height).toBe(2)
  })

  test("scales to the height it is given", () => {
    const bars = histogram([1], 34)

    expect(bars[SAMPLES - 1]?.height).toBe(34)
  })

  test("draws nothing before the first poll resolves", () => {
    const bars = histogram([])

    expect(bars.every((bar) => bar.height === 0 && !bar.recent)).toBe(true)
  })
})

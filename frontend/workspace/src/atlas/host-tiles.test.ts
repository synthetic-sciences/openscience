import { describe, expect, test } from "bun:test"
import { hostTiles } from "./host-tiles"

const capacity = {
  memory: { total: 16_000_000_000, available: 9_300_000_000, kernels: 412_000_000 },
  cpu: { cores: 8, busy: 2.1, kernels: 0.4 },
  kernels: { live: 2, running: 1 },
}

describe("host strip tiles", () => {
  test("states free memory against total and the share kernels hold", () => {
    const [memory] = hostTiles(capacity)

    expect(memory?.value).toBe("412 MB")
    expect(memory?.caption).toBe("kernels · 9.3 GB free of 16.0 GB")
    expect(memory?.share).toBeCloseTo(412_000_000 / 16_000_000_000, 5)
    expect(memory?.fill).toBeCloseTo(6_700_000_000 / 16_000_000_000, 5)
  })

  test("states busy cores approximately, because busy is an interval average", () => {
    const [, cpu] = hostTiles(capacity)

    expect(cpu?.value).toBe("0.4 cores")
    expect(cpu?.caption).toBe("by kernels · ~2 of 8 cores busy")
    expect(cpu?.fill).toBeCloseTo(2.1 / 8, 5)
  })

  test("counts live kernels and how many are running", () => {
    const [, , kernels] = hostTiles(capacity)

    expect(kernels?.value).toBe("2")
    expect(kernels?.caption).toBe("kernels · 1 running")
  })

  test("renders Unavailable rather than zero for a figure the platform withheld", () => {
    const [memory, cpu] = hostTiles({
      memory: { total: 16_000_000_000, available: 9_300_000_000 },
      cpu: { cores: 8 },
      kernels: { live: 0, running: 0 },
    })

    expect(memory?.value).toBe("Unavailable")
    expect(cpu?.value).toBe("Unavailable")
    expect(cpu?.caption).toBe("by kernels · 8 cores")
    expect(memory?.share).toBe(0)
  })

  test("renders Unavailable across the board before the first load resolves", () => {
    const tiles = hostTiles(undefined)

    expect(tiles.map((tile) => tile.value)).toEqual(["Unavailable", "Unavailable", "Unavailable"])
    expect(tiles.every((tile) => tile.fill === 0 && tile.share === 0)).toBe(true)
  })

  test("degrades only the tiles a partial body left out, and never throws on the render path", () => {
    // The spec's other half: a body that arrives without a section — a version
    // skew, a half-written response — must read Unavailable on that tile alone.
    // Dereferencing it would throw inside HostStrip's createMemo, and the only
    // ErrorBoundary in the app wraps the whole workspace.
    const missing = hostTiles({
      memory: { total: 16_000_000_000, available: 9_300_000_000, kernels: 412_000_000 },
      cpu: { cores: 8, busy: 2.1, kernels: 0.4 },
    })

    expect(missing.map((tile) => tile.value)).toEqual(["412 MB", "0.4 cores", "Unavailable"])
    expect(missing[2]?.caption).toBe("kernels · count unavailable")

    const counted = hostTiles({ kernels: { live: 2, running: 1 } })

    expect(counted.map((tile) => tile.value)).toEqual(["Unavailable", "Unavailable", "2"])
    expect(counted[0]?.caption).toBe("kernels · capacity unavailable")
    expect(counted[1]?.caption).toBe("by kernels · capacity unavailable")
    expect(counted[2]?.caption).toBe("kernels · 1 running")
    expect(counted.every((tile) => tile.fill === 0 && tile.share === 0)).toBe(true)
  })

  test("clamps a racing sample instead of overflowing the meter", () => {
    const [memory, cpu] = hostTiles({
      memory: { total: 1_000, available: 2_000, kernels: 4_000 },
      cpu: { cores: 4, busy: 9, kernels: 9 },
      kernels: { live: 1, running: 1 },
    })

    expect(memory?.fill).toBe(0)
    expect(memory?.share).toBe(1)
    expect(cpu?.fill).toBe(1)
    expect(cpu?.share).toBe(1)
  })
})
